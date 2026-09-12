import { inForecast } from "@workspace/avalanche-core";
import type { CashEvent } from "./forecast";

export type Transaction = {
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  forecastFlag: boolean;
  categoryId?: string | null;
  source?: string;
  plaidAccountId?: string | null;
  /** A transfer between household accounts or a card payment. Still cash,
   *  still matchable to a planned payment — never swept into "not planned"
   *  by a bulk action. */
  isTransfer?: boolean;
};

/** True if a transaction belongs to a bank/checking-style account.
 *  Account metadata wins: a Plaid txn whose `plaidAccountId` matches a
 *  known checking/depository account is bank, regardless of source string.
 *  Otherwise: `amex`/`plaid:amex` are not bank; other Plaid txns without a
 *  matching checking account are credit-card-side and excluded.
 *  Manual rows default to bank — that's the primary flow for them. */
export function isBankTxn(
  txn: Pick<Transaction, "source" | "plaidAccountId">,
  checkingPlaidAccountIds: Set<string>,
): boolean {
  const s = (txn.source ?? "manual").toLowerCase();
  if (txn.plaidAccountId) {
    return checkingPlaidAccountIds.has(txn.plaidAccountId);
  }
  if (s === "amex" || s === "plaid:amex") return false;
  if (s.startsWith("plaid:")) return false;
  return true;
}

/** The exact filter Forecast uses to decide which transactions can reach
 *  the inbox / register / running balance. A txn is included iff it belongs
 *  to the configured Chase checking account (per `isBankTxn` semantics) AND
 *  is in the forecast per `inForecast` — it already happened (dated on or
 *  before `todayISO`), or it is a future row flagged for the forecast. The
 *  server's curve and review badge apply the same rule. Kept here so the page
 *  wiring and tests share a single source of truth — a regression in either
 *  side surfaces immediately. */
export function filterForecastTxns<
  T extends Pick<
    Transaction,
    "forecastFlag" | "source" | "plaidAccountId" | "occurredOn"
  >,
>(txns: T[], checkingPlaidAccountIds: Set<string>, todayISO: string): T[] {
  return txns.filter(
    (t) => inForecast(t, todayISO) && isBankTxn(t, checkingPlaidAccountIds),
  );
}

export type ResolutionStatus =
  | "matched"
  | "missed"
  | "dismissed"
  | "skipped"
  | "rescheduled"
  | "ignored_unforecasted"
  | "unplanned"
  /** (PR5) "Not this": one plan/row PAIR the user rejected. It decides
   *  neither the plan nor the row — both stay open. */
  | "not_match"
  /** (PR5) The row paid part of the plan; the remainder stays planned. */
  | "partial"
  /** (One-time bill move) A match or partial whose one-time bill was moved
   *  outside the matcher's window. Unresolved on both sides; shown as
   *  "Match needs review" until the user confirms or rejects the pair. */
  | "needs_review";

/** One pair from `CashSignal.matches` (PR5a), as the API sends it. */
export type CashSignalMatch = {
  /** `<itemId>|<occurrenceDate>` — the resolution key. */
  planKey: string;
  planItemId: string;
  /** The occurrence date resolutions are keyed on (before any reschedule). */
  planDate: string;
  txnId: string;
  planAmount: string | number;
  txnAmount: string | number;
  /** |txn| − |plan|: positive means more was paid than planned. */
  difference: string | number;
  /** txn date − plan date, in days: negative means paid early. */
  dayDelta: number;
  confidence: string;
  ambiguous: boolean;
  /** True only for pairs the server took OFF the curve (payee name in the
   *  row, not ambiguous, amounts close). Every other pair is a suggestion
   *  only: the plan still counts. Anything but `true` is treated as on the
   *  curve, so a missing flag can never hide a bill. */
  offCurve?: boolean;
};

/** A bank row the server paired with an open plan. Shown as "Suggested"
 *  until the user answers; only an `offCurve` pair is out of the forecast. */
export type ProbablyPaid = {
  txnId: string;
  /** Resolution key date — what Confirm / Not this / Partial post. */
  planDate: string;
  txnAmount: number;
  difference: number;
  dayDelta: number;
  confidence: string;
  ambiguous: boolean;
  /** The server's curve already leaves the plan out. */
  offCurve: boolean;
  txnDate: string;
  txnDescription: string | null;
  /** (One-time bill move) Not a server suggestion: a stored `needs_review`
   *  pair — a match whose bill was moved away from its row. Never off the
   *  curve; answered with the same Confirm / Not this. */
  needsReview?: boolean;
};

export type Resolution = {
  id: string;
  recurringItemId: string | null;
  occurrenceDate: string | null;
  status: string;
  matchedTxnId: string | null;
  rescheduledTo?: string | null;
  txnDate?: string | null;
  txnDescription?: string | null;
  txnAmount?: string | null;
  txnForecastFlag?: boolean | null;
};

export type PlanLineStatus =
  | "pending_plan"
  | "matched"
  | "missed"
  | "future"
  /** (PR5) Partly paid: `amount` is the unpaid remainder. */
  | "partial";
export type BankLineStatus = "pending_bank" | "matched" | "ignored_unforecasted";

export type PlanLine = {
  kind: "plan";
  date: string;
  itemId: string;
  label: string;
  /** Signed. For a `partial` line this is the REMAINDER still planned (0 once
   *  the shortfall is $1 or less), so every sum over plan lines agrees with the
   *  server's curve; the full planned amount is `plannedAmount`. */
  amount: number;
  status: PlanLineStatus;
  resolutionId?: string;
  matchedTxnId?: string | null;
  /** Original occurrence date when the row has been rescheduled. */
  originalDate?: string;
  /** (PR5) Set on an open (pending/upcoming) plan the server paired with a
   *  bank row. Off the server's curve only when `probablyPaid.offCurve`. */
  probablyPaid?: ProbablyPaid;
  /** (PR5) `partial` lines: the full planned amount. */
  plannedAmount?: number;
  /** (PR5) `partial` lines: the paying row's amount, when known. */
  paidAmount?: number | null;
};

export type BankLine = {
  kind: "bank";
  date: string;
  txn: Transaction;
  amount: number;
  status: BankLineStatus;
  resolutionId?: string;
  /** The status of the resolution that decided this row (`matched`,
   *  `partial`, `ignored_unforecasted`, `unplanned`). */
  resolutionStatus?: string;
  /** (PR5) The open plan the server says this pending row probably paid. */
  suggestedPlan?: PlanLine;
};

/**
 * (PR5) What a `partial` resolution leaves on the curve: plan − paid row.
 * Mirrors the server ledger (`buildForecastLedger`, "PROBABLY PAID"): a
 * remainder of $1 or less, or one that flips sign, leaves nothing; an unknown
 * paid amount leaves the whole plan.
 */
export function partialRemainder(
  planAmount: number,
  paidAmount: number | null | undefined,
): number {
  if (paidAmount == null || !Number.isFinite(paidAmount)) return planAmount;
  const remainder = Math.round((planAmount - paidAmount) * 100) / 100;
  if (Math.abs(remainder) <= 1 || Math.sign(remainder) !== Math.sign(planAmount)) {
    return 0;
  }
  return remainder;
}

/** (PR5) "Partial" is offered only when the row paid LESS than the plan and
 *  more than $1 would stay planned. */
export function canRecordPartial(plan: Pick<PlanLine, "amount">, pp: Pick<ProbablyPaid, "txnAmount">): boolean {
  if (Math.sign(pp.txnAmount) !== Math.sign(plan.amount)) return false;
  if (Math.abs(pp.txnAmount) >= Math.abs(plan.amount)) return false;
  return partialRemainder(plan.amount, pp.txnAmount) !== 0;
}

function toNum(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export type LineRow = (PlanLine | BankLine) & { runningBalance?: number };

const DAY = 86_400_000;

/**
 * Gate condition for the "inbox cleared" reconciled state. We only
 * fire when both:
 *   1. The pending-bank inbox is empty, and
 *   2. The forecast end balance reconciles to the live bank snapshot
 *      (so the user has fully closed the loop, not just hidden cards).
 */
export function shouldCelebrateClear(opts: {
  inboxCount: number;
  isReconciledToBank: boolean;
}): boolean {
  return opts.inboxCount === 0 && opts.isReconciledToBank;
}

function parseISO(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function monthKey(iso: string) {
  return iso.slice(0, 7);
}

function txnSigned(t: Transaction): number {
  return Number(t.amount) || 0;
}

export function buildLineRegister(opts: {
  events: CashEvent[];
  txns: Transaction[];
  resolutions: Resolution[];
  closedMonths: Set<string>;
  startBalance: number;
  fromISO: string;
  toISO: string;
  today?: Date;
  /** Optional snapshot anchor (YYYY-MM-DD). Items dated on/before this date are
   *  treated as already baked into startBalance and skipped from the running
   *  balance calculation. */
  snapshotISO?: string | null;
  /** Optional visible-window start (YYYY-MM-DD). When set, only plan/bank
   *  rows on/after this date are surfaced in the active register `rows`,
   *  while `allPlan`/`allBank` (and the running-balance accumulator that
   *  feeds them) keep using the wider [fromISO, toISO] window. Used by the
   *  Forecast page to hide stale prior-month bills from the register
   *  without losing access to last month's data for the month-close /
   *  rescheduled-bucket flows. Clamped to fromISO if earlier. */
  visibleFromISO?: string | null;
  /** When true, past-due *unresolved* plan occurrences (status
   *  `pending_plan`, i.e. dated on/before today with no match/skip/missed
   *  resolution) stay in the active register `rows` even when they fall
   *  before `visibleFromISO`. This makes overdue planned bills "linger"
   *  on the Review page until the user matches, skips, or marks them
   *  missed — instead of silently dropping off the moment today passes
   *  their date. The forward-looking /forecast (overall) view leaves this
   *  off so it stays a clean "what's coming" register. Default false. */
  lingerPastDuePlans?: boolean;
  /** (PR5) `CashSignal.matches`: plans a bank row probably paid. An open plan
   *  listed here carries `probablyPaid` and its row `suggestedPlan`. A pair the
   *  client already knows is decided (plan or row resolved, pair rejected) is
   *  ignored, so a cash signal older than the bundle can't resurrect it. */
  matches?: ReadonlyArray<CashSignalMatch> | null;
}): {
  rows: LineRow[];
  allPlan: PlanLine[];
  allBank: BankLine[];
  /** (PR5b) Pairs the user answered "Not this", as `<itemId>|<occurrenceDate>#<txnId>`.
   *  No suggestion — the server's or the client's — may offer one again. */
  rejectedPairs: ReadonlySet<string>;
} {
  const { events, txns, resolutions, closedMonths, startBalance, fromISO, toISO, snapshotISO, visibleFromISO, lingerPastDuePlans, matches } = opts;
  const today = opts.today ?? new Date();
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const fromMs = parseISO(fromISO);
  const toMs = parseISO(toISO);
  const anchorMs = snapshotISO ? parseISO(snapshotISO) : null;
  const visibleFromMs = visibleFromISO
    ? Math.max(parseISO(visibleFromISO), fromMs)
    : fromMs;

  // ⚠️ (PR5) "Not this" (`not_match`) answers are about one plan/row PAIR and
  // decide neither side, so they never enter the per-plan / per-row maps. The
  // server keeps them alongside the real decision (a rejection survives a later
  // match of either side), so letting them in would make "last write wins"
  // hide a row's real match or ignore behind a rejection.
  //
  // A move and a decision can also coexist for one occurrence (a `partial`
  // keeps the `rescheduled` row), so moves are read into their own map: the
  // move sets the date, the decision the status.
  const byEventKey = new Map<string, Resolution>();
  const rescheduleByKey = new Map<string, Resolution>();
  const byTxn = new Map<string, Resolution>();
  const rejectedPairs = new Set<string>();
  const reviewByKey = new Map<string, Resolution>();
  const reviewTxnIds = new Set<string>();
  for (const r of resolutions) {
    if (r.status === "not_match") {
      if (r.recurringItemId && r.occurrenceDate && r.matchedTxnId) {
        rejectedPairs.add(`${r.recurringItemId}|${r.occurrenceDate}#${r.matchedTxnId}`);
      }
      continue;
    }
    // (One-time bill move) A `needs_review` pair decides neither side either:
    // the plan stays open (on the curve) and the row stays in Review. Both show
    // it as the pair to answer — "Match needs review" — in place of any server
    // suggestion.
    if (r.status === "needs_review") {
      if (r.recurringItemId && r.occurrenceDate && r.matchedTxnId) {
        reviewByKey.set(`${r.recurringItemId}|${r.occurrenceDate}`, r);
        reviewTxnIds.add(r.matchedTxnId);
      }
      continue;
    }
    if (r.recurringItemId && r.occurrenceDate) {
      const key = `${r.recurringItemId}|${r.occurrenceDate}`;
      if (r.status === "rescheduled") rescheduleByKey.set(key, r);
      else byEventKey.set(key, r);
    }
    if (r.matchedTxnId) byTxn.set(r.matchedTxnId, r);
  }

  const allBank: BankLine[] = txns.map((t) => {
    const stored = byTxn.get(t.id);
    let status: BankLineStatus;
    // A `partial` row paid (part of) a plan: it is decided, like a match.
    if (stored?.status === "matched" || stored?.status === "partial") status = "matched";
    else if (stored?.status === "ignored_unforecasted" || stored?.status === "unplanned")
      status = "ignored_unforecasted";
    else status = "pending_bank";
    return {
      kind: "bank" as const,
      date: t.occurredOn,
      txn: t,
      amount: txnSigned(t),
      status,
      resolutionId: stored?.id,
      resolutionStatus: stored?.status,
    };
  });
  const bankById = new Map(allBank.map((b) => [b.txn.id, b]));
  const txnById = new Map(txns.map((t) => [t.id, t]));

  // (PR5) Server pairs, one to one. A pair is dropped when the client already
  // knows better: the row is claimed by a resolution, or the pair was rejected.
  // (The plan side is checked below: only an open plan takes a suggestion.)
  const matchByPlanKey = new Map<string, CashSignalMatch>();
  const pairedTxnIds = new Set<string>();
  for (const m of matches ?? []) {
    if (matchByPlanKey.has(m.planKey) || pairedTxnIds.has(m.txnId)) continue;
    if (rejectedPairs.has(`${m.planKey}#${m.txnId}`)) continue;
    if (byTxn.has(m.txnId)) continue;
    // (One-time bill move) A row or plan in a `needs_review` pair carries that pair.
    if (reviewTxnIds.has(m.txnId) || reviewByKey.has(m.planKey)) continue;
    matchByPlanKey.set(m.planKey, m);
    pairedTxnIds.add(m.txnId);
  }

  const allPlan: PlanLine[] = events.flatMap((ev) => {
    const origKey = `${ev.itemId}|${ev.date}`;
    const moved = rescheduleByKey.get(origKey);
    const date = moved?.rescheduledTo ?? ev.date;
    // The decision on the occurrence's own key wins; a moved occurrence also
    // honours a decision keyed on its new date (the pre-PR5 lookup); with no
    // decision, the move itself is the stored resolution.
    const stored: Resolution | undefined =
      byEventKey.get(origKey) ??
      (moved?.rescheduledTo ? byEventKey.get(`${ev.itemId}|${date}`) : undefined) ??
      moved;
    // (#480) "Skip" from the Missed bucket: drop the occurrence entirely.
    // The row should not appear in the register, the bucket, or the
    // running-balance projection for the selected month. Backend cash
    // signal applies the same filter so chart math stays consistent.
    if (stored?.status === "skipped") return [];
    const evMs = parseISO(date);
    let status: PlanLineStatus;
    let amount = ev.amount;
    let plannedAmount: number | undefined;
    let paidAmount: number | null | undefined;
    if (stored?.status === "matched") status = "matched";
    else if (stored?.status === "missed" || stored?.status === "dismissed")
      status = "missed";
    else if (stored?.status === "partial") {
      // (PR5) Only the unpaid remainder stays planned — the server's rule.
      status = "partial";
      const paidTxn = stored.matchedTxnId ? txnById.get(stored.matchedTxnId) : undefined;
      paidAmount = paidTxn ? txnSigned(paidTxn) : toNum(stored.txnAmount);
      plannedAmount = ev.amount;
      amount = partialRemainder(ev.amount, paidAmount);
    } else if (evMs > todayMs) status = "future";
    else status = "pending_plan";

    let probablyPaid: ProbablyPaid | undefined;
    // (One-time bill move) The stored `needs_review` pair, when the plan is still
    // open and its row is not decided elsewhere. The row's own fields come from
    // the register when it is in the window, else from the bundle's join.
    const review = reviewByKey.get(origKey);
    if (review?.matchedTxnId && (status === "pending_plan" || status === "future")) {
      const bank = bankById.get(review.matchedTxnId);
      const txnDate = bank?.date ?? review.txnDate ?? null;
      const txnAmount = bank ? bank.amount : toNum(review.txnAmount);
      if ((!bank || bank.status === "pending_bank") && txnDate && txnAmount != null) {
        probablyPaid = {
          txnId: review.matchedTxnId,
          planDate: ev.date,
          txnAmount,
          difference: Math.round((Math.abs(txnAmount) - Math.abs(ev.amount)) * 100) / 100,
          dayDelta: Math.round((parseISO(txnDate) - parseISO(date)) / DAY),
          confidence: "review",
          ambiguous: false,
          offCurve: false,
          txnDate,
          txnDescription: bank?.txn.description ?? review.txnDescription ?? null,
          needsReview: true,
        };
      }
    }
    const m = matchByPlanKey.get(origKey);
    if (!probablyPaid && m && (status === "pending_plan" || status === "future")) {
      const bank = bankById.get(m.txnId);
      probablyPaid = {
        txnId: m.txnId,
        planDate: m.planDate,
        txnAmount: toNum(m.txnAmount) ?? 0,
        difference: toNum(m.difference) ?? 0,
        dayDelta: m.dayDelta,
        confidence: m.confidence,
        ambiguous: m.ambiguous,
        offCurve: m.offCurve === true,
        txnDate: bank?.date ?? addDaysISO(date, m.dayDelta),
        txnDescription: bank?.txn.description ?? null,
      };
    }
    return [{
      kind: "plan" as const,
      date,
      itemId: ev.itemId,
      label: ev.label,
      amount,
      status,
      resolutionId: stored?.id,
      matchedTxnId: stored?.matchedTxnId ?? null,
      originalDate: date !== ev.date ? ev.date : undefined,
      ...(probablyPaid ? { probablyPaid } : {}),
      ...(status === "partial" ? { plannedAmount, paidAmount: paidAmount ?? null } : {}),
    }];
  });
  for (const p of allPlan) {
    if (!p.probablyPaid) continue;
    const bank = bankById.get(p.probablyPaid.txnId);
    if (bank) bank.suggestedPlan = p;
  }

  const isHiddenByClosedMonth = (iso: string, isResolved: boolean) =>
    isResolved && closedMonths.has(monthKey(iso));

  // A partly-paid plan stays in the register while a remainder is planned.
  const activePlan = allPlan.filter(
    (p) =>
      (p.status === "pending_plan" ||
        p.status === "future" ||
        (p.status === "partial" && p.amount !== 0)) &&
      !isHiddenByClosedMonth(p.date, false),
  );
  const activeBank = allBank.filter(
    (b) => b.status === "pending_bank" && !isHiddenByClosedMonth(b.date, false),
  );

  const inWindow = (iso: string) => {
    const ms = parseISO(iso);
    return ms >= fromMs && ms <= toMs;
  };

  const bankInWindowAll = allBank.filter((b) => inWindow(b.date));
  bankInWindowAll.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  let bal = startBalance;
  const balanceByTxnId = new Map<string, number>();
  for (const b of bankInWindowAll) {
    // Items on/before snapshot anchor are already in the snapshot balance.
    if (anchorMs !== null && parseISO(b.date) <= anchorMs) {
      balanceByTxnId.set(b.txn.id, bal);
      continue;
    }
    bal = Math.round((bal + b.amount) * 100) / 100;
    balanceByTxnId.set(b.txn.id, bal);
  }

  const inVisibleWindow = (iso: string) => {
    const ms = parseISO(iso);
    return ms >= visibleFromMs && ms <= toMs;
  };
  const visibleBank = activeBank.filter((b) => inVisibleWindow(b.date));
  // (#751 — REVERTED in #803) The original #751 linger rule kept
  // every pending past-due plan visible forever so the user had to
  // explicitly resolve each one. The Forecast register has since
  // gone back to being a forward-looking "what's coming" view —
  // pre-visibleFromMs plans (typically pre-today) drop off the
  // register; the Review page (opt-in re-linger below) is where
  // still-owed past-due plans get resolved. The "Look Back"
  // control still lets the user pull `visibleFromMs` earlier on
  // demand.
  //
  // Opt-in re-linger (Review page): when `lingerPastDuePlans` is set, a
  // past-due *unresolved* plan (`pending_plan`) stays in the register even
  // if it's before `visibleFromMs`, so overdue bills hang on the Review
  // list until the user matches/skips/marks-missed them. `activePlan`
  // already excludes matched/skipped/missed rows, so this only re-surfaces
  // genuinely still-owed occurrences. `future` rows (dated after today) are
  // never lingered — only the upper-bound window applies to them.
  const visiblePlan = activePlan.filter((p) => {
    if (inVisibleWindow(p.date)) return true;
    // (PR5b) A past-due partly-paid plan lingers too while a remainder is
    // planned: the curve still carries that remainder forward.
    if (
      lingerPastDuePlans &&
      (p.status === "pending_plan" ||
        (p.status === "partial" && p.amount !== 0 && parseISO(p.date) <= todayMs)) &&
      parseISO(p.date) >= fromMs
    ) {
      return true;
    }
    return false;
  });

  const rows: LineRow[] = [];
  for (const b of visibleBank) {
    rows.push({ ...b, runningBalance: balanceByTxnId.get(b.txn.id) });
  }
  for (const p of visiblePlan) {
    rows.push(p);
  }
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "bank" ? -1 : 1;
    return 0;
  });

  if (bankInWindowAll.length === 0) {
    let proj = startBalance;
    for (const r of rows) {
      // (PR5) An off-curve pair's plan is out of the server's curve; its row
      // counts. A pair kept on the curve is a suggestion only and still counts.
      if (
        (anchorMs !== null && parseISO(r.date) <= anchorMs) ||
        (r.kind === "plan" && r.probablyPaid?.offCurve)
      ) {
        r.runningBalance = proj;
        continue;
      }
      proj = Math.round((proj + r.amount) * 100) / 100;
      r.runningBalance = proj;
    }
  }

  return { rows, allPlan, allBank, rejectedPairs };
}

export function findCandidates(row: LineRow, rows: LineRow[], days = 7): LineRow[] {
  const targetMs = parseISO(row.date);
  const wantSign = Math.sign(row.amount);
  const wantKind = row.kind === "bank" ? "plan" : "bank";
  return rows
    .filter((r) => r.kind === wantKind)
    .filter((r) => {
      if (r.kind === "plan" && r.status !== "pending_plan" && r.status !== "future") return false;
      if (r.kind === "bank" && r.status !== "pending_bank") return false;
      if (Math.sign(r.amount) !== wantSign) return false;
      const dMs = Math.abs(parseISO(r.date) - targetMs);
      return dMs <= days * DAY;
    })
    .sort((a, b) => {
      const da = Math.abs(parseISO(a.date) - targetMs);
      const db = Math.abs(parseISO(b.date) - targetMs);
      if (da !== db) return da - db;
      const am = Math.abs(Math.abs(a.amount) - Math.abs(row.amount));
      const bm = Math.abs(Math.abs(b.amount) - Math.abs(row.amount));
      return am - bm;
    });
}

export type MatchConfidence = "high" | "medium" | "low";

export type PlanSuggestion = {
  plan: PlanLine;
  score: number;
  confidence: MatchConfidence;
  daysAway: number;
  amountDelta: number;
  labelMatch: boolean;
};

/** Suggest the most likely planned items for a single pending bank row.
 *  Pure function: signal is amount-sign + amount closeness + date proximity,
 *  with a small bonus if any 4+ char token from the plan's label appears in
 *  the bank description (case-insensitive). Lower score = better.
 *
 *  Confidence buckets:
 *   - high: exact amount (within $0.01) AND within 5 days, OR exact amount
 *           within 14 days WITH a label-token overlap.
 *   - medium: exact amount within `maxDays`, OR within 2% of amount and 7 days.
 *   - low: otherwise.
 *
 *  Returns up to `limit` suggestions sorted by score (best first). Filters
 *  out any plan whose status isn't `pending_plan` or `future`, and (PR5) any
 *  plan the server already paired with a row (`probablyPaid`) — that plan's
 *  one suggestion is the server's. Works for refunds/credits because we
 *  match on Math.sign of `amount`.
 */
export function suggestPlanMatchesForBank(
  bank: BankLine,
  planRows: PlanLine[],
  opts: { maxDays?: number; limit?: number } = {},
): PlanSuggestion[] {
  const maxDays = opts.maxDays ?? 14;
  const limit = opts.limit ?? 3;
  const wantSign = Math.sign(bank.amount);
  if (!wantSign) return [];
  const targetMs = parseISO(bank.date);
  const want = Math.abs(bank.amount);
  const desc = (bank.txn.description ?? "").toLowerCase();

  const out: PlanSuggestion[] = [];
  for (const p of planRows) {
    if (p.status !== "pending_plan" && p.status !== "future") continue;
    if (p.probablyPaid) continue;
    if (Math.sign(p.amount) !== wantSign) continue;
    const daysAway = Math.round(Math.abs(parseISO(p.date) - targetMs) / DAY);
    if (daysAway > maxDays) continue;

    const amountDelta = Math.round(Math.abs(Math.abs(p.amount) - want) * 100) / 100;
    const relDelta = want > 0 ? amountDelta / want : amountDelta;

    const tokens = (p.label ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    const labelMatch = tokens.some((t) => desc.includes(t));

    const score = amountDelta * 100 + daysAway - (labelMatch ? 2 : 0);

    let confidence: MatchConfidence;
    if (amountDelta < 0.01 && daysAway <= 5) confidence = "high";
    else if (amountDelta < 0.01 && labelMatch && daysAway <= maxDays) confidence = "high";
    else if (amountDelta < 0.01 && daysAway <= maxDays) confidence = "medium";
    else if (relDelta <= 0.02 && daysAway <= 7) confidence = "medium";
    else confidence = "low";

    out.push({ plan: p, score, confidence, daysAway, amountDelta, labelMatch });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, limit);
}

/**
 * (PR5) The client's own suggestions for each pending bank row — only where
 * the server has not already paired. A row the server paired (`suggestedPlan`)
 * gets none, and no plan the server paired is offered to any other row, so a
 * plan never carries two different suggestions. Manual matching (the dropdown,
 * drag) still reaches every open plan.
 */
export function buildClientSuggestions(
  bankRows: BankLine[],
  allPlan: PlanLine[],
  /** (PR5b) `buildLineRegister().rejectedPairs`. A pair the user answered
   *  "Not this" is never suggested again — not as a chip, a one-click Match,
   *  the Enter shortcut or "Match all confident". Confirming it would write
   *  `matched`, and the server would delete the rejection. */
  rejectedPairs: ReadonlySet<string> = new Set(),
): Map<string, PlanSuggestion[]> {
  const candidates = allPlan.filter(
    (p) => (p.status === "pending_plan" || p.status === "future") && !p.probablyPaid,
  );
  const out = new Map<string, PlanSuggestion[]>();
  for (const b of bankRows) {
    if (b.suggestedPlan) {
      out.set(b.txn.id, []);
      continue;
    }
    const open =
      rejectedPairs.size === 0
        ? candidates
        : candidates.filter(
            (p) => !rejectedPairs.has(`${p.itemId}|${p.originalDate ?? p.date}#${b.txn.id}`),
          );
    out.set(b.txn.id, suggestPlanMatchesForBank(b, open));
  }
  return out;
}

/** Rank ALL pending/future plan rows by how well they match a single
 *  bank row, returning a copy of the input sorted best-first. Used to
 *  pre-sort the "Match to…" dropdown so users don't have to scan a
 *  date-ordered list for the obvious match.
 *
 *  Scoring mirrors `suggestPlanMatchesForBank` (amount delta dominates,
 *  date proximity tiebreaks, label-token overlap nudges) but with no
 *  date-window filter so every candidate is reachable. Plans whose sign
 *  doesn't match the bank row are ranked last (in their original order)
 *  so callers can still expose them without losing the obvious filter.
 */
/** (#457) Trim the per-card "Choose a planned" dropdown to the items a
 *  user could realistically be matching this bank transaction to right
 *  now. Excludes:
 *    - plans dated before the first day of the current month (stale),
 *    - plans dated after `max(end of current month, today + 21d)` (so a
 *      late-month bank txn can still reach into early next month),
 *    - plans already matched to another bank transaction (defensive: the
 *      caller usually pre-filters to pending/future, but a stray
 *      `matchedTxnId` would still slip through that status check).
 *
 *  Date math is done in the same local-day basis the rest of forecast
 *  uses (parseISO drops to local midnight). `today` is injectable for
 *  tests; defaults to `new Date()`. */
export function filterDropdownPlans(
  plans: PlanLine[],
  today: Date = new Date(),
): PlanLine[] {
  const startOfMonth = new Date(
    today.getFullYear(),
    today.getMonth(),
    1,
  ).getTime();
  const endOfMonth = new Date(
    today.getFullYear(),
    today.getMonth() + 1,
    0,
  ).getTime();
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const threeWeeksOut = todayMidnight + 21 * DAY;
  const upperBound = Math.max(endOfMonth, threeWeeksOut);
  return plans.filter((p) => {
    if (p.matchedTxnId) return false;
    const ms = parseISO(p.date);
    return ms >= startOfMonth && ms <= upperBound;
  });
}

export function rankPlansForBank(
  bank: Pick<BankLine, "amount" | "date" | "txn">,
  plans: PlanLine[],
): PlanLine[] {
  const wantSign = Math.sign(bank.amount);
  const targetMs = parseISO(bank.date);
  const want = Math.abs(bank.amount);
  const desc = (bank.txn.description ?? "").toLowerCase();

  const scored = plans.map((p, idx) => {
    const sameSign = wantSign !== 0 && Math.sign(p.amount) === wantSign;
    const amountDelta = Math.abs(Math.abs(p.amount) - want);
    const daysAway = Math.abs(parseISO(p.date) - targetMs) / DAY;
    const tokens = (p.label ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    const labelMatch = tokens.some((t) => desc.includes(t));
    const score = amountDelta * 100 + daysAway - (labelMatch ? 2 : 0);
    return { p, idx, sameSign, score };
  });
  scored.sort((a, b) => {
    if (a.sameSign !== b.sameSign) return a.sameSign ? -1 : 1;
    if (a.score !== b.score) return a.score - b.score;
    return a.idx - b.idx;
  });
  return scored.map((s) => s.p);
}

/** Greedy bulk picker: from a map of bank txn id → ranked suggestions,
 *  return the set of (txnId, plan) pairs whose chosen suggestion is `high`
 *  confidence, ensuring no plan occurrence is assigned to two bank rows.
 *  When a bank row's best high-confidence pick collides with one already
 *  taken, it falls through to its next high-confidence suggestion (if any)
 *  instead of being dropped. Bank rows are processed in order of their
 *  current-best score so the strongest signals win the contested plans. */
export function pickConfidentBankMatches(
  bankSuggestions: Map<string, PlanSuggestion[]>,
): Array<{ txnId: string; plan: PlanLine; suggestion: PlanSuggestion }> {
  type Pending = { txnId: string; highs: PlanSuggestion[]; cursor: number };
  const pending: Pending[] = [];
  for (const [txnId, sugs] of bankSuggestions) {
    const highs = sugs.filter((s) => s.confidence === "high");
    if (highs.length > 0) pending.push({ txnId, highs, cursor: 0 });
  }
  const usedPlanKeys = new Set<string>();
  const usedTxnIds = new Set<string>();
  const out: Array<{ txnId: string; plan: PlanLine; suggestion: PlanSuggestion }> = [];

  // Iterate until no more pending row can claim a plan. Each pass picks the
  // pending row whose next-available suggestion has the lowest score.
  while (true) {
    let bestIdx = -1;
    let bestSug: PlanSuggestion | null = null;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (usedTxnIds.has(p.txnId)) continue;
      // Advance cursor past any taken plans.
      while (
        p.cursor < p.highs.length &&
        usedPlanKeys.has(
          `${p.highs[p.cursor].plan.itemId}|${p.highs[p.cursor].plan.date}`,
        )
      ) {
        p.cursor += 1;
      }
      if (p.cursor >= p.highs.length) continue;
      const sug = p.highs[p.cursor];
      if (!bestSug || sug.score < bestSug.score) {
        bestSug = sug;
        bestIdx = i;
      }
    }
    if (bestIdx === -1 || !bestSug) break;
    const winner = pending[bestIdx];
    const key = `${bestSug.plan.itemId}|${bestSug.plan.date}`;
    usedPlanKeys.add(key);
    usedTxnIds.add(winner.txnId);
    out.push({ txnId: winner.txnId, plan: bestSug.plan, suggestion: bestSug });
  }
  return out;
}

/** Per-card "obvious match" picker for the one-click Match button.
 *  A card qualifies iff (a) it has exactly ONE high-confidence suggestion
 *  (no on-card tie) AND (b) that plan key is not also a high-confidence
 *  suggestion of any OTHER pending bank card (no contest). Cards with no
 *  high-confidence suggestion, multiple high-confidence ties, or a plan
 *  contested by another card are intentionally excluded so the user still
 *  has to disambiguate via the dropdown / drag flow.
 *
 *  Returns a Map keyed by bank txn id → the single chosen suggestion. */
export function pickOneClickBankMatches(
  bankSuggestions: Map<string, PlanSuggestion[]>,
): Map<string, PlanSuggestion> {
  const planClaimCount = new Map<string, number>();
  for (const sugs of bankSuggestions.values()) {
    const seenOnThisCard = new Set<string>();
    for (const s of sugs) {
      if (s.confidence !== "high") continue;
      const key = `${s.plan.itemId}|${s.plan.date}`;
      if (seenOnThisCard.has(key)) continue;
      seenOnThisCard.add(key);
      planClaimCount.set(key, (planClaimCount.get(key) ?? 0) + 1);
    }
  }
  const out = new Map<string, PlanSuggestion>();
  for (const [txnId, sugs] of bankSuggestions) {
    const highs = sugs.filter((s) => s.confidence === "high");
    if (highs.length !== 1) continue;
    const only = highs[0];
    const key = `${only.plan.itemId}|${only.plan.date}`;
    if ((planClaimCount.get(key) ?? 0) > 1) continue;
    out.set(txnId, only);
  }
  return out;
}

export type BucketEntry = {
  id: string;
  status:
    | "matched"
    | "partial"
    | "missed"
    | "ignored_unforecasted"
    | "unplanned"
    | "rescheduled";
  date: string;
  label: string;
  amount: number;
  monthKey: string;
  recurringItemId?: string | null;
  occurrenceDate?: string | null;
  matchedTxnId?: string | null;
  /** Destination date for rescheduled entries (where the occurrence was moved to). */
  rescheduledTo?: string | null;
};

export function buildBucket(opts: {
  allPlan: PlanLine[];
  allBank: BankLine[];
  resolutions: Resolution[];
  closedMonths: Set<string>;
  monthFilter: string;
}): BucketEntry[] {
  const { allPlan, allBank, resolutions, closedMonths, monthFilter } = opts;
  if (closedMonths.has(monthFilter)) return [];

  const planByKey = new Map(allPlan.map((p) => [`${p.itemId}|${p.date}`, p]));
  // Plans whose original occurrence has been rescheduled live in `allPlan`
  // under their NEW date; we also need lookup by their ORIGINAL key so
  // bucket rows about the move can recover the plan's label/amount.
  const planByOriginalKey = new Map<string, PlanLine>();
  for (const p of allPlan) {
    const orig = p.originalDate ?? p.date;
    planByOriginalKey.set(`${p.itemId}|${orig}`, p);
  }
  const bankById = new Map(allBank.map((b) => [b.txn.id, b]));

  const out: BucketEntry[] = [];
  for (const r of resolutions) {
    // Rescheduled overrides: surface them in the bucket of the ORIGINAL
    // occurrence's month so users can review what they moved out and undo.
    if (r.status === "rescheduled") {
      if (!r.recurringItemId || !r.occurrenceDate || !r.rescheduledTo) continue;
      const mk = monthKey(r.occurrenceDate);
      if (mk !== monthFilter) continue;
      const p = planByOriginalKey.get(
        `${r.recurringItemId}|${r.occurrenceDate}`,
      );
      out.push({
        id: r.id,
        status: "rescheduled",
        date: r.occurrenceDate,
        label: p?.label ?? "",
        amount: p?.amount ?? 0,
        monthKey: mk,
        recurringItemId: r.recurringItemId,
        occurrenceDate: r.occurrenceDate,
        matchedTxnId: null,
        rescheduledTo: r.rescheduledTo,
      });
      continue;
    }

    let date: string | null = null;
    let label = "";
    let amount = 0;

    if (r.recurringItemId && r.occurrenceDate) {
      const key = `${r.recurringItemId}|${r.occurrenceDate}`;
      // A decision on a moved occurrence (a `partial` kept beside its
      // `rescheduled` row) is keyed on the ORIGINAL date.
      const p = planByKey.get(key) ?? planByOriginalKey.get(key);
      if (p) {
        date = p.date;
        label = p.label;
        // A partial's plan line carries the remainder; the bucket shows the
        // part that was settled — what the row actually paid when known (a
        // shortfall of $1 or less leaves no remainder, but was not paid in
        // full), else planned − remainder.
        amount =
          r.status === "partial" && p.plannedAmount != null
            ? p.paidAmount ?? Math.round((p.plannedAmount - p.amount) * 100) / 100
            : p.amount;
      } else {
        date = r.occurrenceDate;
      }
    } else if (r.matchedTxnId) {
      const b = bankById.get(r.matchedTxnId);
      if (b) {
        date = b.date;
        label = b.txn.description;
        amount = b.amount;
      } else if (r.txnDate) {
        date = r.txnDate;
        label = r.txnDescription ?? "";
        amount = Number(r.txnAmount) || 0;
      }
    }
    if (!date) continue;
    const mk = monthKey(date);
    if (mk !== monthFilter) continue;

    let status: BucketEntry["status"];
    if (r.status === "matched") status = "matched";
    else if (r.status === "partial") status = "partial";
    else if (r.status === "missed" || r.status === "dismissed") status = "missed";
    else if (r.status === "ignored_unforecasted") status = "ignored_unforecasted";
    else if (r.status === "unplanned") status = "unplanned";
    // (#480) `skipped` resolutions intentionally produce no bucket row —
    // a Skip from the Missed bucket should clear the occurrence entirely.
    else continue;

    out.push({
      id: r.id,
      status,
      date,
      label,
      amount,
      monthKey: mk,
      recurringItemId: r.recurringItemId,
      occurrenceDate: r.occurrenceDate,
      matchedTxnId: r.matchedTxnId,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}
