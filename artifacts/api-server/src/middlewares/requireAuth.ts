import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import {
  db,
  householdsTable,
  householdMembersTable,
  profilesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOwnerEmail } from "./requireOwner";

declare global {
  namespace Express {
    interface Request {
      // The signed-in Clerk userId of the actor making the request.
      // Used wherever we need to know WHO did something — owner
      // gating, /me identity, audit columns on inserts, Plaid
      // client_user_id, self-removal checks. (#623)
      actualUserId?: string;
      // Back-compat alias of `actualUserId`. The legacy route code
      // wrote `userId: req.userId` into audit columns; that
      // semantic is preserved by this alias.
      userId?: string;
      // The household this request reads/writes. Resolved from
      // `household_members.user_id = actualUserId`. Routes filter
      // shared-data tables on this column. (#623)
      householdId?: string;
      // The household owner's Clerk userId (so plaid_items inserts
      // and any other "this belongs to the owner" semantics can
      // resolve without a second DB hit). Equal to actualUserId
      // when the actor IS the owner.
      householdOwnerId?: string;
    }
  }
}

interface ResolvedHousehold {
  householdId: string;
  householdOwnerId: string;
}

// Process-local cache of resolved household per signed-in user.
// Cleared by `_resetHouseholdCacheForTests` and by member removal
// in routes/members.ts so a re-invited user picks up a new
// household without a server restart.
const householdCache = new Map<string, ResolvedHousehold>();

// Process-local cache of the owner's Clerk userId, looked up by
// matching OWNER_EMAIL against Clerk's user list. Refreshed at most
// once per minute. Single-household app: one owner.
let cachedOwnerUserId: string | null = null;
let cachedOwnerLookupAt = 0;
const OWNER_CACHE_TTL_MS = 60_000;

export function _resetHouseholdCacheForTests(): void {
  householdCache.clear();
  cachedOwnerUserId = null;
  cachedOwnerLookupAt = 0;
}

/**
 * Evict any cached household resolution for `actualUserId`. Call
 * this when a member is removed so re-invitation in the same
 * process re-resolves their membership cleanly.
 */
export function evictHouseholdCacheFor(actualUserId: string): void {
  householdCache.delete(actualUserId);
}

export function _setCachedOwnerUserIdForTests(id: string | null): void {
  cachedOwnerUserId = id;
  cachedOwnerLookupAt = id ? Date.now() : 0;
}

async function resolveOwnerUserId(): Promise<string | null> {
  const now = Date.now();
  if (cachedOwnerUserId && now - cachedOwnerLookupAt < OWNER_CACHE_TTL_MS) {
    return cachedOwnerUserId;
  }
  try {
    const list = await clerkClient.users.getUserList({
      emailAddress: [getOwnerEmail()],
      limit: 1,
    });
    const users = Array.isArray(list)
      ? list
      : (list as { data: Array<{ id: string }> }).data;
    const u = users[0];
    if (u?.id) {
      cachedOwnerUserId = u.id;
      cachedOwnerLookupAt = now;
    }
  } catch {
    // best-effort — caller falls back gracefully
  }
  return cachedOwnerUserId;
}

async function loadEmail(userId: string): Promise<string | null> {
  try {
    const u = await clerkClient.users.getUser(userId);
    const primary =
      u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ??
      u.emailAddresses[0];
    return primary?.emailAddress ?? null;
  } catch {
    return null;
  }
}

interface MinimalLogger {
  warn: (...args: unknown[]) => void;
}

/**
 * Returns true iff this email has at least one Clerk invitation in
 * `accepted` status. This is the upstream signal that an owner
 * explicitly granted household access; without it we MUST NOT add
 * the user to the owner's household. (#623)
 */
async function hasAcceptedInvitation(email: string): Promise<boolean> {
  const target = email.toLowerCase().trim();
  if (!target) return false;
  try {
    const pageSize = 100;
    const max = 1000;
    let offset = 0;
    while (offset < max) {
      const result = await clerkClient.invitations.getInvitationList({
        status: "accepted",
        orderBy: "-created_at",
        limit: pageSize,
        offset,
      });
      const page = Array.isArray(result)
        ? result
        : (result as { data: Array<{ emailAddress: string }> }).data;
      if (!page || page.length === 0) return false;
      for (const inv of page) {
        if (inv.emailAddress?.toLowerCase().trim() === target) return true;
      }
      if (page.length < pageSize) return false;
      offset += pageSize;
    }
  } catch {
    // best-effort — fall through to "no" so we under-share on failure
  }
  return false;
}

/**
 * Ensure a household row exists for `ownerUserId`, returning its
 * id. Idempotent.
 */
async function ensureHousehold(ownerUserId: string): Promise<string> {
  const [existing] = await db
    .select({ id: householdsTable.id })
    .from(householdsTable)
    .where(eq(householdsTable.ownerUserId, ownerUserId));
  if (existing) return existing.id;
  const [inserted] = await db
    .insert(householdsTable)
    .values({ ownerUserId })
    .onConflictDoNothing({ target: householdsTable.ownerUserId })
    .returning({ id: householdsTable.id });
  if (inserted) return inserted.id;
  // Lost the race; re-read.
  const [again] = await db
    .select({ id: householdsTable.id })
    .from(householdsTable)
    .where(eq(householdsTable.ownerUserId, ownerUserId));
  if (!again) throw new Error("Failed to create or fetch household");
  return again.id;
}

async function resolveHousehold(
  actualUserId: string,
  log: MinimalLogger,
): Promise<ResolvedHousehold> {
  const cached = householdCache.get(actualUserId);
  if (cached) return cached;

  // Path A: existing membership row (the durable, post-bootstrap path).
  let row: { householdId: string; ownerUserId: string } | undefined;
  try {
    const rows = await db
      .select({
        householdId: householdMembersTable.householdId,
        ownerUserId: householdsTable.ownerUserId,
      })
      .from(householdMembersTable)
      .innerJoin(
        householdsTable,
        eq(householdsTable.id, householdMembersTable.householdId),
      )
      .where(eq(householdMembersTable.userId, actualUserId));
    row = rows[0];
  } catch (e) {
    log.warn({ err: e }, "Household membership lookup failed");
  }

  if (row) {
    const resolved = {
      householdId: row.householdId,
      householdOwnerId: row.ownerUserId,
    };
    householdCache.set(actualUserId, resolved);
    return resolved;
  }

  // Path B: bootstrap. Three branches in strict order — the same
  // gating used by the previous middleware-remap implementation,
  // but now persisted as a real `household_members` row instead of
  // remapping req.userId.
  const myEmail = (await loadEmail(actualUserId))?.toLowerCase().trim();

  let ownerUserIdForHousehold = actualUserId;
  let role: "owner" | "member" = "owner";
  let invitedEmail: string | null = null;

  if (myEmail && myEmail === getOwnerEmail()) {
    // Branch 1: signed-in user IS the owner. Bootstrap their own
    // household.
    ownerUserIdForHousehold = actualUserId;
    role = "owner";
  } else if (myEmail && (await hasAcceptedInvitation(myEmail))) {
    // Branch 2: invited family member. Join the owner's household.
    const ownerId = await resolveOwnerUserId();
    if (ownerId) {
      ownerUserIdForHousehold = ownerId;
      role = "member";
      invitedEmail = myEmail;
    } else {
      // Owner not (yet) signed in — fall back to self-isolation.
      ownerUserIdForHousehold = actualUserId;
      role = "owner";
    }
  } else {
    // Branch 3: no invitation. Isolated household with no shared data.
    ownerUserIdForHousehold = actualUserId;
    role = "owner";
  }

  const householdId = await ensureHousehold(ownerUserIdForHousehold);

  // Best-effort: create the membership row. Ignore conflicts — a
  // concurrent request from the same user may have inserted first.
  try {
    await db
      .insert(householdMembersTable)
      .values({
        userId: actualUserId,
        householdId,
        role,
        invitedEmail,
      })
      .onConflictDoNothing({ target: householdMembersTable.userId });
  } catch (e) {
    log.warn({ err: e }, "Failed to persist household_members row");
  }

  // Maintain a profile row for compatibility with any code path
  // that still reads from it (e.g. owner email cache).
  try {
    await db
      .insert(profilesTable)
      .values({ id: actualUserId, email: myEmail ?? null })
      .onConflictDoUpdate({
        target: profilesTable.id,
        set: { email: myEmail ?? null },
      });
  } catch {
    // non-fatal
  }

  const resolved = {
    householdId,
    householdOwnerId: ownerUserIdForHousehold,
  };
  householdCache.set(actualUserId, resolved);
  return resolved;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  // (data-integrity fix) Key household identity on Clerk's CANONICAL stable
  // user id (`auth.userId`, the `user_…` value), NOT a custom `sessionClaims.
  // userId` claim. The old precedence (sessionClaims.userId first) let an
  // unstable/rotating claim value make the same human look like a brand-new
  // user on different sessions — and since resolveHousehold get-or-creates a
  // household + full default seed per never-before-seen id, that spawned tens
  // of thousands of phantom households (the July bloat). `auth.userId` is
  // guaranteed present + stable per Clerk account, so get-or-create is now
  // idempotent per person. Fall back to the custom claim only if auth.userId
  // is somehow absent.
  const actualUserId =
    auth?.userId ??
    (auth?.sessionClaims as unknown as { userId?: string } | undefined)
      ?.userId;
  if (!actualUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.actualUserId = actualUserId;
  // Back-compat alias used by legacy code paths that record an
  // actor on insert. Read paths now use req.householdId.
  req.userId = actualUserId;
  try {
    const h = await resolveHousehold(actualUserId, req.log);
    req.householdId = h.householdId;
    req.householdOwnerId = h.householdOwnerId;
  } catch (e) {
    req.log.warn({ err: e }, "Household resolution failed");
    res.status(500).json({ error: "Failed to resolve household" });
    return;
  }
  next();
}

// Test-only export.
export const __testing = {
  resolveHousehold,
  resolveOwnerUserId,
  ensureHousehold,
};
