/**
 * Grandfather backfill helpers for `transactions.sent_to_review_at`
 * (task #763 — follow-up to Phase B #762).
 *
 * The two grandfather rules and the 30-day "bake window" rationale are
 * documented in detail on the script wrapper at
 * `artifacts/api-server/scripts/backfill-sent-to-review-grandfather.ts`.
 *
 * Splitting the SELECT/UPDATE primitives into this library file (instead
 * of keeping them only in `scripts/`) is what lets the integration test
 * import them without crossing the `src/` rootDir boundary.
 */

import { sql } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";

export const GRANDFATHER_STALE_DAYS = 30;

export interface BackfillCounts {
  rule1: number;
  rule2: number;
  total: number;
  perHousehold: { householdId: string | null; rule1: number; rule2: number }[];
}

export interface BackfillResult {
  rule1Updated: number;
  rule2Updated: number;
  total: number;
}

const RULE1_PREDICATE = sql`
  ${transactionsTable.sentToReviewAt} IS NULL
  AND EXISTS (
    SELECT 1 FROM forecast_resolutions fr
    WHERE fr.matched_txn_id = ${transactionsTable.id}
      AND fr.status IN ('matched', 'missed', 'dismissed', 'rescheduled')
  )
`;

const RULE2_PREDICATE = sql`
  ${transactionsTable.sentToReviewAt} IS NULL
  AND ${transactionsTable.occurredOn} < (CURRENT_DATE - ${GRANDFATHER_STALE_DAYS}::int)
  AND NOT EXISTS (
    SELECT 1 FROM forecast_resolutions fr
    WHERE fr.matched_txn_id = ${transactionsTable.id}
      AND fr.status IN ('matched', 'missed', 'dismissed', 'rescheduled')
  )
`;

export async function countGrandfatherCandidates(): Promise<BackfillCounts> {
  const rule1Rows = (await db.execute(sql`
    SELECT household_id::text AS household_id, COUNT(*)::int AS n
      FROM transactions
     WHERE ${RULE1_PREDICATE}
     GROUP BY household_id
  `)) as unknown as { rows: { household_id: string | null; n: number }[] };
  const rule2Rows = (await db.execute(sql`
    SELECT household_id::text AS household_id, COUNT(*)::int AS n
      FROM transactions
     WHERE ${RULE2_PREDICATE}
     GROUP BY household_id
  `)) as unknown as { rows: { household_id: string | null; n: number }[] };

  const per = new Map<string | null, { rule1: number; rule2: number }>();
  for (const r of rule1Rows.rows) {
    const key = r.household_id ?? null;
    const cur = per.get(key) ?? { rule1: 0, rule2: 0 };
    cur.rule1 += Number(r.n);
    per.set(key, cur);
  }
  for (const r of rule2Rows.rows) {
    const key = r.household_id ?? null;
    const cur = per.get(key) ?? { rule1: 0, rule2: 0 };
    cur.rule2 += Number(r.n);
    per.set(key, cur);
  }
  const perHousehold = Array.from(per.entries()).map(
    ([householdId, v]) => ({ householdId, ...v }),
  );
  const rule1 = perHousehold.reduce((a, b) => a + b.rule1, 0);
  const rule2 = perHousehold.reduce((a, b) => a + b.rule2, 0);
  return { rule1, rule2, total: rule1 + rule2, perHousehold };
}

/**
 * Apply the two grandfather rules in a single transaction. Idempotent:
 * the `sent_to_review_at IS NULL` gate in each predicate means re-runs
 * never overwrite an existing timestamp.
 */
export async function applyGrandfatherBackfill(): Promise<BackfillResult> {
  return await db.transaction(async (tx) => {
    const rule1Res = (await tx.execute(sql`
      UPDATE transactions
         SET sent_to_review_at = NOW()
       WHERE ${RULE1_PREDICATE}
      RETURNING id
    `)) as unknown as { rows: { id: string }[] };
    const rule2Res = (await tx.execute(sql`
      UPDATE transactions
         SET sent_to_review_at = NOW()
       WHERE ${RULE2_PREDICATE}
      RETURNING id
    `)) as unknown as { rows: { id: string }[] };
    const rule1Updated = rule1Res.rows.length;
    const rule2Updated = rule2Res.rows.length;
    return {
      rule1Updated,
      rule2Updated,
      total: rule1Updated + rule2Updated,
    };
  });
}
