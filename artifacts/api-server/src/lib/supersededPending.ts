// (PR7b) A pending charge its posted row replaced is not spending twice.
//
// PR4c's `pairPendingWithPosted` decides which pending rows a posted row
// replaced when the sync never linked them. The cash ledger drops those rows;
// this module gives the spending readers (`buildSpendingFacts`,
// `buildBehaviorFacts`, the Amex weekly payoff, the Budget month) the same
// answer, so a pending $45.00 and its posted $47.40 count $47.40, not $92.40.
//
// (PR-D review H1) It also says WHICH pending row each posted row replaced,
// with that row's filing, so the posted row can carry it (`effectiveFiling`).
// (PR-D review M3) And it can answer for a date range without reading the
// household's whole history (`findSupersededPendingForRange`).

import { and, eq, gt, gte, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, transactionsTable } from "@workspace/db";
import {
  canSupersede,
  pairPendingWithPostedAmong,
  SUPERSEDE_MAX_DAYS,
  type SupersedeRow,
} from "@workspace/avalanche-core";
import { addDaysISO } from "./householdClock";
import type { Filing } from "./pendingFiling";
import { notBankRemovedSql } from "./bankRemoved";

/** `db` or a transaction on it: everything here only reads. */
export type DbReader = Pick<typeof db, "select">;

/** The pending row a posted row replaced, with the filing it carried. */
export interface ReplacedPending {
  id: string;
  occurredOn: string;
  /** (round 3 M1) The rules match on it: was the pending row's category a hand filing? */
  description: string;
  filing: Filing;
}

export type SupersededPending = {
  /** Pending rows a posted row replaced. */
  replacedIds: Set<string>;
  /** Posted row id → the pending row it replaced. */
  replacedBy: Map<string, ReplacedPending>;
  /** Candidate (pending, posted) pairs the pairing was offered. */
  candidatePairs: number;
  /** Distinct rows those pairs name: what the pairing actually read. */
  rowsRead: number;
};

export type SupersededPendingInRange = SupersededPending & {
  /** Candidate queries run: 0 when no pending row was in reach. */
  queries: number;
  /**
   * The earliest day the pairing started from (the earliest per-account cut,
   * below); null when skipped or answered from the whole ledger.
   */
  windowStart: string | null;
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
 * `findSupersededPendingForRange` gets the whole-ledger answer for a range by
 * starting its pairing at a day no pair crosses — see there.
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
 *      Descriptions are left to `canSupersede`. A posted row with no candidate
 *      pending row can take nothing, and a pending row no posted row can take is
 *      never taken, so neither can change any pair: leaving them out changes
 *      nothing.
 *   2. `pairPendingWithPostedAmong` — PR4c's pairing loop, shared with
 *      `pairPendingWithPosted` — offers each posted row only its candidates.
 *      The candidates are complete, which is exactly the condition under which
 *      it returns what `pairPendingWithPosted` returns.
 * `supersededPending.integration.test.ts` checks it against a whole-ledger run.
 */
export async function findSupersededPending(
  householdId: string,
  reader: DbReader = db,
): Promise<SupersededPending> {
  const candidates = await supersedeCandidatesQuery(householdId, reader);
  return pairCandidates(candidates, null);
}

/** First lookback before `from`, in days; doubled while no clean cut is found. */
const RANGE_LOOKBACK_DAYS = 32;
/** Past this lookback, the range is answered from the whole ledger instead. */
const RANGE_LOOKBACK_MAX_DAYS = 1024;

/**
 * ⭐ (PR-D review M3) THE WHOLE-LEDGER ANSWER FOR ROWS DATED IN [from, to] —
 * which of them were replaced, and which pending row each posted row among
 * them replaced — reading only a window before the range.
 *
 * WHY A WINDOW CAN BE EXACT. Pairing only ever pairs a posted row with a
 * pending row `canSupersede` accepts: same Plaid account, dated 0–7 days
 * earlier. Call a day `c` CLEAN for an account when no accepted (pending,
 * posted) pair on that account crosses it — pending before `c`, posted on or
 * after it. Then that account's rows on or after `c` pair only among
 * themselves, and its rows before `c` only among themselves; accounts never
 * pair with each other. So pairing each account's candidates from its clean
 * cut onward gives exactly the whole-ledger pairs of those rows.
 *
 * WHICH CUT. The latest clean day on or before from − 7 (a posted row in the
 * range can take a pending row dated from − 7). Candidates are read for posted
 * rows dated from `from − lookback` to `to + 8` — a pending row in the range
 * can only be taken by a posted row dated ≤ to + 7, and posted rows pick in date
 * order, so later posted rows cannot change a pair a row in the range is in.
 * If some account has no clean day in the read, the lookback doubles (32, 64,
 * …, 1024 days) and the read repeats; past that it answers from the whole
 * ledger. Usually one read; `queries` says how many.
 *
 * ⚠️ WHY NOT THE REVIEW'S FIXED WINDOW [from − 8, to + 8]. A chain of pairs can
 * cross its start (the 11.00 case: 8/13 → 8/18, 8/17 → 8/24), so a fixed
 * window re-pairs rows the whole ledger paired differently. And a crossing is
 * judged on ACCEPTED pairs only: judging it on the loose SQL candidates, a
 * first version walked back 23 reads for one month on a 20,000-row ledger.
 *
 * SKIP. No pending row dated in [from − 7, to] means nothing in the range was
 * replaced and no posted row in it replaced anything: no query, no pairing.
 *
 * Rows outside [from, to] are never reported, even when the window paired
 * them — their answer is not guaranteed.
 * `supersededPendingWindow.integration.test.ts` checks it against whole-ledger
 * pairing on randomized chains.
 */
export async function findSupersededPendingForRange(
  householdId: string,
  from: string,
  to: string,
  reader: DbReader = db,
): Promise<SupersededPendingInRange> {
  const [inReach] = await reader
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.pending, true),
        gte(transactionsTable.occurredOn, addDaysISO(from, -SUPERSEDE_MAX_DAYS)),
        lte(transactionsTable.occurredOn, to),
      ),
    )
    .limit(1);
  if (!inReach) {
    return {
      replacedIds: new Set(),
      replacedBy: new Map(),
      candidatePairs: 0,
      rowsRead: 0,
      queries: 0,
      windowStart: null,
    };
  }

  const range = { from, to };
  const postedTo = addDaysISO(to, SUPERSEDE_MAX_DAYS + 1);
  const latestCut = dayNumber(from) - SUPERSEDE_MAX_DAYS;
  let queries = 0;
  for (let lookback = RANGE_LOOKBACK_DAYS; lookback <= RANGE_LOOKBACK_MAX_DAYS; lookback *= 2) {
    const postedFrom = addDaysISO(from, -lookback);
    const candidates = await supersedeCandidatesQuery(householdId, reader, {
      postedFrom,
      postedTo,
    });
    queries += 1;
    const cuts = cleanCuts(candidates, dayNumber(postedFrom), latestCut);
    if (!cuts) continue;
    const kept = candidates.filter(
      (c) => dayNumber(c.qOn) >= (cuts.get(c.pAccount ?? "") ?? latestCut),
    );
    return {
      ...pairCandidates(kept, range),
      queries,
      windowStart: dayISO(Math.min(latestCut, ...cuts.values())),
    };
  }
  const all = await supersedeCandidatesQuery(householdId, reader);
  return { ...pairCandidates(all, range), queries: queries + 1, windowStart: null };
}

const DAY_MS = 86_400_000;
const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const dayISO = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * Per account, the latest day in [earliest, latest] no ACCEPTED candidate pair
 * crosses (pending day < cut ≤ posted day). Accounts no accepted pair crosses
 * inside the span are absent (any cut works; the caller uses `latest`). Null
 * when some account has no clean day in the span.
 */
function cleanCuts(
  candidates: readonly CandidateRow[],
  earliest: number,
  latest: number,
): Map<string, number> | null {
  const crossed = new Map<string, Uint8Array>();
  for (const c of candidates) {
    const first = Math.max(dayNumber(c.pOn) + 1, earliest);
    const last = Math.min(dayNumber(c.qOn), latest);
    if (first > last) continue;
    if (!canSupersede(pendingRowOf(c), postedRowOf(c))) continue;
    const account = c.pAccount ?? "";
    let days = crossed.get(account);
    if (!days) {
      days = new Uint8Array(latest - earliest + 1);
      crossed.set(account, days);
    }
    for (let d = first; d <= last; d += 1) days[d - earliest] = 1;
  }
  const cuts = new Map<string, number>();
  for (const [account, days] of crossed) {
    let cut = latest;
    while (cut >= earliest && days[cut - earliest]) cut -= 1;
    if (cut < earliest) return null;
    cuts.set(account, cut);
  }
  return cuts;
}

/**
 * Step 1: every (pending, posted) pair that could supersede — see above. With
 * `window`, only pairs whose POSTED row is dated in it (their pending rows are
 * then dated from 7 days before its start).
 */
export function supersedeCandidatesQuery(
  householdId: string,
  reader: DbReader = db,
  window?: { postedFrom: string; postedTo: string },
) {
  const pendingRow = alias(transactionsTable, "pending_row");
  const postedRow = alias(transactionsTable, "posted_row");
  return reader
    .select({
      pId: pendingRow.id,
      pAccount: pendingRow.plaidAccountId,
      pOn: pendingRow.occurredOn,
      pAmount: pendingRow.amount,
      pDescription: pendingRow.description,
      pCreatedAt: pendingRow.createdAt,
      // (PR-D review H1) The pending row's filing, for its posted row to inherit.
      pCategoryId: pendingRow.categoryId,
      pWeeklyAllowance: pendingRow.weeklyAllowance,
      pMonthlyAllowance: pendingRow.monthlyAllowance,
      pUnplannedAllowance: pendingRow.unplannedAllowance,
      pWeeklyBucket: pendingRow.weeklyBucket,
      pReimbursable: pendingRow.reimbursable,
      pDebtId: pendingRow.debtId,
      // (round 3 L2) dedupe's mergeStatePatch carries the transfer flag too.
      pIsTransfer: pendingRow.isTransfer,
      // (round 4, review H1/H2) The signal `effectiveFiling` decides hand-vs-
      // automatic and transfer inheritance from — never re-read mapping rules.
      pIsTransferUserOverridden: pendingRow.isTransferUserOverridden,
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
        // (PR-I) A posted row the bank removed replaces nothing: the pending row
        // the bank still reports keeps counting. A removed PENDING row stays a
        // candidate, so the posted row that replaced it never counts it twice —
        // the cash rule pairs the same way (`classifyCashRows`).
        notBankRemovedSql(postedRow.id),
        sql`sign(${postedRow.amount}) = sign(${pendingRow.amount})`,
        sql`abs(${postedRow.amount}) >= abs(${pendingRow.amount})`,
        sql`abs(${postedRow.amount}) <= abs(${pendingRow.amount}) * 1.3 + 1.01`,
        window ? gte(postedRow.occurredOn, window.postedFrom) : undefined,
        window ? lte(postedRow.occurredOn, window.postedTo) : undefined,
      ),
    )
    .where(
      and(
        eq(pendingRow.householdId, householdId),
        eq(pendingRow.pending, true),
        isNotNull(pendingRow.plaidAccountId),
        sql`${pendingRow.amount} <> 0`,
        window
          ? gte(pendingRow.occurredOn, addDaysISO(window.postedFrom, -SUPERSEDE_MAX_DAYS))
          : undefined,
        window ? lte(pendingRow.occurredOn, window.postedTo) : undefined,
      ),
    );
}

type CandidateRow = Awaited<ReturnType<typeof supersedeCandidatesQuery>>[number];

const pendingRowOf = (c: CandidateRow): SupersedeRow => ({
  id: c.pId,
  plaidAccountId: c.pAccount,
  pending: true,
  occurredOn: c.pOn,
  amount: Number(c.pAmount) || 0,
  description: c.pDescription,
  createdAt: c.pCreatedAt,
});

const postedRowOf = (c: CandidateRow): SupersedeRow => ({
  id: c.qId,
  plaidAccountId: c.qAccount,
  pending: false,
  occurredOn: c.qOn,
  amount: Number(c.qAmount) || 0,
  description: c.qDescription,
  createdAt: c.qCreatedAt,
});

/** Step 2: pair over the candidates only; report rows dated in `range` (all when null). */
function pairCandidates(
  candidates: readonly CandidateRow[],
  range: { from: string; to: string } | null,
): SupersededPending {
  // One object per row, and each posted row's candidate pending rows.
  const rows = new Map<string, SupersedeRow>();
  const filingById = new Map<string, Filing>();
  const candidatesByPosted = new Map<string, SupersedeRow[]>();
  const rowOf = (r: SupersedeRow): SupersedeRow => {
    const seen = rows.get(r.id);
    if (seen) return seen;
    rows.set(r.id, r);
    return r;
  };
  for (const c of candidates) {
    const pending = rowOf(pendingRowOf(c));
    if (!filingById.has(c.pId)) {
      filingById.set(c.pId, {
        categoryId: c.pCategoryId,
        weeklyAllowance: c.pWeeklyAllowance,
        monthlyAllowance: c.pMonthlyAllowance,
        unplannedAllowance: c.pUnplannedAllowance,
        weeklyBucket: c.pWeeklyBucket,
        reimbursable: c.pReimbursable,
        debtId: c.pDebtId,
        isTransfer: c.pIsTransfer,
        isTransferUserOverridden: c.pIsTransferUserOverridden,
      });
    }
    rowOf(postedRowOf(c));
    const list = candidatesByPosted.get(c.qId);
    if (list) list.push(pending);
    else candidatesByPosted.set(c.qId, [pending]);
  }

  const pairs = pairPendingWithPostedAmong(
    [...rows.values()],
    (posted) => candidatesByPosted.get(posted.id) ?? [],
  );

  const inRange = (day: string) => !range || (day >= range.from && day <= range.to);
  const replacedIds = new Set<string>();
  const replacedBy = new Map<string, ReplacedPending>();
  for (const [postedId, pending] of pairs) {
    if (inRange(pending.occurredOn)) replacedIds.add(pending.id);
    if (inRange(rows.get(postedId)!.occurredOn)) {
      replacedBy.set(postedId, {
        id: pending.id,
        occurredOn: pending.occurredOn,
        description: pending.description ?? "",
        filing: filingById.get(pending.id)!,
      });
    }
  }
  return {
    replacedIds,
    replacedBy,
    candidatePairs: candidates.length,
    rowsRead: rows.size,
  };
}

/** The replaced pending ids (`findSupersededPending`), for the whole-ledger readers. */
export async function loadSupersededPendingIds(householdId: string): Promise<Set<string>> {
  return (await findSupersededPending(householdId)).replacedIds;
}
