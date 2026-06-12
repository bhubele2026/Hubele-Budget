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
 *  the inbox / register / running balance. A txn is included iff it is
 *  flagged for forecast AND belongs to the configured Chase checking
 *  account (per `isBankTxn` semantics). Kept here so the page wiring and
 *  tests share a single source of truth — a regression in either side
 *  surfaces immediately. */
export function filterForecastTxns<
  T extends Pick<Transaction, "forecastFlag" | "source" | "plaidAccountId">,
>(txns: T[], checkingPlaidAccountIds: Set<string>): T[] {
  return txns.filter(
    (t) => t.forecastFlag && isBankTxn(t, checkingPlaidAccountIds),
  );
}

export type ResolutionStatus =
  | "matched"
  | "missed"
  | "dismissed"
  | "skipped"
  | "ignored_unforecasted"
  | "unplanned";

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

export type PlanLineStatus = "pending_plan" | "matched" | "missed" | "future";
export type BankLineStatus = "pending_bank" | "matched" | "ignored_unforecasted";

export type PlanLine = {
  kind: "plan";
  date: string;
  itemId: string;
  label: string;
  amount: number;
  status: PlanLineStatus;
  resolutionId?: string;
  matchedTxnId?: string | null;
  /** Original occurrence date when the row has been rescheduled. */
  originalDate?: string;
};

export type BankLine = {
  kind: "bank";
  date: string;
  txn: Transaction;
  amount: number;
  status: BankLineStatus;
  resolutionId?: string;
};

export type LineRow = (PlanLine | BankLine) & { runningBalance?: number };

const DAY = 86_400_000;

/**
 * Gate condition for the "inbox cleared" confetti celebration. We only
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
}): { rows: LineRow[]; allPlan: PlanLine[]; allBank: BankLine[] } {
  const { events, txns, resolutions, closedMonths, startBalance, fromISO, toISO, snapshotISO, visibleFromISO, lingerPastDuePlans } = opts;
  const today = opts.today ?? new Date();
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const fromMs = parseISO(fromISO);
  const toMs = parseISO(toISO);
  const anchorMs = snapshotISO ? parseISO(snapshotISO) : null;
  const visibleFromMs = visibleFromISO
    ? Math.max(parseISO(visibleFromISO), fromMs)
    : fromMs;

  const byEventKey = new Map<string, Resolution>();
  const byTxn = new Map<string, Resolution>();
  for (const r of resolutions) {
    if (r.recurringItemId && r.occurrenceDate) {
      byEventKey.set(`${r.recurringItemId}|${r.occurrenceDate}`, r);
    }
    if (r.matchedTxnId) byTxn.set(r.matchedTxnId, r);
  }

  const allPlan: PlanLine[] = events.flatMap((ev) => {
    const origKey = `${ev.itemId}|${ev.date}`;
    const origRes = byEventKey.get(origKey);
    let date = ev.date;
    let stored: Resolution | undefined = origRes;
    if (origRes?.status === "rescheduled" && origRes.rescheduledTo) {
      date = origRes.rescheduledTo;
      const atNew = byEventKey.get(`${ev.itemId}|${date}`);
      if (atNew && atNew.id !== origRes.id) stored = atNew;
    }
    // (#480) "Skip" from the Missed bucket: drop the occurrence entirely.
    // The row should not appear in the register, the bucket, or the
    // running-balance projection for the selected month. Backend cash
    // signal applies the same filter so chart math stays consistent.
    if (stored?.status === "skipped") return [];
    const evMs = parseISO(date);
    let status: PlanLineStatus;
    if (stored?.status === "matched") status = "matched";
    else if (stored?.status === "missed" || stored?.status === "dismissed")
      status = "missed";
    else if (evMs > todayMs) status = "future";
    else status = "pending_plan";
    return [{
      kind: "plan" as const,
      date,
      itemId: ev.itemId,
      label: ev.label,
      amount: ev.amount,
      status,
      resolutionId: stored?.id,
      matchedTxnId: stored?.matchedTxnId ?? null,
      originalDate: date !== ev.date ? ev.date : undefined,
    }];
  });

  const allBank: BankLine[] = txns.map((t) => {
    const stored = byTxn.get(t.id);
    let status: BankLineStatus;
    if (stored?.status === "matched") status = "matched";
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
    };
  });

  const isHiddenByClosedMonth = (iso: string, isResolved: boolean) =>
    isResolved && closedMonths.has(monthKey(iso));

  const activePlan = allPlan.filter(
    (p) =>
      (p.status === "pending_plan" || p.status === "future") &&
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
  // explicitly resolve each one. With the Weekly Debrief now the
  // authoritative reconciliation surface, the Forecast register has
  // gone back to being a forward-looking "what's coming" view —
  // pre-visibleFromMs plans (typically pre-today) drop off the
  // register and live in the Debrief instead. The "Look Back"
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
    if (
      lingerPastDuePlans &&
      p.status === "pending_plan" &&
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
      if (anchorMs !== null && parseISO(r.date) <= anchorMs) {
        r.runningBalance = proj;
        continue;
      }
      proj = Math.round((proj + r.amount) * 100) / 100;
      r.runningBalance = proj;
    }
  }

  return { rows, allPlan, allBank };
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
 *  out any plan whose status isn't `pending_plan` or `future`. Works for
 *  refunds/credits because we match on Math.sign of `amount`.
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
      const p = planByKey.get(`${r.recurringItemId}|${r.occurrenceDate}`);
      if (p) {
        date = p.date;
        label = p.label;
        amount = p.amount;
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
