import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { agentMemoryTable, db, type AgentMemory } from "@workspace/db";

// (AI-2) The household's kept preferences and decisions ("agent_memory").
//
// ⚠️ READ ONLY BY THE AGENT'S TOOLS AND /memory. No money figure is computed
// from a memory row: moneyPosition, forecastLedger, cashSignal, spendingFacts,
// budgetActuals and avalanche-core never import this module, directly or
// through anything they import (memoryImportLaw.test.ts walks the graph).

export const MEMORY_SCOPES = ["categorization", "spending", "debt", "general"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MEMORY_KEY_MAX = 60;
export const MEMORY_VALUE_MAX = 300;
/** A household keeps at most this many live memories (the agent cannot flood it). */
export const MEMORY_LIVE_MAX = 100;

export interface MemoryView {
  id: string;
  scope: string;
  key: string;
  value: unknown;
  source: string;
  createdByKind: string;
  memberUserId: string | null;
  updatedAt: string;
}

export function memoryView(m: AgentMemory): MemoryView {
  return {
    id: m.id,
    scope: m.scope,
    key: m.key,
    value: m.value,
    source: m.source,
    createdByKind: m.createdByKind,
    memberUserId: m.memberUserId,
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function cleanKey(raw: string): string | null {
  const k = raw.trim().replace(/\s+/g, " ");
  return k.length >= 1 && k.length <= MEMORY_KEY_MAX ? k : null;
}

/** Live (not revoked) memories visible to a member: the household's own and theirs. */
export async function listMemory(householdId: string, memberUserId: string | null, limit = 100): Promise<AgentMemory[]> {
  return db
    .select()
    .from(agentMemoryTable)
    .where(
      and(
        eq(agentMemoryTable.householdId, householdId),
        isNull(agentMemoryTable.revokedAt),
        memberUserId
          ? sql`(${agentMemoryTable.memberUserId} is null or ${agentMemoryTable.memberUserId} = ${memberUserId})`
          : isNull(agentMemoryTable.memberUserId),
      ),
    )
    .orderBy(asc(agentMemoryTable.scope), asc(agentMemoryTable.key))
    .limit(limit);
}

async function liveCount(householdId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentMemoryTable)
    .where(and(eq(agentMemoryTable.householdId, householdId), isNull(agentMemoryTable.revokedAt)));
  return r?.n ?? 0;
}

export type UpsertMemoryResult =
  | { ok: true; memory: AgentMemory; created: boolean }
  | { ok: false; error: "already_set_by_user" | "memory_full" };

/**
 * A person states a preference: `user_stated`, household-wide unless
 * `memberUserId` is given. Replaces whatever the key held, an agent's note
 * included, and un-revokes a deleted key.
 */
export async function upsertUserMemory(
  householdId: string,
  actorUserId: string,
  input: { scope: MemoryScope; key: string; value: unknown; memberUserId?: string | null },
): Promise<UpsertMemoryResult> {
  const member = input.memberUserId ?? null;
  const existing = await findByKey(householdId, member, input.scope, input.key);
  if (!existing && (await liveCount(householdId)) >= MEMORY_LIVE_MAX) return { ok: false, error: "memory_full" };
  const [row] = await db.execute<AgentMemory>(sql`
    insert into agent_memory (household_id, member_user_id, scope, key, value, source, created_by_kind, created_by_user_id)
    values (${householdId}, ${member}, ${input.scope}, ${input.key}, ${JSON.stringify(input.value)}::jsonb, 'user_stated', 'user', ${actorUserId})
    on conflict (household_id, (coalesce(member_user_id, '')), scope, key) do update
      set value = excluded.value, source = 'user_stated', created_by_kind = 'user',
          created_by_user_id = excluded.created_by_user_id, updated_at = now(), revoked_at = null
    returning *`).then((r) => r.rows as AgentMemory[]);
  const fresh = await findByKey(householdId, member, input.scope, input.key);
  return { ok: true, memory: fresh ?? row!, created: !existing };
}

/**
 * The agent notes something (`agent_proposed`). It never overwrites what a
 * person stated; it can refresh its own note.
 */
export async function upsertAgentMemory(
  householdId: string,
  actorUserId: string,
  input: { scope: MemoryScope; key: string; value: unknown; evidenceTxnIds?: string[] },
): Promise<UpsertMemoryResult> {
  const existing = await findByKey(householdId, null, input.scope, input.key);
  if (existing && !existing.revokedAt && existing.source === "user_stated") return { ok: false, error: "already_set_by_user" };
  if ((!existing || existing.revokedAt) && (await liveCount(householdId)) >= MEMORY_LIVE_MAX) return { ok: false, error: "memory_full" };
  if (existing) {
    const [row] = await db
      .update(agentMemoryTable)
      .set({ value: input.value, source: "agent_proposed", createdByKind: "agent", createdByUserId: actorUserId, updatedAt: new Date(), revokedAt: null })
      .where(and(eq(agentMemoryTable.id, existing.id), eq(agentMemoryTable.householdId, householdId)))
      .returning();
    return { ok: true, memory: row!, created: false };
  }
  const [row] = await db
    .insert(agentMemoryTable)
    .values({
      householdId,
      memberUserId: null,
      scope: input.scope,
      key: input.key,
      value: input.value,
      source: "agent_proposed",
      createdByKind: "agent",
      createdByUserId: actorUserId,
      evidenceTxnIds: input.evidenceTxnIds ?? [],
    })
    .returning();
  return { ok: true, memory: row!, created: true };
}

async function findByKey(householdId: string, member: string | null, scope: string, key: string): Promise<AgentMemory | undefined> {
  const [row] = await db
    .select()
    .from(agentMemoryTable)
    .where(
      and(
        eq(agentMemoryTable.householdId, householdId),
        sql`coalesce(${agentMemoryTable.memberUserId}, '') = ${member ?? ""}`,
        eq(agentMemoryTable.scope, scope),
        eq(agentMemoryTable.key, key),
      ),
    );
  return row;
}

/** Soft delete: the row stays for the trail, out of every list and every prompt. */
export async function revokeMemory(householdId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(agentMemoryTable)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentMemoryTable.id, id), eq(agentMemoryTable.householdId, householdId), isNull(agentMemoryTable.revokedAt)))
    .returning({ id: agentMemoryTable.id });
  return rows.length > 0;
}
