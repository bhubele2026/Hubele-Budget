import { and, eq, inArray, ne } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, householdMembersTable, whatsNewReadsTable } from "@workspace/db";
import { householdDateOf } from "@workspace/avalanche-core/householdTime";
import { READ_CLICK_FROM, WHATS_NEW, isKnownUpdateId, startFor } from "@workspace/avalanche-core/whatsNew";

/**
 * ⭐ (WN) WHAT'S NEW: WHO HAS PRESSED "I'VE READ THIS" (owner, 2026-10-15).
 *
 * The household's sheet stays in front of each person until they press it, and
 * the press is recorded HERE, per person, in `whats_new_reads` — never in the
 * browser — so it holds on every device, and the owner sees "Read by <name> on
 * <day>" or "Not read yet" under each note. The notes and their ids live in
 * `@workspace/avalanche-core/whatsNew`; only ids it ships are ever recorded.
 *
 * Moves no money and no figure: the route's POST is not a money write.
 */

/** The household day an instant falls on, or null. */
function dayOf(at: Date | null | undefined): string | null {
  return at ? householdDateOf(at) : null;
}

/** This person's reads (known notes only) and where their click starts. */
export async function whatsNewFor(userId: string): Promise<{ read: string[]; from: string }> {
  const [rows, member] = await Promise.all([
    db
      .select({ updateId: whatsNewReadsTable.updateId })
      .from(whatsNewReadsTable)
      .where(eq(whatsNewReadsTable.userId, userId)),
    db
      .select({ joinedAt: householdMembersTable.joinedAt })
      .from(householdMembersTable)
      .where(eq(householdMembersTable.userId, userId))
      .limit(1),
  ]);
  return {
    read: rows.map((r) => r.updateId).filter(isKnownUpdateId).sort().reverse(),
    from: startFor(dayOf(member[0]?.joinedAt)),
  };
}

/**
 * Record "I've read this". Ids H2 does not ship are dropped (an older bundle
 * must never fail here); a repeat inserts nothing and keeps the first read_at.
 * Returns the known ids, now all recorded for this person.
 */
export async function recordWhatsNewReads(userId: string, householdId: string, ids: readonly string[]): Promise<string[]> {
  const known = [...new Set(ids)].filter(isKnownUpdateId);
  if (known.length === 0) return [];
  await db
    .insert(whatsNewReadsTable)
    .values(known.map((updateId) => ({ userId, householdId, updateId })))
    .onConflictDoNothing({ target: [whatsNewReadsTable.userId, whatsNewReadsTable.updateId] });
  return known;
}

// ── Names (Clerk's firstName: CLAUDE.md's one source of a person's name) ──

const FALLBACK_NAME = "Household member";
const NAME_TTL_MS = 10 * 60_000;
const nameCache = new Map<string, { name: string; at: number }>();

export function _resetWhatsNewNamesForTests(): void {
  nameCache.clear();
}

type ClerkUserLite = { id: string; firstName?: string | null; username?: string | null };

/**
 * First names for these Clerk ids: firstName, else username, else "Household
 * member". Never an email. Kept 10 minutes in this process; a Clerk failure
 * falls back quietly (and is not kept, so the next report asks again).
 */
export async function firstNamesOf(userIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of userIds) {
    const hit = nameCache.get(id);
    if (hit && now - hit.at < NAME_TTL_MS) out.set(id, hit.name);
    else missing.push(id);
  }
  if (missing.length > 0) {
    try {
      const result = await clerkClient.users.getUserList({ userId: missing, limit: missing.length });
      const users = (Array.isArray(result) ? result : (result as { data: ClerkUserLite[] }).data) as ClerkUserLite[];
      for (const u of users) {
        const name = u.firstName?.trim() || u.username?.trim() || FALLBACK_NAME;
        nameCache.set(u.id, { name, at: now });
        out.set(u.id, name);
      }
    } catch {
      /* Clerk unreachable: "Household member" below, asked again next time */
    }
  }
  for (const id of userIds) if (!out.has(id)) out.set(id, FALLBACK_NAME);
  return out;
}

export interface WhatsNewReadReport {
  updates: Array<{ id: string; readers: Array<{ userId: string; name: string; readAt: string | null }> }>;
}

/**
 * The owner's report: for every must-read note (newest first), each OTHER
 * person in this household whose start is on or before the note's day, and
 * when they pressed "I've read this". Reads come from this household only; a
 * removed member (no household_members row) is simply not listed.
 */
export async function whatsNewReadReport(householdId: string, ownerUserId: string): Promise<WhatsNewReadReport> {
  const members = await db
    .select({ userId: householdMembersTable.userId, joinedAt: householdMembersTable.joinedAt })
    .from(householdMembersTable)
    .where(and(eq(householdMembersTable.householdId, householdId), ne(householdMembersTable.userId, ownerUserId)));
  const notes = WHATS_NEW.filter((u) => u.id >= READ_CLICK_FROM);
  if (members.length === 0) return { updates: notes.map((u) => ({ id: u.id, readers: [] })) };

  const ids = members.map((m) => m.userId);
  const [reads, names] = await Promise.all([
    db
      .select({ userId: whatsNewReadsTable.userId, updateId: whatsNewReadsTable.updateId, readAt: whatsNewReadsTable.readAt })
      .from(whatsNewReadsTable)
      .where(and(eq(whatsNewReadsTable.householdId, householdId), inArray(whatsNewReadsTable.userId, ids))),
    firstNamesOf(ids),
  ]);
  const readAt = new Map(reads.map((r) => [`${r.userId}\u0000${r.updateId}`, r.readAt.toISOString()]));
  const people = members
    .map((m) => ({ userId: m.userId, name: names.get(m.userId) ?? FALLBACK_NAME, from: startFor(dayOf(m.joinedAt)) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));

  return {
    updates: notes.map((u) => ({
      id: u.id,
      readers: people
        .filter((p) => u.id >= p.from)
        .map((p) => ({ userId: p.userId, name: p.name, readAt: readAt.get(`${p.userId}\u0000${u.id}`) ?? null })),
    })),
  };
}
