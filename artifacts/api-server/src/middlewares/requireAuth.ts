import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOwnerEmail } from "./requireOwner";

declare global {
  namespace Express {
    interface Request {
      // The household-scoped data identity. For the owner this is the
      // owner's own Clerk userId; for any invited family member this
      // is REMAPPED to the owner's Clerk userId so every existing
      // route — which keys on `req.userId` — reads and writes the
      // shared household's rows. (#623)
      userId?: string;
      // The signed-in user's actual Clerk userId. Used for owner
      // gating (`requireOwner`) and member-only checks (e.g. self
      // removal in /members/:id) where we need to know WHO is making
      // the request, independent of whose data they're viewing.
      actualUserId?: string;
    }
  }
}

// Process-local cache of resolved household owner per signed-in user.
// Cleared by `_resetHouseholdCacheForTests` and by member removal
// (handled in routes/members.ts) so a re-invited user picks up a new
// household without a server restart.
const householdCache = new Map<string, string>();

// Process-local cache of the owner's Clerk userId, looked up by
// matching OWNER_EMAIL against Clerk's user list. Refreshed at most
// once per minute. Single-household app: there is exactly one owner.
let cachedOwnerUserId: string | null = null;
let cachedOwnerLookupAt = 0;
const OWNER_CACHE_TTL_MS = 60_000;

export function _resetHouseholdCacheForTests(): void {
  householdCache.clear();
  cachedOwnerUserId = null;
  cachedOwnerLookupAt = 0;
}

/**
 * Evict any cached household resolution for `actualUserId`. Call this
 * when a member is removed so that if the same person is re-invited in
 * the same process lifetime, the next sign-in re-resolves their
 * household from the (now updated) profile row instead of serving the
 * stale in-memory mapping.
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
    // best-effort — falls back to remap=self below
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

async function resolveHouseholdOwnerId(
  actualUserId: string,
  log: MinimalLogger,
): Promise<string> {
  const cached = householdCache.get(actualUserId);
  if (cached) return cached;

  let householdOwnerId: string | null = null;
  try {
    const [row] = await db
      .select({ householdOwnerId: profilesTable.householdOwnerId })
      .from(profilesTable)
      .where(eq(profilesTable.id, actualUserId));
    householdOwnerId = row?.householdOwnerId ?? null;
  } catch (e) {
    log.warn({ err: e }, "Failed to read profile for household resolution");
  }

  if (!householdOwnerId) {
    // First-time resolution. Decide via email:
    //   - If the signed-in user IS the owner (email matches OWNER_EMAIL),
    //     household = self.
    //   - Otherwise resolve the single owner of this app via Clerk and
    //     map to their Clerk id. If the owner can't be located (e.g.
    //     transient Clerk failure), fall back to self so the user keeps
    //     seeing only their own data — better to under-share than to
    //     leak the owner's data to the wrong account.
    const myEmail = (await loadEmail(actualUserId))?.toLowerCase().trim();
    if (myEmail && myEmail === getOwnerEmail()) {
      householdOwnerId = actualUserId;
    } else {
      const ownerId = await resolveOwnerUserId();
      householdOwnerId = ownerId ?? actualUserId;
    }
    try {
      await db
        .insert(profilesTable)
        .values({ id: actualUserId, householdOwnerId })
        .onConflictDoUpdate({
          target: profilesTable.id,
          set: { householdOwnerId },
        });
    } catch (e) {
      log.warn({ err: e }, "Failed to persist householdOwnerId");
    }
  }

  householdCache.set(actualUserId, householdOwnerId);
  return householdOwnerId;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const actualUserId =
    (auth?.sessionClaims as { userId?: string } | undefined)?.userId ??
    auth?.userId;
  if (!actualUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.actualUserId = actualUserId;
  try {
    req.userId = await resolveHouseholdOwnerId(actualUserId, req.log);
  } catch (e) {
    req.log.warn({ err: e }, "Household resolution failed; falling back to self");
    req.userId = actualUserId;
  }
  next();
}

// Test-only export: lets requireAuth.test.ts evict cache without
// reaching into module internals.
export const __testing = {
  resolveHouseholdOwnerId,
  resolveOwnerUserId,
};
