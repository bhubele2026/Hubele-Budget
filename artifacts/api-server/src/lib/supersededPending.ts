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

import { and, eq, gt, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, debtsTable, forecastResolutionsTable, forecastSettingsTable, recurringItemsTable, transactionsTable } from "@workspace/db";
import {
  canBeReversal,
  canSupersede,
  countsNowhere,
  descriptorsMatch,
  expiredHolds,
  heldExpiredPairs,
  isInSnapshot,
  labelEvidence,
  matchesCardPaymentPattern,
  namesCardIssuer,
  normalizeDescription,
  notCountedIdsOf,
  pairPendingWithPostedAmong,
  paymentNamesCardIssuer,
  REVERSAL_MAX_DAYS,
  SUPERSEDE_MAX_DAYS,
  type CashAnchor,
  type ExpiredHoldRow,
  type SupersedeRow,
} from "@workspace/avalanche-core";
import { addDaysISO, householdDayOf, householdTodayISO } from "./householdClock";
import { ledgerSharingEnabled, shareInFlight } from "./ledgerShare";
import { resolveSnapshotAccount } from "./resolveSnapshotAccount";
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
  const read = await expiredRead(householdId, from, to, reader, opts.today ?? householdTodayISO(), {});
  const inRange = (day: string | undefined) => day !== undefined && day >= from && day <= to;
  const { answer, dayOf } = read;
  return {
    ...answer,
    replacedIds: new Set([...answer.replacedIds].filter((id) => inRange(dayOf.get(id)))),
    replacedBy: new Map([...answer.replacedBy].filter(([postedId]) => inRange(dayOf.get(postedId)))),
    expiredIds: new Set(read.pending.filter((r) => inRange(r.occurredOn) && read.expiredIds.has(r.id)).map((r) => r.id)),
  };
}

/**
 * ⭐ (F6 round 3) EXPIRED HOLDS, THE WHOLE-LEDGER ANSWER FOR [from, to].
 *
 * A row dated before `young` (today − SUPERSEDE_MAX_DAYS) is expired exactly
 * when it is pending, on a Plaid account and not replaced: no pairing decides
 * it. A row dated on or after `young` is expired only as the REVERSAL of an
 * expired hold (a pending credit that is not a payment or a transfer, dated up
 * to REVERSAL_MAX_DAYS after an expired charge — `expiredHolds`), and that
 * pairing — one to one, the oldest credit choosing first — can chain back
 * through older pending rows (an older credit takes the charge a younger one
 * would have taken). So, when the range holds such days, the pairing starts at
 * a clean cut (`reversalCleanCuts`) on or before the earliest hold that can
 * pair with one of them (that day − REVERSAL_MAX_DAYS), and the replaced
 * answer is read from there too — about a month before `from`.
 *
 * ⭐ (F6 round 6) AND FORWARD, TO A CLEAN CUT. The pairing is a maximum matching
 * (`expiredHolds`): a later credit can move an earlier credit's pair, to pair
 * one more. So the read also reaches past `to`, to the first day per account
 * no possible pair crosses (`forwardCleanCut`) — usually `to` itself (no
 * pending credit after it can reach back), so no wider read. (Round 5 read
 * nothing past `to`: the credit's pair depended only on rows before it.)
 *
 * `everyPair` (the list's labels): pair every credit in the range, old ones
 * too — an expired credit that reversed a held hold counts in the bank
 * balance, so its pair matters even when its own age already expires it.
 * `isHeld`: the snapshot's test, for `expiredHolds`' preference (finding 6).
 * Returns every row the pairing read (`pending`, dated in [pairFrom, to]), its
 * expired ids and pairs; the caller reports what it asked for.
 */
async function expiredRead(
  householdId: string,
  from: string,
  to: string,
  reader: DbReader,
  today: string,
  opts: { everyPair?: boolean; isHeld?: (row: PendingRow) => boolean },
): Promise<{
  answer: SupersededPendingInRange;
  dayOf: Map<string, string>;
  pending: PendingRow[];
  expiredIds: Set<string>;
  holdOf: Map<string, string>;
}> {
  const young = addDaysISO(today, -SUPERSEDE_MAX_DAYS);
  // The first day whose credits need their pairs: the young days (only a
  // reversal is expired there), or the whole range for `everyPair`.
  const pairStart = opts.everyPair ? from : from > young ? from : young;
  // The holds that can take a reversal dated from `pairStart`: dated from
  // `pairStart` − REVERSAL_MAX_DAYS, and before `young` (older than 7 days).
  const holdsFrom = addDaysISO(pairStart, -REVERSAL_MAX_DAYS);
  let pairFrom = from;
  let pairTo = to;
  let pending: PendingRow[];
  if (pairStart <= to && holdsFrom < young) {
    const found = await reversalWindow(householdId, reader, dayNumber(holdsFrom), from);
    pending = found.rows;
    const cut = found.cut === null ? found.rows.reduce((d, r) => (r.occurredOn < d ? r.occurredOn : d), from) : dayISO(found.cut);
    if (cut < pairFrom) pairFrom = cut;
    // (F6 round 6) The later credits a maximum matching can read.
    pairTo = dayISO(forwardCleanCut(found.rows, dayNumber(to)));
  } else {
    pending = await pendingRowsQuery(householdId, reader, { from, to });
  }
  // One pairing over [pairFrom, pairTo]: exact for every row there (the reversal
  // pairing needs the replaced rows among the holds before `from`, and after `to`).
  const { answer, dayOf } = await pairedForRange(householdId, pairFrom, pairTo, reader);
  const read = pending.filter((r) => r.occurredOn >= pairFrom && r.occurredOn <= pairTo);
  const byId = new Map(read.map((r) => [r.id, r] as const));
  const isHeld = opts.isHeld;
  const { expiredIds, holdOf } = expiredHolds(read.map(expiredRowOf), today, answer.replacedIds, {
    isHeld: isHeld ? (h) => isHeld(byId.get(h.id)!) : undefined,
  });
  return { answer, dayOf, pending: read, expiredIds, holdOf };
}

/**
 * ⭐ (F6 round 4) WHICH OF THESE ROWS COUNT NOWHERE AS EXPIRED HOLDS — the range
 * read's answer (`findSupersededPendingForRange`, the whole ledger's) over the
 * days of the rows that can be one: pending, on a Plaid account. One answer for
 * every reader that holds rows rather than a range (the rows an answer names,
 * the payments tagged to a debt). No query when none can be one, or with the
 * rule off. (F6 round 5) The list rows' labels read `findExpiredLabelsAmong`.
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

/** A row an answer, a debt tag or a claim names, as `readAnsweredRows` reads it. */
export type NamedRow = {
  id: string;
  pending: boolean | null;
  plaidAccountId: string | null;
  occurredOn: string;
  amount: string | number | null;
};

/** The posted row a payment on an expired row posted as (`readAnsweredRows`). */
export type PostedTwin = {
  id: string;
  occurredOn: string;
  amount: string;
  description: string | null;
  source: string | null;
  plaidAccountId: string | null;
  forecastFlag: boolean;
  pending: boolean;
};

export type AnsweredRows = {
  /** The named rows that are expired holds (`findExpiredHoldsAmong`). */
  expired: Set<string>;
  /** An expired named row → the posted row its payment posted as: the answer counts there. */
  postedTwinOf: Map<string, PostedTwin>;
};

/** ⭐ (F6 round 6) The household's posted twins (`loadAnswerTwins`): one map, every reader. */
export type AnswerTwins = {
  /** An expired named row → its posted twin. */
  twinOf: Map<string, PostedTwin>;
};

/**
 * ⭐ (F6 round 5, review finding 5 — lead's decision) WHERE AN ANSWER ON AN
 * EXPIRED ROW COUNTS.
 *
 * Round 4 dropped a "matched" / "partial" answer (or a debt tag) whose row is an
 * expired hold: the payment failed, or it posted under another name. In the
 * second case the bill then counted again while the posted row had already
 * taken the cash. So, before dropping it, the answer looks for the posted row
 * the payment became — its POSTED TWIN (`loadAnswerTwins`: one map for the
 * household, every reader). With one, the answer counts on that posted row —
 * moved for reading only, nothing written. Without, it is dropped (the
 * payment failed: the occurrence drags again). Kill switch off: no row is
 * expired, nothing moves (the base).
 *
 * `rows`: the rows the caller's answers, tags or claims name. No query past
 * `findExpiredHoldsAmong`'s when none of them is an expired hold that may move
 * (`movable`), the usual case.
 */
export async function readAnsweredRows(
  householdId: string,
  rows: readonly NamedRow[],
  reader: DbReader = db,
  opts: SupersedeReadOptions & {
    /** The rows whose answer may move (default: all) — e.g. a debt's tag and answers, not a claim's confirming row. */
    movable?: (row: NamedRow) => boolean;
    /** (F6 round 6) The map a caller already read in this request (`loadAnswerTwins`). */
    twins?: AnswerTwins;
  } = {},
): Promise<AnsweredRows> {
  const expired = await findExpiredHoldsAmong(householdId, rows, reader, opts);
  const postedTwinOf = new Map<string, PostedTwin>();
  const movable = opts.movable ?? (() => true);
  const holds = rows.filter((r) => expired.has(r.id) && !!r.plaidAccountId && Number(r.amount) < 0 && movable(r));
  if (holds.length === 0) return { expired, postedTwinOf };
  const { twinOf } = opts.twins ?? (await loadAnswerTwins(householdId, reader, opts));
  for (const h of holds) {
    const twin = twinOf.get(h.id);
    if (twin) postedTwinOf.set(h.id, twin);
  }
  return { expired, postedTwinOf };
}

/** (F6 round 6) What a posted row must say of itself to be a payment's twin (`loadAnswerTwins`). */
const PAYMENT_TEXT = /\b(payment|payments|pymt|pmt|autopay|ach|epay|epayment|billpay|bill pay)\b/;

/**
 * ⭐ (F6 round 6, review findings 2 and 4 — lead's decisions) THE POSTED TWINS,
 * ONE MAP FOR THE HOUSEHOLD.
 *
 * The rows: every pending, money-out Plaid row a "matched" / "partial" answer
 * (or a review of one) or a debt tag names, that is an expired hold
 * (`findExpiredHoldsAmong`). Every reader — the forecast's curve, the GET
 * /forecast bundle, Bills, the debt plan, the monitor — looks its own rows up
 * in this one map (`readAnsweredRows`), so one posted row never pays two
 * answers, whichever reader asks. Read so; nothing written. Concurrent readers
 * share one build (`shareInFlight`); a later one rebuilds the same answer.
 *
 * A posted row Q is the TWIN of an expired row H only when all hold — when
 * unsure, the answer is dropped (round 4: the occurrence drags again; the
 * forecast's evidence path can still pay it):
 *   - Q is posted, on H's account, money out, dated on H's day to
 *     SUPERSEDE_MAX_DAYS (7) after it;
 *   - the SAME cents, ± $1.00 (a payment carries no tip: no 1.3× band — a −130
 *     purchase is no −120 bill's twin);
 *   - Q reads as a payment (`PAYMENT_TEXT`: "PMT", "PAYMENT", "AUTOPAY", "ACH",
 *     "EPAY" …) — never a store purchase of the same cents;
 *   - nothing else speaks for Q: no forecast answer names it, no debt tag, no
 *     logged claim it confirmed, it replaced no pending row;
 *   - the forecast's evidence path cannot give Q to another plan
 *     (`evidenceElsewhere`): it is no card payment or transfer (the card's own
 *     ledger, the minimums and the hooks pay with those), and it names no other
 *     bill, minimum or debt, sits in no other bill's category, and matches no
 *     row the household confirmed for another bill;
 *   - and the pair is the only one either side has: Q is H's one candidate and
 *     H is Q's one claimant. Two answers that could own one posted row, or two
 *     posted rows that could be one answer's: neither moves (finding 4: one
 *     −200 never pays a bill and a debt; one −90 never pays Gas and Phone).
 * Kill switch off: empty.
 */
export async function loadAnswerTwins(householdId: string, reader: DbReader = db, opts: SupersedeReadOptions = {}): Promise<AnswerTwins> {
  const today = opts.today ?? householdTodayISO();
  const build = () => buildAnswerTwins(householdId, reader, today);
  if (reader !== db || !ledgerSharingEnabled()) return build();
  return shareInFlight(`answerTwins\u0001${householdId}\u0001${today}`, build);
}

async function buildAnswerTwins(householdId: string, reader: DbReader, today: string): Promise<AnswerTwins> {
  const twinOf = new Map<string, PostedTwin>();
  if (!expiredHoldsRuleOn()) return { twinOf };
  const t = transactionsTable;
  const r = forecastResolutionsTable;
  const namedCols = { id: t.id, pending: t.pending, plaidAccountId: t.plaidAccountId, occurredOn: t.occurredOn, amount: t.amount, debtId: t.debtId };
  const pendingOut = and(eq(t.householdId, householdId), eq(t.pending, true), isNotNull(t.plaidAccountId), lt(t.amount, "0"));
  const [answeredRows, taggedRows] = await Promise.all([
    reader
      .select({ ...namedCols, itemId: r.recurringItemId })
      .from(r)
      .innerJoin(t, eq(t.id, r.matchedTxnId))
      .where(and(eq(r.householdId, householdId), inArray(r.status, ["matched", "partial", "needs_review", "needs_review_partial"]), pendingOut)),
    reader.select(namedCols).from(t).where(and(pendingOut, isNotNull(t.debtId))),
  ]);
  // Each named row and the plans that own it (an answer's item, a tag's debt).
  const named = new Map<string, NamedRow>();
  const owners = new Map<string, Set<string>>();
  const own = (row: NamedRow, plan: string | null) => {
    named.set(row.id, row);
    const set = owners.get(row.id) ?? new Set<string>();
    if (plan) set.add(plan);
    owners.set(row.id, set);
  };
  for (const a of answeredRows) own(a, a.itemId);
  for (const g of taggedRows) own(g, g.debtId ? `debt:${g.debtId}` : null);
  if (named.size === 0) return { twinOf };
  const expired = await findExpiredHoldsAmong(householdId, [...named.values()], reader, { today });
  const holds = [...named.values()].filter((h) => expired.has(h.id));
  if (holds.length === 0) return { twinOf };
  const first = holds.reduce((d, h) => (h.occurredOn < d ? h.occurredOn : d), holds[0]!.occurredOn);
  const last = addDaysISO(holds.reduce((d, h) => (h.occurredOn > d ? h.occurredOn : d), first), SUPERSEDE_MAX_DAYS);
  const cents = (v: string | number | null) => Math.round(Math.abs(Number(v) || 0) * 100);
  const posted = (
    await reader
      .select({
        id: t.id,
        occurredOn: t.occurredOn,
        amount: t.amount,
        description: t.description,
        source: t.source,
        plaidAccountId: t.plaidAccountId,
        forecastFlag: t.forecastFlag,
        pending: t.pending,
        debtId: t.debtId,
        categoryId: t.categoryId,
        isTransfer: t.isTransfer,
        isExternalCardPayment: t.isExternalCardPayment,
        pfcPrimary: t.pfcPrimary,
        pfcDetailed: t.pfcDetailed,
      })
      .from(t)
      .where(
        and(
          eq(t.householdId, householdId),
          eq(t.pending, false),
          inArray(t.plaidAccountId, [...new Set(holds.map((h) => h.plaidAccountId!))]),
          lt(t.amount, "0"),
          gte(t.occurredOn, first),
          lte(t.occurredOn, last),
        ),
      )
  ).filter((q) => !q.debtId && PAYMENT_TEXT.test(normalizeDescription(q.description)) && !paysACard(q));
  // Each hold's candidates by the row alone (account, days, cents).
  const near = new Map<string, typeof posted>();
  for (const h of holds) {
    const p = cents(h.amount);
    const lastDay = addDaysISO(h.occurredOn, SUPERSEDE_MAX_DAYS);
    near.set(
      h.id,
      posted.filter((q) => q.plaidAccountId === h.plaidAccountId && q.occurredOn >= h.occurredOn && q.occurredOn <= lastDay && Math.abs(cents(q.amount) - p) <= 100),
    );
  }
  const inPlay = [...new Set([...near.values()].flat())];
  if (inPlay.length === 0) return { twinOf };
  // Already spoken for: a forecast answer names it, a logged claim it confirmed,
  // or it replaced a pending row (it is THAT row's posting).
  const ids = inPlay.map((q) => q.id);
  const days = inPlay.map((q) => q.occurredOn).sort();
  const [answered, confirming, replaced, plans] = await Promise.all([
    reader.select({ id: r.matchedTxnId }).from(r).where(and(eq(r.householdId, householdId), inArray(r.matchedTxnId, ids))),
    reader.select({ id: t.confirmedByTxnId }).from(t).where(and(eq(t.householdId, householdId), inArray(t.confirmedByTxnId, ids))),
    findSupersededPendingForRange(householdId, days[0]!, days[days.length - 1]!, reader, { today }),
    loadPlanNames(householdId, reader),
  ]);
  const spoken = new Set<string>([
    ...answered.map((a) => a.id).filter((id): id is string => !!id),
    ...confirming.map((c) => c.id).filter((id): id is string => !!id),
    ...replaced.replacedBy.keys(),
  ]);
  const candidatesOf = new Map<string, string[]>();
  const claimantsOf = new Map<string, string[]>();
  for (const h of holds) {
    const list = near
      .get(h.id)!
      .filter((q) => !spoken.has(q.id) && !evidenceElsewhere(q, owners.get(h.id)!, plans))
      .map((q) => q.id);
    candidatesOf.set(h.id, list);
    for (const id of list) claimantsOf.set(id, [...(claimantsOf.get(id) ?? []), h.id]);
  }
  const byId = new Map(inPlay.map((q) => [q.id, q] as const));
  for (const h of holds) {
    const list = candidatesOf.get(h.id)!;
    if (list.length !== 1 || claimantsOf.get(list[0]!)!.length !== 1) continue;
    const q = byId.get(list[0]!)!;
    twinOf.set(h.id, {
      id: q.id,
      occurredOn: q.occurredOn,
      amount: q.amount,
      description: q.description ?? null,
      source: q.source ?? null,
      plaidAccountId: q.plaidAccountId ?? null,
      forecastFlag: q.forecastFlag,
      pending: q.pending ?? false,
    });
  }
  return { twinOf };
}

/**
 * (F6 round 6) A posted row the card's own ledger, the debt minimums or the
 * hooks pay with: the user's card-payment or transfer flag, Plaid
 * LOAN_PAYMENTS / TRANSFER_*, an issuer's payment phrase
 * (`matchesCardPaymentPattern`), or the card issuer's name
 * (`paymentNamesCardIssuer`, `namesCardIssuer`).
 */
function paysACard(q: {
  description: string | null;
  isTransfer: boolean | null;
  isExternalCardPayment: boolean | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
}): boolean {
  if (q.isTransfer === true || q.isExternalCardPayment === true) return true;
  const pfc = /^(LOAN_PAYMENTS|TRANSFER_IN|TRANSFER_OUT)/;
  if (pfc.test((q.pfcPrimary ?? "").toUpperCase()) || pfc.test((q.pfcDetailed ?? "").toUpperCase())) return true;
  const d = q.description ?? "";
  return matchesCardPaymentPattern(d) || paymentNamesCardIssuer(d) || namesCardIssuer(d);
}

/** (F6 round 6) The household's plans as the evidence path names them (`evidenceElsewhere`). */
type PlanNames = {
  /** Every bill (not income) — active or not — and the debt it is linked to. */
  bills: Array<{ key: string; name: string; categoryId: string | null; debtId: string | null }>;
  /** Every debt, as its minimum's plan key (`debt:<id>`). */
  debts: Array<{ key: string; name: string }>;
  /** Plan key → the descriptions of the rows the household confirmed for it. */
  confirmed: Map<string, string[]>;
};

async function loadPlanNames(householdId: string, reader: DbReader): Promise<PlanNames> {
  const t = transactionsTable;
  const r = forecastResolutionsTable;
  const [items, debts, confirmedRows] = await Promise.all([
    reader
      .select({ id: recurringItemsTable.id, name: recurringItemsTable.name, kind: recurringItemsTable.kind, categoryId: recurringItemsTable.categoryId, debtId: recurringItemsTable.debtId })
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.householdId, householdId)),
    reader.select({ id: debtsTable.id, name: debtsTable.name }).from(debtsTable).where(eq(debtsTable.householdId, householdId)),
    reader
      .select({ key: r.recurringItemId, description: t.description })
      .from(r)
      .innerJoin(t, eq(t.id, r.matchedTxnId))
      .where(and(eq(r.householdId, householdId), inArray(r.status, ["matched", "partial"]), isNotNull(r.recurringItemId))),
  ]);
  const confirmed = new Map<string, string[]>();
  for (const c of confirmedRows) {
    if (!c.key || !c.description) continue;
    confirmed.set(c.key, [...(confirmed.get(c.key) ?? []), c.description]);
  }
  return {
    bills: items.filter((i) => i.kind !== "income").map((i) => ({ key: i.id, name: i.name, categoryId: i.categoryId ?? null, debtId: i.debtId ?? null })),
    debts: debts.map((d) => ({ key: `debt:${d.id}`, name: d.name })),
    confirmed,
  };
}

/**
 * ⭐ (F6 round 6, finding 2) COULD THE FORECAST'S EVIDENCE PATH GIVE THIS ROW TO
 * ANOTHER PLAN? Its own row tests, read wider than the matcher (the safe side:
 * a twin dropped is an answer dropped, as in round 4): the row names another
 * bill or debt (`labelEvidence`, the matcher's name rule), sits in another
 * bill's category, or matches a row the household confirmed for another plan
 * (`descriptorsMatch`). `owners`: the plans the expired row's answers and tags
 * name — a bill linked to an owning debt (or the debt of an owning bill) is
 * the same plan. City Water's own −120 payment is never City Power's twin.
 *
 * ⭐ (Final polish, round 6 verifier) NOR TO THE HOLD'S OWN BILL. A posted row
 * the evidence path can pay the hold's OWN bill with — it names the bill, sits
 * in its category, or matches a row the household confirmed for it — is no
 * twin either: the evidence path pays it to the occurrence it belongs to. A
 * weekly 150 paid by ACH with a changing reference: the 9/30 payment answered
 * then failed, the 10/07 payment posted — round 6 took 10/07 as 9/30's twin,
 * so the paid 10/07 week dragged −150 again and Bills September read paid
 * 150 (round 4, and the control with no answer: the evidence path pays 10/07,
 * 9/30 is unpaid). A payee name that differs from the bill's ("CPWR UTIL WEB
 * PMT" for City Power) is still the one sure twin. Only the BILL the hold is
 * answered for: a debt the hold is tagged to (and a bill linked to that debt)
 * stays skipped — the debt plan reads tags, not names, so its twin is the
 * only way a tagged payment that posted under another row counts (round 5).
 */
function evidenceElsewhere(q: { description: string | null; categoryId: string | null }, owners: ReadonlySet<string>, plans: PlanNames): boolean {
  const ownDebts = new Set<string>();
  for (const key of owners) if (key.startsWith("debt:")) ownDebts.add(key);
  for (const b of plans.bills) if (owners.has(b.key) && b.debtId) ownDebts.add(`debt:${b.debtId}`);
  // The hold's own bill (an answer names it) is checked like any other plan; a debt it reaches is skipped.
  const ownBill = (key: string) => owners.has(key) && !key.startsWith("debt:");
  const isOwn = (key: string, debtId?: string | null) =>
    !ownBill(key) && (owners.has(key) || ownDebts.has(key) || (!!debtId && ownDebts.has(`debt:${debtId}`)));
  for (const b of plans.bills) {
    if (isOwn(b.key, b.debtId)) continue;
    if (labelEvidence(b.name, q.description)) return true;
    if (q.categoryId && b.categoryId === q.categoryId) return true;
  }
  for (const d of plans.debts) {
    if (isOwn(d.key)) continue;
    if (labelEvidence(d.name, q.description)) return true;
  }
  for (const [key, descriptions] of plans.confirmed) {
    if (isOwn(key, plans.bills.find((b) => b.key === key)?.debtId)) continue;
    if (descriptions.some((d) => descriptorsMatch(d, q.description))) return true;
  }
  return false;
}

/** (F6 round 5) The bank snapshot a list's labels read: when it was read, its household day, its account. */
export type BankSnapshotRef = { anchor: CashAnchor; accountExternalId: string };

/**
 * (F6 round 5) The bank snapshot the ledger rolls from — the forecast
 * settings' read instant and the account it resolves to
 * (`resolveSnapshotAccount`), as `buildForecastLedger` and the register read
 * them. Null without a snapshot or an account.
 */
export async function loadBankSnapshotRef(householdId: string, ownerUserId: string): Promise<BankSnapshotRef | null> {
  const [settings] = await db
    .select({
      bankSnapshotAt: forecastSettingsTable.bankSnapshotAt,
      bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId,
      bankSnapshotMask: forecastSettingsTable.bankSnapshotMask,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  if (!settings?.bankSnapshotAt) return null;
  const account = await resolveSnapshotAccount({
    householdId,
    bankSnapshotAccountId: settings.bankSnapshotAccountId ?? null,
    bankSnapshotMask: settings.bankSnapshotMask ?? null,
  });
  return snapshotRefOf(settings.bankSnapshotAt, account.externalId);
}

/** (F6 round 5) The snapshot ref from what a caller already read (null without either). */
export function snapshotRefOf(at: Date | null | undefined, accountExternalId: string | null | undefined): BankSnapshotRef | null {
  if (!at || !accountExternalId) return null;
  return { anchor: { at, day: householdDayOf(at) }, accountExternalId };
}

/** What a listed row says about the rule (`findExpiredLabelsAmong`). */
export type ExpiredLabels = {
  /** Expired holds and their reversals that count nowhere — labelled "Expired hold · not counted". */
  expiredHold: Set<string>;
  /**
   * A hold the snapshot holds, and its reversal (`heldExpiredPairs`): counted
   * in the bank balance and the register (net 0), never labelled — but in no
   * spending, and never asked about.
   */
  expiredPair: Set<string>;
};

/**
 * ⭐ (F6 round 5, review finding 3) THE LABELS OF LISTED ROWS — GET
 * /transactions and the GET /forecast bundle, the register's answer.
 *
 * The whole-ledger pairing over the rows' pending days (`expiredRead`, every
 * credit paired, the snapshot's `held()` preference), then the register's
 * test, `heldExpiredPairs`: a hold the snapshot holds and its reversal are
 * counted rows (`expiredPair`), every other expired row is `expiredHold`. The
 * pairing reads REVERSAL_MAX_DAYS past the last day too: a held hold on the
 * page is a pair only if its reversal (up to 31 days later) took it.
 * No query when no row is a pending Plaid row, or with the rule off.
 */
export async function findExpiredLabelsAmong(
  householdId: string,
  rows: ReadonlyArray<{ id: string; pending: boolean | null; plaidAccountId: string | null; occurredOn: string }>,
  snapshot: BankSnapshotRef | null,
  reader: DbReader = db,
  opts: SupersedeReadOptions = {},
): Promise<ExpiredLabels> {
  const none: ExpiredLabels = { expiredHold: new Set(), expiredPair: new Set() };
  if (!expiredHoldsRuleOn()) return none;
  const days = rows.filter((r) => r.pending === true && !!r.plaidAccountId).map((r) => r.occurredOn).sort();
  if (days.length === 0) return none;
  const today = opts.today ?? householdTodayISO();
  const onSnapshot = (r: PendingRow): boolean => !!snapshot && r.plaidAccountId === snapshot.accountExternalId;
  const read = await expiredRead(householdId, days[0]!, addDaysISO(days[days.length - 1]!, REVERSAL_MAX_DAYS), reader, today, {
    everyPair: true,
    isHeld: snapshot ? (r) => onSnapshot(r) && isInSnapshot(snapshotRowOf(r), snapshot.anchor.at, snapshot.anchor.day) : undefined,
  });
  const byId = new Map(read.pending.map((r) => [r.id, r] as const));
  const pairs = heldExpiredPairs(
    read.holdOf,
    (id) => {
      const r = byId.get(id);
      return r && onSnapshot(r) ? snapshotRowOf(r) : undefined;
    },
    snapshot?.anchor ?? null,
  );
  const out: ExpiredLabels = { expiredHold: new Set(), expiredPair: new Set() };
  for (const r of rows) {
    if (!read.expiredIds.has(r.id)) continue;
    (pairs.has(r.id) ? out.expiredPair : out.expiredHold).add(r.id);
  }
  return out;
}

/** A pending row's fields the snapshot rule reads. */
function snapshotRowOf(r: PendingRow) {
  return {
    occurredOn: r.occurredOn,
    amount: Number(r.amount) || 0,
    createdAt: r.createdAt,
    occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
    plaidAccountId: r.plaidAccountId,
  };
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

/** (F6 round 3) The household's pending Plaid rows (dated in the window, when given; an open end reads on). */
function pendingRowsQuery(householdId: string, reader: DbReader, window?: { from: string | null; to: string | null }) {
  return reader
    .select({
      id: transactionsTable.id,
      plaidAccountId: transactionsTable.plaidAccountId,
      occurredOn: transactionsTable.occurredOn,
      amount: transactionsTable.amount,
      description: transactionsTable.description,
      // (F6 round 5) A payment or a transfer is never a reversal (`canBeReversal`).
      isTransfer: transactionsTable.isTransfer,
      debtId: transactionsTable.debtId,
      isExternalCardPayment: transactionsTable.isExternalCardPayment,
      pfcPrimary: transactionsTable.pfcPrimary,
      pfcDetailed: transactionsTable.pfcDetailed,
      // (F6 round 5) The snapshot rule's fields, for the list's labels (`findExpiredLabelsAmong`).
      createdAt: transactionsTable.createdAt,
      occurredAt: transactionsTable.occurredAt,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.pending, true),
        isNotNull(transactionsTable.plaidAccountId),
        window?.from ? gte(transactionsTable.occurredOn, window.from) : undefined,
        window?.to ? lte(transactionsTable.occurredOn, window.to) : undefined,
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
  isTransfer: r.isTransfer,
  debtId: r.debtId,
  isExternalCardPayment: r.isExternalCardPayment,
  pfcPrimary: r.pfcPrimary,
  pfcDetailed: r.pfcDetailed,
});

/**
 * (F6 round 3) The pending rows the reversal pairing needs, and the day it may
 * start from: the latest day on or before `latestCut` that no possible (hold,
 * reversal) pair crosses on any account (`reversalCleanCuts`), the earliest of
 * the accounts' cuts. The lookback doubles like the replaced read's (32, 64, …,
 * 1024 days); past that every pending row is read and `cut` is null.
 * (F6 round 6) Every pending row after `from` is read too (no upper bound): the
 * forward cut (`forwardCleanCut`) is found among them. Pending rows dated after
 * a range are few — usually none, the range reaching today.
 */
async function reversalWindow(
  householdId: string,
  reader: DbReader,
  latestCut: number,
  from: string,
): Promise<{ rows: PendingRow[]; cut: number | null }> {
  for (let lookback = RANGE_LOOKBACK_DAYS; lookback <= RANGE_LOOKBACK_MAX_DAYS; lookback *= 2) {
    // A pair crossing a day of the span has its hold at most REVERSAL_MAX_DAYS
    // before that day: read that far before the span too, or a crossing pair
    // whose hold is unread would leave its day looking clean.
    const readFrom = dayISO(latestCut - lookback - REVERSAL_MAX_DAYS);
    const rows = await pendingRowsQuery(householdId, reader, { from: readFrom < from ? readFrom : from, to: null });
    const cuts = reversalCleanCuts(rows, latestCut - lookback, latestCut);
    if (cuts) return { rows, cut: Math.min(latestCut, ...cuts.values()) };
  }
  return { rows: await pendingRowsQuery(householdId, reader, { from: null, to: null }), cut: null };
}

/**
 * (F6 round 3 / round 6) Every POSSIBLE reversal pair among `rows`, per
 * account, as [the charge's day, the credit's day]: a pending CHARGE and a
 * pending CREDIT of the same amount to the cent, the credit dated
 * 1–REVERSAL_MAX_DAYS days after the charge and able to be a reversal
 * (`canBeReversal`: not a payment or a transfer). Every pair the rule can make
 * is among them (it also needs the hold expired and neither row replaced), and
 * a same-day pair crosses no day.
 */
function possibleReversalPairs(rows: readonly PendingRow[]): Map<string, Array<[number, number]>> {
  const byKey = new Map<string, { on: number; sign: number }[]>();
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    if (!r.plaidAccountId || amount === 0) continue;
    // (F6 round 5) A credit that cannot be a reversal (a payment, a transfer) pairs with nothing.
    if (amount > 0 && !canBeReversal(expiredRowOf(r))) continue;
    const key = `${r.plaidAccountId}|${Math.round(Math.abs(amount) * 100)}`;
    const list = byKey.get(key) ?? [];
    list.push({ on: dayNumber(r.occurredOn), sign: Math.sign(amount) });
    byKey.set(key, list);
  }
  const out = new Map<string, Array<[number, number]>>();
  for (const [key, list] of byKey) {
    const account = key.slice(0, key.lastIndexOf("|"));
    list.sort((a, b) => a.on - b.on);
    for (let i = 0; i < list.length; i += 1) {
      // Only a charge takes a reversal, and the reversal is a later credit.
      if (list[i]!.sign >= 0) continue;
      for (let j = i + 1; j < list.length && list[j]!.on - list[i]!.on <= REVERSAL_MAX_DAYS; j += 1) {
        if (list[j]!.sign <= 0 || list[j]!.on === list[i]!.on) continue;
        const pairs = out.get(account) ?? [];
        pairs.push([list[i]!.on, list[j]!.on]);
        out.set(account, pairs);
      }
    }
  }
  return out;
}

/**
 * ⭐ (F6 round 6) THE LAST DAY A RANGE'S PAIRING MUST READ: per account, the
 * first day after `after` that no possible reversal pair crosses (charge day <
 * cut ≤ credit day — `possibleReversalPairs`) — the rows from it on pair only
 * among themselves — less one; the latest of the accounts'. `after` when no
 * pair crosses (the usual case). `rows` must hold every pending row after
 * `after` (`reversalWindow` reads them).
 */
function forwardCleanCut(rows: readonly PendingRow[], after: number): number {
  let through = after;
  for (const pairs of possibleReversalPairs(rows).values()) {
    const spans = pairs.filter(([, credit]) => credit > after).sort((a, b) => a[0] - b[0]);
    let cut = after + 1;
    for (const [charge, credit] of spans) {
      if (charge + 1 > cut) break;
      if (credit >= cut) cut = credit + 1;
    }
    if (cut - 1 > through) through = cut - 1;
  }
  return through;
}

/**
 * Per account, the latest day in [earliest, latest] no POSSIBLE reversal pair
 * crosses (hold day < cut ≤ reversal day): (F6 round 4) a pending CHARGE and a
 * pending CREDIT of the same amount to the cent, the credit dated
 * 1–REVERSAL_MAX_DAYS days after the charge — (F6 round 5) a credit that can
 * be a reversal (`canBeReversal`: not a payment or a transfer). Every pair the rule can make is
 * among them (it also needs the hold expired and neither row replaced), so a
 * day clean of these is clean of the rule's pairs: the rows on or after it pair
 * only among themselves. Accounts with no crossing are absent. Null when some
 * account has no clean day in the span.
 */
function reversalCleanCuts(rows: readonly PendingRow[], earliest: number, latest: number): Map<string, number> | null {
  const crossed = new Map<string, Uint8Array>();
  for (const [account, pairs] of possibleReversalPairs(rows)) {
    for (const [charge, credit] of pairs) {
      const first = Math.max(charge + 1, earliest);
      const last = Math.min(credit, latest);
      if (first > last) continue;
      let days = crossed.get(account);
      if (!days) {
        days = new Uint8Array(latest - earliest + 1);
        crossed.set(account, days);
      }
      for (let d = first; d <= last; d += 1) days[d - earliest] = 1;
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
