// (PR7b) A pending charge its posted row replaced is not spending twice.
//
// PR4c's `pairPendingWithPosted` decides which pending rows a posted row
// replaced when the sync never linked them. The cash ledger drops those rows;
// this module gives the spending readers (`buildSpendingFacts`,
// `buildBehaviorFacts`, the Amex weekly payoff) the same answer, so a pending
// $45.00 and its posted $47.40 count $47.40, not $92.40.

import { and, eq, gt, gte, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, transactionsTable } from "@workspace/db";
import {
  pairPendingWithPostedAmong,
  SUPERSEDE_MAX_DAYS,
  type SupersedeRow,
} from "@workspace/avalanche-core";

export type SupersededPending = {
  /** Pending rows a posted row replaced. */
  replacedIds: Set<string>;
  /** Candidate (pending, posted) pairs the query returned. */
  candidatePairs: number;
  /** Distinct rows those pairs name: what the pairing actually read. */
  rowsRead: number;
};

/**
 * ⭐ THE PENDING ROWS A POSTED ROW REPLACED — the same answer as running
 * `pairPendingWithPosted` over the household's WHOLE ledger, without reading it.
 *
 * ⚠️ WHY THE WHOLE LEDGER'S ANSWER, NOT THE WINDOW'S. Pairing is one to one and
 * posted rows pick in date order, each taking the OLDEST qualifying pending row.
 * Which pending row a posted row replaces can therefore depend on rows outside
 * any window, through a chain 7 days at a time. Pairing a window's rows (or the
 * window plus 7 days) gives a window-dependent answer, and adjacent weeks stop
 * adding up to the fortnight. See the PR7b review note, Deviation 1.
 *
 * HOW IT STAYS BOUNDED (PR7b review M1).
 *   1. One query joins each pending row to the posted rows that COULD replace
 *      it. The join tests only conditions `canSupersede` also requires, loosened
 *      where SQL and JS round differently, so it returns every real candidate
 *      and possibly a few more:
 *        same household and Plaid account; the posted row not pending, dated on
 *        the pending day to SUPERSEDE_MAX_DAYS after, created after it; same
 *        non-zero sign; |pending| ≤ |posted| ≤ 1.30 × |pending| + $1.01
 *        (`canSupersede` allows + $1.00 after rounding to cents).
 *      Descriptions are left to `canSupersede`. (An exact-day form of the date
 *      condition via `generate_series` was measured and planned worse.) A posted row with no candidate
 *      pending row can take nothing, and a pending row no posted row can take is
 *      never taken, so neither can change any pair: leaving them out changes
 *      nothing.
 *   2. `pairPendingWithPostedAmong` — PR4c's pairing loop, shared with
 *      `pairPendingWithPosted` — offers each posted row only its candidates.
 *      The candidates are complete (every pending row `canSupersede` would
 *      accept is among them), which is exactly the condition under which it
 *      returns what `pairPendingWithPosted` returns. Work is proportional to
 *      the candidate pairs, not pending rows × posted rows.
 * The result equals the whole-ledger pairing exactly;
 * `supersededPending.integration.test.ts` checks it against a whole-ledger run
 * on a randomized ledger and on the order-sensitive fixtures.
 *
 * Cost: one query. What it reads is bounded by pending rows and the posted
 * rows near them in date AND amount, not by the size of the ledger. A
 * household with a pending row every day, on every card, at every price reads
 * most of its recent posted rows; that is the rows that can pair, not a
 * shortcut. Without an index on (household_id, plaid_account_id, occurred_on)
 * the planner still walks the household's rows to find them; that index is
 * proposed in the note and needs Brad's go (DDL).
 */
export async function findSupersededPending(householdId: string): Promise<SupersededPending> {
  const candidates = await supersedeCandidatesQuery(householdId);
  return pairCandidates(candidates);
}

/** Step 1: every (pending, posted) pair that could supersede — see above. */
export function supersedeCandidatesQuery(householdId: string) {
  const pendingRow = alias(transactionsTable, "pending_row");
  const postedRow = alias(transactionsTable, "posted_row");
  return db
    .select({
      pId: pendingRow.id,
      pAccount: pendingRow.plaidAccountId,
      pOn: pendingRow.occurredOn,
      pAmount: pendingRow.amount,
      pDescription: pendingRow.description,
      pCreatedAt: pendingRow.createdAt,
      qId: postedRow.id,
      qAccount: postedRow.plaidAccountId,
      qOn: postedRow.occurredOn,
      qAmount: postedRow.amount,
      qDescription: postedRow.description,
      qCreatedAt: postedRow.createdAt,
    })
    .from(pendingRow)
    .innerJoin(
      postedRow,
      and(
        eq(postedRow.householdId, householdId),
        eq(postedRow.plaidAccountId, pendingRow.plaidAccountId),
        eq(postedRow.pending, false),
        gte(postedRow.occurredOn, pendingRow.occurredOn),
        lte(
          postedRow.occurredOn,
          sql`(${pendingRow.occurredOn} + ${SUPERSEDE_MAX_DAYS}::int)`,
        ),
        gt(postedRow.createdAt, pendingRow.createdAt),
        sql`sign(${postedRow.amount}) = sign(${pendingRow.amount})`,
        sql`abs(${postedRow.amount}) >= abs(${pendingRow.amount})`,
        sql`abs(${postedRow.amount}) <= abs(${pendingRow.amount}) * 1.3 + 1.01`,
      ),
    )
    .where(
      and(
        eq(pendingRow.householdId, householdId),
        eq(pendingRow.pending, true),
        isNotNull(pendingRow.plaidAccountId),
        sql`${pendingRow.amount} <> 0`,
      ),
    );
}

type CandidateRow = Awaited<ReturnType<typeof supersedeCandidatesQuery>>[number];

/** Step 2: pair over the candidates only. */
function pairCandidates(candidates: readonly CandidateRow[]): SupersededPending {
  // One object per row, and each posted row's candidate pending rows.
  const rows = new Map<string, SupersedeRow>();
  const candidatesByPosted = new Map<string, SupersedeRow[]>();
  const rowOf = (r: SupersedeRow): SupersedeRow => {
    const seen = rows.get(r.id);
    if (seen) return seen;
    rows.set(r.id, r);
    return r;
  };
  for (const c of candidates) {
    const pending = rowOf({
      id: c.pId,
      plaidAccountId: c.pAccount,
      pending: true,
      occurredOn: c.pOn,
      amount: Number(c.pAmount) || 0,
      description: c.pDescription,
      createdAt: c.pCreatedAt,
    });
    rowOf({
      id: c.qId,
      plaidAccountId: c.qAccount,
      pending: false,
      occurredOn: c.qOn,
      amount: Number(c.qAmount) || 0,
      description: c.qDescription,
      createdAt: c.qCreatedAt,
    });
    const list = candidatesByPosted.get(c.qId);
    if (list) list.push(pending);
    else candidatesByPosted.set(c.qId, [pending]);
  }

  const pairs = pairPendingWithPostedAmong(
    [...rows.values()],
    (posted) => candidatesByPosted.get(posted.id) ?? [],
  );
  return {
    replacedIds: new Set([...pairs.values()].map((p) => p.id)),
    candidatePairs: candidates.length,
    rowsRead: rows.size,
  };
}

/** The replaced pending ids (`findSupersededPending`), for the spending readers. */
export async function loadSupersededPendingIds(householdId: string): Promise<Set<string>> {
  return (await findSupersededPending(householdId)).replacedIds;
}
