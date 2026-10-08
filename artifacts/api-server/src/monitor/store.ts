import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db, agentFindingsTable, type AgentFinding } from "@workspace/db";
import { SEVERITY_RANK, type Finding, type FindingKind, type FindingSeverity } from "./types";

// (AI-3) The findings ledger's rules, in one place.
//
//   no row            insert                              -> NEW
//   unresolved row    bump last_seen (+ fresh figures)    -> not new
//   resolved row      re-fire only if the severity rose, or it was resolved
//                     more than 7 days ago                -> NEW when it does
//   not seen this run an unresolved finding the detectors no longer produce
//                     is resolved (the thing it noticed has cleared)
//
// The cooldown is what keeps a flapping condition (resolved by the owner, or
// cleared and back) from re-alerting every night.

export const REFIRE_AFTER_MS = 7 * 24 * 3600 * 1000;

export type FindingDecision = "insert" | "bump" | "refire" | "skip";

export function decideFinding(
  existing: { severity: string; resolvedAt: Date | null } | undefined,
  finding: Pick<Finding, "severity">,
  nowMs: number,
): FindingDecision {
  if (!existing) return "insert";
  if (!existing.resolvedAt) return "bump";
  const rose = SEVERITY_RANK[finding.severity] > (SEVERITY_RANK[existing.severity as FindingSeverity] ?? 0);
  if (rose || nowMs - existing.resolvedAt.getTime() > REFIRE_AFTER_MS) return "refire";
  return "skip";
}

export interface UpsertResult {
  /** Findings the detectors produced this run. */
  detected: number;
  /** Rows created or re-fired: these get an Activity row. */
  created: AgentFinding[];
  /** Unresolved findings this run closed because their cause cleared. */
  autoResolved: number;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function upsertFindings(
  tx: Tx,
  householdId: string,
  findings: Finding[],
  ranKinds: ReadonlyArray<FindingKind>,
  now: Date,
): Promise<UpsertResult> {
  const created: AgentFinding[] = [];
  const keys = [...new Set(findings.map((f) => f.dedupeKey))];
  const existingRows = keys.length
    ? await tx
        .select()
        .from(agentFindingsTable)
        .where(and(eq(agentFindingsTable.householdId, householdId), inArray(agentFindingsTable.dedupeKey, keys)))
    : [];
  const existing = new Map(existingRows.map((r) => [r.dedupeKey, r]));

  for (const f of findings) {
    const row = existing.get(f.dedupeKey);
    const decision = decideFinding(row, f, now.getTime());
    if (decision === "insert") {
      const [made] = await tx
        .insert(agentFindingsTable)
        .values({
          householdId,
          kind: f.kind,
          dedupeKey: f.dedupeKey,
          severity: f.severity,
          confidence: f.confidence,
          payload: f.payload,
          firstSeen: now,
          lastSeen: now,
        })
        .onConflictDoNothing({ target: [agentFindingsTable.householdId, agentFindingsTable.dedupeKey] })
        .returning();
      if (made) created.push(made);
    } else if (decision === "bump") {
      await tx
        .update(agentFindingsTable)
        .set({
          lastSeen: now,
          payload: f.payload,
          confidence: f.confidence,
          // A severity that rises is kept; one that falls is not shown as an all-clear.
          severity: SEVERITY_RANK[f.severity] > SEVERITY_RANK[row!.severity as FindingSeverity] ? f.severity : row!.severity,
        })
        .where(eq(agentFindingsTable.id, row!.id));
    } else if (decision === "refire") {
      const [again] = await tx
        .update(agentFindingsTable)
        .set({
          severity: f.severity,
          confidence: f.confidence,
          payload: f.payload,
          firstSeen: now,
          lastSeen: now,
          resolvedAt: null,
          dismissedAt: null,
        })
        .where(eq(agentFindingsTable.id, row!.id))
        .returning();
      if (again) created.push(again);
    }
  }

  // What the detectors no longer produce has cleared.
  const clearable = and(
    eq(agentFindingsTable.householdId, householdId),
    isNull(agentFindingsTable.resolvedAt),
    inArray(agentFindingsTable.kind, [...ranKinds]),
    keys.length ? notInArray(agentFindingsTable.dedupeKey, keys) : sql`true`,
  );
  const closed = await tx
    .update(agentFindingsTable)
    .set({ resolvedAt: now })
    .where(clearable)
    .returning({ id: agentFindingsTable.id });

  return { detected: findings.length, created, autoResolved: closed.length };
}
