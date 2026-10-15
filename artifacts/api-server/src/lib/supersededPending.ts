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
//
// ⭐ (F6 round 3, owner's decision 2026-10-15) The same call also says which rows
// are EXPIRED HOLDS — pending more than SUPERSEDE_MAX_DAYS after their date and
// never replaced, plus the reversal paired with each (core `expiredHolds`).
// "Stop counting it everywhere — worked out, nothing deleted." Every reader that
// leaves out a replaced pending row leaves these out too: `countsNowhere` /
// `notCountedIdsOf`. Computed at read time only; no row is written. Kill switch:
// `EXPIRED_HOLDS_RULE=off` (`expiredHoldsRuleOn`) restores the reads before it.

import { and, eq, gt, gte, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, transactionsTable } from "@workspace/db";
import {
  canSupersede,
  countsNowhere,
  expiredHolds,
  notCountedIdsOf,
  pairPendingWithPostedAmong,
  REVERSAL_MAX_DAYS,
  SUPERSEDE_MAX_DAYS,
  type ExpiredHoldRow,
  type SupersedeRow,
} from "@workspace/avalanche-core";
import { addDaysISO, householdTodayISO } from "./householdClock";
import type { Filing } from "./pendingFiling";

/** `db` or a transaction on it: everything here only reads. */
export type DbReader = Pick<typeof db, "select">;

/** The pending row a posted row replaced, with the filing it carried. */
export interface ReplacedPending {
  id: string;
  occurredOn: string;
  /** (round 3 M1) The rules match on it: was the pending row's category a hand filing? */
  description: string;
  filing: Filing;
  /**
   * (F2) The pending row's Plaid categories — EVIDENCE only, never filing: the
   * evidence rule reads them for a posted row that has none of its own
   * (`carriedPfcEvidence`, pendingFiling.ts).
   */
  pfc?: { pfcPrimary: string | null; pfcDetailed: string | null };
}

export type SupersededPending = {
  /** Pending rows a posted row replaced. */
  replacedIds: Set<string>;
  /** Posted row id → the pending row it replaced. */
  replacedBy: Map<string, ReplacedPending>;
  /**
   * ⭐ (F6 round 3) Expired holds and the reversals paired with them (core
   * `expiredHolds`): they count nowhere, like a replaced pending row. Never a
   * replaced row. Empty with the rule off (`EXPIRED_HOLDS_RULE=off`).
   */
  expiredIds: Set<string>;
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
 * ⭐ (F6 round 3) THE KILL SWITCH. `EXPIRED_HOLDS_RULE=off` (any case) turns the
 * expired-hold rule off everywhere it is read — `expiredIds` comes back empty
 * and the cash rule (`classifyCashRows`) is run without it — so every figure
 * reads exactly as before the rule. Read on each call, so a restart with the
 * variable set is all a rollback takes.
 */
export function expiredHoldsRuleOn(): boolean {
  return (process.env.EXPIRED_HOLDS_RULE ?? "").trim().toLowerCase() !== "off";
}

/** (F6 round 3) The readers' helpers — pure, in avalanche-core; re-exported here beside the read. */
export { countsNowhere, notCountedIdsOf };

/** The household's today unless the caller (a test) names one. */
export interface SupersedeReadOptions {
  /** The household's today (YYYY-MM-DD) for the expired-hold rule; default `householdTodayISO()`. */
  today?: string;
}

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
  opts: SupersedeReadOptions = {},
): Promise<SupersededPending> {
  const candidates = await supersedeCandidatesQuery(householdId, reader);
  const answer = pairCandidates(candidates, null);
  if (!expiredHoldsRuleOn()) return answer;
  // (F6 round 3) Every pending Plaid row of the household: few, and read through
  // the partial pending index.
  const pending = await pendingRowsQuery(householdId, reader);
  return { ...answer, expiredIds: expiredHolds(pending.map(expiredRowOf), opts.today ?? householdTodayISO(), answer.replacedIds).expiredIds };
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
  opts: SupersedeReadOptions = {},
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
      expiredIds: new Set(),
      candidatePairs: 0,
      rowsRead: 0,
      queries: 0,
      windowStart: null,
    };
  }
  if (!expiredHoldsRuleOn()) return (await pairedForRange(householdId, from, to, reader)).answer;

  // ⭐ (F6 round 3) EXPIRED HOLDS, THE WHOLE-LEDGER ANSWER FOR THE RANGE.
  // A row dated before `young` (today − SUPERSEDE_MAX_DAYS) is expired exactly
  // when it is pending, on a Plaid account and not replaced: no pairing decides
  // it. A row dated on or after `young` is expired only as the REVERSAL of an
  // expired hold (F6 round 4: a pending credit, dated up to REVERSAL_MAX_DAYS
  // after an expired charge), and that pairing — one to one, oldest hold first —
  // can chain back through older pending rows (an older hold takes the credit a
  // younger one would have taken). So, when the range holds such days, the
  // pairing starts at a clean cut (`reversalCleanCuts`) on or before the
  // earliest hold that can take one of them (that day − REVERSAL_MAX_DAYS), and
  // the replaced answer is read from there too — about a month before `from`.
  const today = opts.today ?? householdTodayISO();
  const young = addDaysISO(today, -SUPERSEDE_MAX_DAYS);
  const youngStart = from > young ? from : young;
  // The holds that can take a reversal dated in the range: dated from
  // `youngStart` − REVERSAL_MAX_DAYS, and before `young` (older than 7 days).
  const holdsFrom = addDaysISO(youngStart, -REVERSAL_MAX_DAYS);
  let pairFrom = from;
  let pairTo = to;
  let pending: PendingRow[];
  if (youngStart <= to && holdsFrom < young) {
    // ⚠️ AND FORWARD: a hold prefers a fuzzy-equal reversal over an older one, so
    // which row a hold takes can depend on rows up to REVERSAL_MAX_DAYS after it
    // — after `to`. The holds that matter are dated before `young`, so the read
    // runs to the last such hold's day + REVERSAL_MAX_DAYS (or `to` + that, when
    // `to` is earlier), and the replaced rows with it.
    const lastHold = addDaysISO(young, -1);
    const reach = addDaysISO(lastHold < to ? lastHold : to, REVERSAL_MAX_DAYS);
    if (reach > pairTo) pairTo = reach;
    const found = await reversalWindow(householdId, reader, dayNumber(holdsFrom), from, pairTo);
    pending = found.rows;
    const cut = found.cut === null ? found.rows.reduce((d, r) => (r.occurredOn < d ? r.occurredOn : d), from) : dayISO(found.cut);
    if (cut < pairFrom) pairFrom = cut;
  } else {
    pending = await pendingRowsQuery(householdId, reader, { from, to });
  }
  // One pairing over [pairFrom, pairTo]: exact for every row there (the pairing
  // needs the replaced rows among the holds before `from` and the reversals
  // after `to`), reported for the range.
  const { answer, dayOf } = await pairedForRange(householdId, pairFrom, pairTo, reader);
  const { expiredIds } = expiredHolds(
    pending.filter((r) => r.occurredOn >= pairFrom && r.occurredOn <= pairTo).map(expiredRowOf),
    today,
    answer.replacedIds,
  );
  const inRange = (day: string | undefined) => day !== undefined && day >= from && day <= to;
  return {
    ...answer,
    replacedIds: new Set([...answer.replacedIds].filter((id) => inRange(dayOf.get(id)))),
    replacedBy: new Map([...answer.replacedBy].filter(([postedId]) => inRange(dayOf.get(postedId)))),
    expiredIds: new Set(pending.filter((r) => inRange(r.occurredOn) && expiredIds.has(r.id)).map((r) => r.id)),
  };
}

/**
 * ⭐ (F6 round 4) WHICH OF THESE ROWS COUNT NOWHERE AS EXPIRED HOLDS — the range
 * read's answer (`findSupersededPendingForRange`, the whole ledger's) over the
 * days of the rows that can be one: pending, on a Plaid account. One answer for
 * every reader that holds rows rather than a range (the list rows of
 * GET /transactions and GET /forecast, the rows an answer names, the payments
 * tagged to a debt). No query when none can be one, or with the rule off.
 */
export async function findExpiredHoldsAmong(
  householdId: string,
  rows: ReadonlyArray<{ id: string; pending: boolean | null; plaidAccountId: string | null; occurredOn: string }>,
  reader: DbReader = db,
  opts: SupersedeReadOptions = {},
): Promise<Set<string>> {
  if (!expiredHoldsRuleOn()) return new Set();
  const days = rows.filter((r) => r.pending === true && !!r.plaidAccountId).map((r) => r.occurredOn).sort();
  if (days.length === 0) return new Set();
  const { expiredIds } = await findSupersededPendingForRange(householdId, days[0]!, days[days.length - 1]!, reader, opts);
  const asked = new Set(rows.map((r) => r.id));
  return new Set([...expiredIds].filter((id) => asked.has(id)));
}

/**
 * The pending → posted pairs, exact for every row dated in [from, to] and
 * reported for them — the body of the range read before F6 round 3, unchanged
 * (`expiredIds` empty: the caller fills it) — and the day of every row the
 * pairing read (`dayOf`), so a caller can cut the answer to a narrower range.
 */
async function pairedForRange(
  householdId: string,
  from: string,
  to: string,
  reader: DbReader,
): Promise<{ answer: SupersededPendingInRange; dayOf: Map<string, string> }> {
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
      answer: {
        ...pairCandidates(kept, range),
        queries,
        windowStart: dayISO(Math.min(latestCut, ...cuts.values())),
      },
      dayOf: daysOf(kept),
    };
  }
  const all = await supersedeCandidatesQuery(householdId, reader);
  return { answer: { ...pairCandidates(all, range), queries: queries + 1, windowStart: null }, dayOf: daysOf(all) };
}

/** Row id → its day, for every row the candidates name. */
function daysOf(candidates: readonly CandidateRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of candidates) {
    out.set(c.pId, c.pOn);
    out.set(c.qId, c.qOn);
  }
  return out;
}

/** (F6 round 3) A pending Plaid row, as the expired-hold rule reads it. */
type PendingRow = Awaited<ReturnType<typeof pendingRowsQuery>>[number];

/** (F6 round 3) The household's pending Plaid rows (dated in the window, when given). */
function pendingRowsQuery(householdId: string, reader: DbReader, window?: { from: string | null; to: string }) {
  return reader
    .select({
      id: transactionsTable.id,
      plaidAccountId: transactionsTable.plaidAccountId,
      occurredOn: transactionsTable.occurredOn,
      amount: transactionsTable.amount,
      description: transactionsTable.description,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.pending, true),
        isNotNull(transactionsTable.plaidAccountId),
        window?.from ? gte(transactionsTable.occurredOn, window.from) : undefined,
        window ? lte(transactionsTable.occurredOn, window.to) : undefined,
      ),
    );
}

const expiredRowOf = (r: PendingRow): ExpiredHoldRow => ({
  id: r.id,
  plaidAccountId: r.plaidAccountId,
  pending: true,
  occurredOn: r.occurredOn,
  amount: Number(r.amount) || 0,
  description: r.description,
});

/**
 * (F6 round 3) The pending rows the reversal pairing needs, and the day it may
 * start from: the latest day on or before `latestCut` that no possible (hold,
 * reversal) pair crosses on any account (`reversalCleanCuts`), the earliest of
 * the accounts' cuts. The lookback doubles like the replaced read's (32, 64, …,
 * 1024 days); past that every pending row up to `to` is read and `cut` is null.
 * Rows from `from` on are always in the read.
 */
async function reversalWindow(
  householdId: string,
  reader: DbReader,
  latestCut: number,
  from: string,
  to: string,
): Promise<{ rows: PendingRow[]; cut: number | null }> {
  for (let lookback = RANGE_LOOKBACK_DAYS; lookback <= RANGE_LOOKBACK_MAX_DAYS; lookback *= 2) {
    // A pair crossing a day of the span has its hold at most REVERSAL_MAX_DAYS
    // before that day: read that far before the span too, or a crossing pair
    // whose hold is unread would leave its day looking clean.
    const readFrom = dayISO(latestCut - lookback - REVERSAL_MAX_DAYS);
    const rows = await pendingRowsQuery(householdId, reader, { from: readFrom < from ? readFrom : from, to });
    const cuts = reversalCleanCuts(rows, latestCut - lookback, latestCut);
    if (cuts) return { rows, cut: Math.min(latestCut, ...cuts.values()) };
  }
  return { rows: await pendingRowsQuery(householdId, reader, { from: null, to }), cut: null };
}

/**
 * Per account, the latest day in [earliest, latest] no POSSIBLE reversal pair
 * crosses (hold day < cut ≤ reversal day): (F6 round 4) a pending CHARGE and a
 * pending CREDIT of the same amount to the cent, the credit dated
 * 1–REVERSAL_MAX_DAYS days after the charge. Every pair the rule can make is
 * among them (it also needs the hold expired and neither row replaced), so a
 * day clean of these is clean of the rule's pairs: the rows on or after it pair
 * only among themselves. Accounts with no crossing are absent. Null when some
 * account has no clean day in the span.
 */
function reversalCleanCuts(rows: readonly PendingRow[], earliest: number, latest: number): Map<string, number> | null {
  const byKey = new Map<string, { on: number; sign: number }[]>();
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    if (!r.plaidAccountId || amount === 0) continue;
    const key = `${r.plaidAccountId}|${Math.round(Math.abs(amount) * 100)}`;
    const list = byKey.get(key) ?? [];
    list.push({ on: dayNumber(r.occurredOn), sign: Math.sign(amount) });
    byKey.set(key, list);
  }
  const crossed = new Map<string, Uint8Array>();
  for (const [key, list] of byKey) {
    const account = key.slice(0, key.lastIndexOf("|"));
    list.sort((a, b) => a.on - b.on);
    for (let i = 0; i < list.length; i += 1) {
      // Only a charge takes a reversal, and the reversal is a later credit.
      if (list[i]!.sign >= 0) continue;
      for (let j = i + 1; j < list.length && list[j]!.on - list[i]!.on <= REVERSAL_MAX_DAYS; j += 1) {
        if (list[j]!.sign <= 0 || list[j]!.on === list[i]!.on) continue;
        const first = Math.max(list[i]!.on + 1, earliest);
        const last = Math.min(list[j]!.on, latest);
        if (first > last) continue;
        let days = crossed.get(account);
        if (!days) {
          days = new Uint8Array(latest - earliest + 1);
          crossed.set(account, days);
        }
        for (let d = first; d <= last; d += 1) days[d - earliest] = 1;
      }
    }
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
      // (PR-A) The pending row's lock, carried with its category.
      pCategoryLockedByUser: pendingRow.categoryLockedByUser,
      // (F2) Its Plaid categories: evidence a posted row with none may read.
      pPfcPrimary: pendingRow.pfcPrimary,
      pPfcDetailed: pendingRow.pfcDetailed,
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
  const pfcById = new Map<string, NonNullable<ReplacedPending["pfc"]>>();
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
        categoryLockedByUser: c.pCategoryLockedByUser,
      });
      pfcById.set(c.pId, { pfcPrimary: c.pPfcPrimary, pfcDetailed: c.pPfcDetailed });
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
        pfc: pfcById.get(pending.id) ?? { pfcPrimary: null, pfcDetailed: null },
      });
    }
  }
  return {
    replacedIds,
    replacedBy,
    expiredIds: new Set(),
    candidatePairs: candidates.length,
    rowsRead: rows.size,
  };
}

/** The replaced pending ids (`findSupersededPending`), for the whole-ledger readers. */
export async function loadSupersededPendingIds(householdId: string): Promise<Set<string>> {
  return (await findSupersededPending(householdId)).replacedIds;
}
