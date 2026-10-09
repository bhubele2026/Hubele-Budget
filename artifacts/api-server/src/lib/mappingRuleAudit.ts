// (WP5b) THE MAPPING-RULE AUDIT TRAIL.
//
// A mapping rule decides where every matching charge is filed. Until this
// package a rule could be re-pointed, reordered or deleted without a trace —
// root cause 6 of the financial-consistency plan: the seeded payroll rule was
// most likely re-pointed to Dining by the old hand-filing flow, and nothing in
// the database could say when, by what, or from where.
//
// The law: EVERY write to `mapping_rules` records one `mapping_rule_history`
// row per rule it changed, through `recordRuleChange(s)`, in the SAME
// transaction as the write. The writers today:
//
//   routes/mapping.ts        POST (created) · PATCH (updated, stamps
//                            updated_at) · DELETE (deleted) · PUT /reorder
//                            (reordered, one row per rule whose priority moved)
//   routes/budget.ts         the seed loop (seeded, actor 'seed') and the
//                            legacy category merge (updated, actor 'system')
//   routes/transactions.ts   recategorize-by-pattern's `ruleId` re-point
//   lib/workbookImporter.ts  the wipe (deleted) and the re-insert (created)
//   lib/importSnapshot.ts    a snapshot restore, as the difference it makes
//   scripts/src/recategorize.ts  through lib/db's `upsertMappingRule`
//
// `mappingRuleHistory.integration.test.ts` drives each of them.
//
// What counts as an EDIT (stamps `mapping_rules.updated_at`): a change to the
// rule's pattern, match type, category or priority made to that rule directly.
// A reorder is a list operation: it is recorded, but it does not stamp
// `updated_at`, or one drag would mark every rule on the page "edited".
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  mappingRuleHistoryTable,
  type MappingRuleHistoryAction,
  type MappingRuleSnapshot,
} from "@workspace/db";

/** The pool or an open transaction — both write the same way. */
type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who changed a rule, when it was not a person (a person = their user id). */
export const SEED_ACTOR = "seed";
export const SYSTEM_ACTOR = "system";
export function scriptActor(name: string): string {
  return `script:${name}`;
}

/** A note longer than this is cut (the spec's `maxLength`). */
export const RULE_NOTE_MAX = 500;

export function cleanRuleNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed.slice(0, RULE_NOTE_MAX) : null;
}

/** The four fields that decide what a rule does, as the history stores them. */
export function ruleSnapshot(row: {
  pattern: string;
  matchType: string;
  categoryId: string | null;
  priority: number;
}): MappingRuleSnapshot {
  return {
    pattern: row.pattern,
    matchType: row.matchType,
    categoryId: row.categoryId ?? null,
    priority: row.priority,
  };
}

export function sameRule(a: MappingRuleSnapshot, b: MappingRuleSnapshot): boolean {
  return (
    a.pattern === b.pattern &&
    a.matchType === b.matchType &&
    a.categoryId === b.categoryId &&
    a.priority === b.priority
  );
}

export interface RuleChange {
  householdId: string;
  ruleId: string;
  action: MappingRuleHistoryAction;
  /** A user id, SEED_ACTOR, SYSTEM_ACTOR or scriptActor(name). */
  actor: string;
  /** Null exactly when the rule did not exist before (created, seeded). */
  previous: MappingRuleSnapshot | null;
  /** Null exactly when the rule no longer exists (deleted). */
  next: MappingRuleSnapshot | null;
  note?: string | null;
}

/**
 * A change whose before/after does not fit its action is a bug in the caller,
 * never something to store: a "created" with a previous state, a "deleted"
 * with a next one, an edit with either side missing.
 */
function assertShape(c: RuleChange): void {
  const creates = c.action === "created" || c.action === "seeded";
  const ok =
    c.action === "deleted"
      ? c.previous !== null && c.next === null
      : creates
        ? c.previous === null && c.next !== null
        : c.previous !== null && c.next !== null;
  if (!ok) {
    throw new Error(
      `mapping rule history: a "${c.action}" change needs ${
        c.action === "deleted"
          ? "a previous state and no next state"
          : creates
            ? "a next state and no previous state"
            : "both a previous and a next state"
      } (rule ${c.ruleId})`,
    );
  }
  if (!c.actor) throw new Error(`mapping rule history: no actor (rule ${c.ruleId})`);
}

/** Record several rule changes (one row each), in the caller's transaction. */
export async function recordRuleChanges(
  exec: Exec,
  changes: readonly RuleChange[],
): Promise<void> {
  for (const c of changes) assertShape(c);
  for (let i = 0; i < changes.length; i += 500) {
    const chunk = changes.slice(i, i + 500);
    if (chunk.length === 0) continue;
    await exec.insert(mappingRuleHistoryTable).values(
      chunk.map((c) => ({
        householdId: c.householdId,
        ruleId: c.ruleId,
        action: c.action,
        actor: c.actor,
        previous: c.previous,
        next: c.next,
        note: cleanRuleNote(c.note),
      })),
    );
  }
}

/** Record one rule change, in the caller's transaction. */
export async function recordRuleChange(exec: Exec, change: RuleChange): Promise<void> {
  await recordRuleChanges(exec, [change]);
}

// ── Reading it back (GET /mapping-rules/:id/history) ──────────────────────

/** The newest this many changes are returned; `truncated` says when there were more. */
export const RULE_HISTORY_LIMIT = 100;

export type RuleActorKind = "person" | "seed" | "script" | "system";

export function actorKindOf(actor: string): RuleActorKind {
  if (actor === SEED_ACTOR) return "seed";
  if (actor === SYSTEM_ACTOR) return "system";
  if (actor.startsWith("script:")) return "script";
  return "person";
}

export interface RuleHistoryEntry {
  id: string;
  ruleId: string;
  action: MappingRuleHistoryAction;
  actor: string;
  actorKind: RuleActorKind;
  byYou: boolean;
  previous: MappingRuleSnapshot | null;
  next: MappingRuleSnapshot | null;
  note: string | null;
  createdAt: string;
}

/**
 * A rule's history in this household, newest first. A deleted rule keeps its
 * history, so this answers for ids that no longer exist; an id from another
 * household simply has none here.
 */
export async function listRuleHistory(
  householdId: string,
  ruleId: string,
  viewerUserId: string,
): Promise<{ ruleId: string; entries: RuleHistoryEntry[]; truncated: boolean }> {
  const rows = await db
    .select()
    .from(mappingRuleHistoryTable)
    .where(
      and(
        eq(mappingRuleHistoryTable.householdId, householdId),
        eq(mappingRuleHistoryTable.ruleId, ruleId),
      ),
    )
    .orderBy(desc(mappingRuleHistoryTable.createdAt), desc(mappingRuleHistoryTable.id))
    .limit(RULE_HISTORY_LIMIT + 1);
  return {
    ruleId,
    entries: rows.slice(0, RULE_HISTORY_LIMIT).map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      action: r.action,
      actor: r.actor,
      actorKind: actorKindOf(r.actor),
      byYou: r.actor === viewerUserId,
      previous: r.previous ?? null,
      next: r.next ?? null,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    })),
    truncated: rows.length > RULE_HISTORY_LIMIT,
  };
}
