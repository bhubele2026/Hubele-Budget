import { recurringItemsTable } from "@workspace/db";
import { nextBusinessDayISO } from "@workspace/avalanche-core";
import { buildForecastLedger, type ForecastLedger, type LedgerItem } from "./forecastLedger";
import type { EverydayHookFacts, LedgerEveryday } from "./everydayHooks";
import type { SnapshotAccountResolution } from "./resolveSnapshotAccount";

type Cadence =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "onetime";

type RecurringRow = typeof recurringItemsTable.$inferSelect;

export type CashEvent = {
  date: string;
  itemId: string;
  label: string;
  kind: "income" | "expense";
  amount: number;
};

export function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// (#751) Next business day (Mon-Fri). Used as the drag-forward target
// for past-due pending plans so the projected dip lands on a real
// posting day instead of a weekend. Saturday/Sunday roll to Monday.
export function nextBusinessDay(d: Date): Date {
  let cur = addDays(d, 1);
  while (cur.getDay() === 0 || cur.getDay() === 6) {
    cur = addDays(cur, 1);
  }
  return cur;
}

/** Sunday of the Sun–Sat week containing `date`. Accepts Date or YYYY-MM-DD. */
export function weekStartFor(date: Date | string): string {
  const d = typeof date === "string" ? parseISO(date) : new Date(date);
  const dow = d.getDay(); // 0 = Sunday
  const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  return fmtISO(sunday);
}

/** Saturday of the Sun–Sat week containing `date`. */
export function weekEndFor(date: Date | string): string {
  const sun = parseISO(weekStartFor(date));
  return fmtISO(addDays(sun, 6));
}

/**
 * (PR6) A one-time item dated before today.
 *
 * Before PR6 `archiveExpiredOneTime` set such an item inactive the day after its
 * date. It now keeps an unresolved one-time bill active for up to 60 days so the
 * forecast can drag, list or match it. Every other reader that counted only
 * active items (the Budget page plan, the Bills totals, the auto-bills category
 * heal, a debt's linked bill) treats it as archived, exactly as before.
 */
export function isPastOneTime(
  item: { frequency: string; anchorDate: string | null },
  todayISO: string,
): boolean {
  return item.frequency === "onetime" && item.anchorDate != null && item.anchorDate < todayISO;
}

function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
}

function setSafeDay(year: number, monthIdx: number, day: number): Date {
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return new Date(year, monthIdx, Math.min(day, lastDay));
}

export function expandItem(item: RecurringRow, from: Date, to: Date): CashEvent[] {
  if (item.active !== "true") return [];
  const out: CashEvent[] = [];
  const kind: "income" | "expense" = item.kind === "income" ? "income" : "expense";
  const sign = kind === "income" ? 1 : -1;
  const amt = Math.abs(Number(item.amount) || 0);
  const anchor = item.anchorDate ? parseISO(item.anchorDate) : from;

  const push = (d: Date) => {
    if (d < from || d > to) return;
    out.push({ date: fmtISO(d), itemId: item.id, label: item.name, kind, amount: sign * amt });
  };

  switch (item.frequency as Cadence) {
    case "onetime":
      push(anchor);
      break;
    case "weekly": {
      let cur = anchor;
      while (cur > from) cur = addDays(cur, -7);
      while (cur < from) cur = addDays(cur, 7);
      while (cur <= to) {
        push(cur);
        cur = addDays(cur, 7);
      }
      break;
    }
    case "biweekly": {
      let cur = anchor;
      while (cur > from) cur = addDays(cur, -14);
      while (cur < from) cur = addDays(cur, 14);
      while (cur <= to) {
        push(cur);
        cur = addDays(cur, 14);
      }
      break;
    }
    case "monthly": {
      const day = item.dayOfMonth ?? anchor.getDate();
      let y = from.getFullYear(),
        m = from.getMonth();
      const anchorFirst = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const fromFirst = new Date(from.getFullYear(), from.getMonth(), 1);
      if (anchorFirst > fromFirst) {
        y = anchor.getFullYear();
        m = anchor.getMonth();
      }
      let cur = setSafeDay(y, m, day);
      while (cur < from) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cur = setSafeDay(y, m, day);
      }
      while (cur <= to) {
        push(cur);
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cur = setSafeDay(y, m, day);
      }
      break;
    }
    case "semimonthly": {
      const d1 = item.dayOfMonth ?? anchor.getDate();
      const d2 = ((d1 + 14 - 1) % 30) + 1;
      let y = from.getFullYear(),
        m = from.getMonth();
      const days = [Math.min(d1, d2), Math.max(d1, d2)];
      while (true) {
        const a = setSafeDay(y, m, days[0]);
        const b = setSafeDay(y, m, days[1]);
        if (a > to && b > to) break;
        push(a);
        push(b);
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
      }
      break;
    }
    case "quarterly":
    case "annual": {
      const step = item.frequency === "quarterly" ? 3 : 12;
      const months = (from.getFullYear() - anchor.getFullYear()) * 12
        + from.getMonth() - anchor.getMonth();
      let occurrence = Math.floor(months / step);
      // Always calculate from the original anchor. Chaining clamped dates
      // permanently changes Jan 31 to the 30th, or Feb 29 to the 28th.
      let cur = addMonths(anchor, occurrence * step);
      while (cur < from) cur = addMonths(anchor, ++occurrence * step);
      while (cur <= to) {
        push(cur);
        cur = addMonths(anchor, ++occurrence * step);
      }
      break;
    }
  }
  return out;
}

export type CashSignal = {
  bankToday: string;
  lowestProjected: string;
  lowestDate: string | null;
  cashBuffer: string;
  status: "ready" | "tight" | "not_yet" | "no_data";
  maxSafeExtra: string;
  snapshotAt: string | null;
  snapshotSource: string | null;
  /**
   * (Decision 16, PR-K round 2) The account these figures roll forward on:
   * `resolveSnapshotAccount`'s answer, with that account's own name, mask and
   * subtype. Everything but `via` is null when it is `unresolved`. A screen
   * that names the account reads this, never a second source.
   */
  account: Pick<SnapshotAccountResolution, "name" | "mask" | "subtype" | "via">;
  horizonDays?: number;
  fromDate?: string;
  toDate?: string;
  startingBalance?: string;
  endingBalance?: string;
  endingDate?: string | null;
  projectedIncome?: string;
  projectedExpenses?: string;
  acceptedImpact?: string;
  /** End-of-day balances. With `views`, each day also carries the three views (`CashSignalDailyPoint`). */
  daily?: CashSignalDailyPoint[];
  /**
   * Per-day expense events (planned recurring + synthesized debt-min) that
   * land inside the projection window, with their bill name and signed
   * amount. The forecast chart uses this to mark big-bill days. Income
   * events and matched-out items are excluded — only entries that actually
   * dip the balance show up.
   *
   * `itemId` is the source recurring item id (or synthesized debt-min id),
   * which lets the chart deep-link a marker click to the matching plan row
   * in the register below.
   */
  events?: Array<{
    date: string;
    label: string;
    amount: string;
    itemId: string;
    originalDate: string;
    /**
     * (PR6) Why the plan is not on its due date: `overdue_assumed_unpaid`,
     * `overdue_remainder_assumed_unpaid` (PR6 review: a bank row paid part of it),
     * `due_today_not_posted`, `dragged_past_due` (weekly-cadence expenses due
     * before today, until PR8), `pre_window_on_first_day`, or (PR8r)
     * `amex_payoff_not_posted` (an everyday payoff whose period closed unpaid:
     * the owed charges only, next business day); null on its own date.
     */
    assumption: string | null;
    /** (PR6) `<itemId>|<occurrenceDate>` — the resolution key. */
    occurrenceKey: string;
    /** (PR6) The date resolutions are keyed on (before any reschedule). */
    occurrenceDate: string;
  }>;
  /** (PR6) Expenses overdue by more than 14 days: off the curve, never dropped silently. */
  overdueOutsideForecast?: CashSignalListedPlan[];
  /** (PR6) Income due before today that has not arrived (`income_not_arrived`): off the curve. */
  incomeNotArrived?: CashSignalListedPlan[];
  /** (PR6 review) Overdue expenses the forecast treats as paid by a bank row (never silent). */
  overdueAssumedPaid?: CashSignalAssumedPaidPlan[];
  /**
   * (PR5) Plans a bank row probably paid: each one is off the curve until the
   * user confirms ("matched"/"partial") or rejects ("not_match") it. Amounts are
   * signed like the ledger; `difference` is |txn| − |plan| (positive = paid more).
   */
  matches?: Array<{
    planKey: string;
    planItemId: string;
    planDate: string;
    txnId: string;
    planAmount: string;
    txnAmount: string;
    difference: string;
    dayDelta: number;
    confidence: string;
    ambiguous: boolean;
    /**
     * (Decision 13) What the pair proves: 1 explicit (a debt tag), 2 obligation
     * evidence (the bill's own category, its unique full name, or some of its name
     * paid exactly and promptly on checking), 3 a suggestion only.
     */
    tier: 1 | 2 | 3;
    /** Only these plans are off the curve (`tier ≤ 2`); every other match is a suggestion. */
    offCurve: boolean;
    /**
     * (Decision 13, round 3) Present only when the forecast counts the plan PAID by
     * this row (an overdue tier-1/2 pair, listed in `overdueAssumedPaid`): what is
     * still assumed unpaid, signed like the plan — "0.00" when paid in full. Only
     * that remainder stays on the curve; `offCurve` is false for an underpayment.
     */
    remainderAmount?: string;
  }>;
  /** (PR8r, `views` only) The everyday hooks for the week and month containing today. */
  everyday?: CashSignalEveryday;
  /**
   * (PR8r, `views` only) Income due today that has not arrived: "Expected today".
   * Off `balance`/`expected` (as before PR8r); `scheduled` counts it today.
   */
  incomeExpectedToday?: CashSignalListedPlan[];
};

/** One day's end-of-day balance; with `views`, the three views too (PR8r). */
export type CashSignalDailyPoint = {
  date: string;
  balance: string;
  /** (PR8r) Plans on their own due dates: an overdue bill listed, not dragged. */
  scheduled?: string;
  /** (PR8r) Always equal to `balance`. */
  expected?: string;
  /** (PR8r) Expected, with every planned income one business day later. */
  conservative?: string;
};

export type CashSignalEverydayHook = {
  status: "linked" | "unlinked" | "invalid";
  itemId: string | null;
  billAmount: string | null;
  allowanceAmount: string;
  discrepancy: boolean;
  periodStart: string;
  periodEnd: string;
  payoffDate: string;
  plan: string;
  spent: string;
  remaining: string;
  overage: string;
  unplanned: string;
  needsClassification: string;
  owed: string | null;
  payoff: string | null;
  payment: { txnId: string; date: string; amount: string } | null;
};

export type CashSignalEveryday = {
  weekly: CashSignalEverydayHook;
  monthly: CashSignalEverydayHook;
  billMatched: Array<{
    txnId: string;
    date: string;
    txnAmount: string;
    planKey: string | null;
    planLabel: string | null;
    planAmount: string | null;
    overage: string | null;
    conflict: string | null;
  }>;
};

export type CashSignalListedPlan = {
  planKey: string;
  itemId: string;
  occurrenceDate: string;
  dueDate: string;
  amount: string;
  label: string;
  daysOverdue: number;
};

export type CashSignalAssumedPaidPlan = {
  planKey: string;
  itemId: string;
  occurrenceDate: string;
  dueDate: string;
  label: string;
  daysOverdue: number;
  planAmount: string;
  txnId: string;
  txnAmount: string;
  confidence: string;
  unpaidRemainder: string;
};

function r2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Runway = days until the projected balance first goes negative; `null` when it
 * never does inside the window (which is the GOOD outcome, so a consumer must
 * render `null` as "no shortfall in view", never as zero days).
 *
 * ⚠️ THIS IS A MOVE, NOT A NEW CALCULATION. Transcribed line-for-line from
 * `artifacts/h2budget/src/pages/forecast-overview.tsx` (the `runwayDays` useMemo
 * + its local `daysBetween`), which is where this number is computed for the
 * screen that shows it today. It moves here so `/api/spine` can serve it
 * alongside the low point instead of shipping the whole 90-day `daily[]` series
 * to the client and having each page walk it again — the walks were already
 * drifting (command-center.tsx walks `/forecast`'s events from the snapshot
 * balance instead, a different answer from the same question).
 *
 * ⚠️ `Date.parse(d + "T00:00:00")` is LOCAL-time on purpose — it is what the
 * client does, and both endpoints of the subtraction are parsed the same way,
 * so the difference is timezone-invariant. Do not "fix" this to UTC in
 * isolation: it would silently put the server one day off from the page.
 */
export function runwayDaysFrom(
  daily: Array<{ date: string; balance: string }> | undefined,
): number | null {
  if (!daily || !daily.length) return null;
  const num = (v: string): number => {
    const n = parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : 0;
  };
  const daysBetween = (from: string, to: string): number => {
    const a = Date.parse(`${from}T00:00:00`);
    const b = Date.parse(`${to}T00:00:00`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.max(0, Math.round((b - a) / 86_400_000));
  };
  const first = daily[0].date;
  for (const d of daily) if (num(d.balance) < 0) return daysBetween(first, d.date);
  return null;
}

/**
 * Compute the cash signal: today's bank balance + projection of lowest balance.
 *
 * ⭐ THE LEDGER IS BUILT ELSEWHERE (PR4a). `buildForecastLedger` gathers the
 * anchor, every planned occurrence and every actual checking row — with the
 * snapshot-anchoring, resolution and drag rules documented there — and this
 * function only walks those items into the daily series and window stats.
 * `forecastLedger.golden.integration.test.ts` pins the full output recorded
 * before the extraction.
 */
export async function computeCashSignal(
  householdId: string,
  ownerUserId: string,
  opts: {
    horizonDays?: number;
    fromDate?: string;
    /**
     * (PR8r) Add the three views to `daily[]` (`scheduled`, `expected`,
     * `conservative`), the `everyday` block and `incomeExpectedToday`. Off, the
     * response has exactly its pre-PR8r shape — the spine and the other callers
     * read it that way. The CURVE itself does not depend on this: a linked hook's
     * payoffs are on it either way.
     */
    views?: boolean;
  } = {},
): Promise<CashSignal> {
  const ledger = await buildForecastLedger(householdId, ownerUserId, {
    horizonDays: opts.horizonDays,
    fromDate: opts.fromDate,
    everyday: opts.views === true,
  });
  const { items, fromISO, toISO, fromDateOnly, to, cashBuffer } = ledger;

  // Roll the balance forward from anchor up to (but not including) fromDate
  // so `startingBalance` reflects what the bank should be on the chart's
  // first day.
  let bal = ledger.startBalanceAtAnchor;
  for (const it of items) {
    if (it.date >= fromISO) break;
    bal = Math.round((bal + it.amount) * 100) / 100;
  }
  const startingBalance = bal;

  // Build daily series in [fromDate, toDate] and gather window stats.
  const totalDays = Math.round((to.getTime() - fromDateOnly.getTime()) / 86_400_000) + 1;
  const daily: Array<{ date: string; balance: string }> = [];
  let lowest = startingBalance;
  let lowestDate: string | null = null;
  let projectedIncome = 0;
  let projectedExpenses = 0;
  let acceptedImpact = 0;

  let cursor = 0;
  // Skip items before window (already applied above)
  while (cursor < items.length && items[cursor].date < fromISO) cursor++;

  for (let i = 0; i < totalDays; i++) {
    const d = addDays(fromDateOnly, i);
    const dISO = fmtISO(d);
    while (cursor < items.length && items[cursor].date <= dISO) {
      const it = items[cursor];
      bal = Math.round((bal + it.amount) * 100) / 100;
      if (it.amount > 0) projectedIncome += it.amount;
      else projectedExpenses += -it.amount;
      if (it.kind === "actual" && it.matched) acceptedImpact += it.amount;
      cursor++;
    }
    if (bal < lowest) {
      lowest = bal;
      lowestDate = dISO;
    }
    daily.push({ date: dISO, balance: r2(bal) });
  }
  const endingBalance = bal;
  const endingDate = toISO;

  const headroom = Math.max(0, lowest - cashBuffer);
  let status: CashSignal["status"];
  if (ledger.snapshotBalance == null) status = "no_data";
  else if (lowest >= cashBuffer + 200) status = "ready";
  else if (lowest >= cashBuffer) status = "tight";
  else status = "not_yet";

  // The chart's markers: planned expenses that actually drag the balance down
  // (negative, not matched out), in date order. `originalDate !== date` marks a
  // plan the curve moved off its due date: a past-due plan dragged forward
  // (#650), or, without a snapshot, a plan due before the window placed on its
  // first day. The ledger item's `assumption` says which.
  const expenseEvents = items.filter(
    (it): it is Extract<typeof it, { kind: "plan" }> => it.kind === "plan" && it.amount < 0,
  );

  return {
    bankToday: r2(ledger.bankToday),
    lowestProjected: r2(lowest),
    lowestDate,
    cashBuffer: r2(cashBuffer),
    status,
    maxSafeExtra: r2(headroom),
    snapshotAt: ledger.snapshotAt ? ledger.snapshotAt.toISOString() : null,
    snapshotSource: ledger.snapshotSource,
    account: {
      name: ledger.snapshotAccount.name,
      mask: ledger.snapshotAccount.mask,
      subtype: ledger.snapshotAccount.subtype,
      via: ledger.snapshotAccount.via,
    },
    horizonDays: ledger.daysAhead,
    fromDate: fromISO,
    toDate: toISO,
    startingBalance: r2(startingBalance),
    endingBalance: r2(endingBalance),
    endingDate,
    projectedIncome: r2(projectedIncome),
    projectedExpenses: r2(projectedExpenses),
    acceptedImpact: r2(acceptedImpact),
    daily: opts.views ? withViews(daily, ledger) : daily,
    events: expenseEvents
      .filter((e) => e.date >= fromISO && e.date <= toISO)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((e) => ({
        date: e.date,
        label: e.label,
        amount: r2(e.amount),
        itemId: e.itemId,
        originalDate: e.originalDate,
        assumption: e.assumption ?? null,
        occurrenceKey: `${e.itemId}|${e.occurrenceDate}`,
        occurrenceDate: e.occurrenceDate,
      })),
    matches: ledger.matches.map((m) => {
      const remainder = ledger.remainderByPlanKey.get(m.planKey);
      return {
        planKey: m.planKey,
        planItemId: m.planItemId,
        planDate: m.planDate,
        txnId: m.txnId,
        planAmount: r2(m.planAmount),
        txnAmount: r2(m.txnAmount),
        difference: r2(m.difference),
        dayDelta: m.dayDelta,
        confidence: m.confidence,
        ambiguous: m.ambiguous,
        tier: m.tier,
        offCurve: m.offCurve,
        ...(remainder !== undefined ? { remainderAmount: r2(remainder) } : {}),
      };
    }),
    overdueOutsideForecast: ledger.overdueOutsideForecast.map(listedPlan),
    incomeNotArrived: ledger.incomeNotArrived.map(listedPlan),
    overdueAssumedPaid: ledger.overdueAssumedPaid.map((p) => ({
      planKey: p.planKey,
      itemId: p.itemId,
      occurrenceDate: p.occurrenceDate,
      dueDate: p.dueDate,
      label: p.label,
      daysOverdue: p.daysOverdue,
      planAmount: r2(p.planAmount),
      txnId: p.txnId,
      txnAmount: r2(p.txnAmount),
      confidence: p.confidence,
      unpaidRemainder: r2(p.unpaidRemainder),
    })),
    ...(opts.views
      ? {
          ...(ledger.everyday ? { everyday: everydayOut(ledger.everyday) } : {}),
          incomeExpectedToday: ledger.incomeExpectedToday.map(listedPlan),
        }
      : {}),
  };
}

// ── (PR8r, plan section A) The three views ──────────────────────────────────

/** The plans a dragged overdue bill carries: listed in Scheduled, never dragged there. */
const OVERDUE_DRAGS: ReadonlySet<string> = new Set([
  "overdue_assumed_unpaid",
  "overdue_remainder_assumed_unpaid",
  "dragged_past_due",
]);

/**
 * SCHEDULED: every plan on its own due date. A bill overdue before today is listed
 * (it is still in `events`, with its assumption), not dragged; a bill due today
 * stays on today; income due today that has not arrived counts today. The
 * everyday payoffs are the same as in Expected.
 */
function scheduledItems(ledger: ForecastLedger): LedgerItem[] {
  const out: LedgerItem[] = [];
  for (const it of ledger.items) {
    if (it.kind === "actual" || it.everyday) {
      out.push(it);
    } else if (it.assumption && OVERDUE_DRAGS.has(it.assumption)) {
      continue;
    } else if (it.assumption === "due_today_not_posted") {
      out.push({ ...it, date: it.originalDate });
    } else {
      out.push(it);
    }
  }
  for (const p of ledger.incomeExpectedToday) {
    out.push({
      kind: "plan",
      eventKind: "income",
      date: p.dueDate,
      originalDate: p.dueDate,
      occurrenceDate: p.occurrenceDate,
      amount: p.amount,
      itemId: p.itemId,
      label: p.label,
    });
  }
  return out;
}

/** CONSERVATIVE: Expected, with every planned income one business day later. The payoffs stay put. */
function conservativeItems(ledger: ForecastLedger): LedgerItem[] {
  return ledger.items.map((it) =>
    it.kind === "plan" && it.eventKind === "income" && it.amount > 0 ? { ...it, date: nextBusinessDayISO(it.date) } : it,
  );
}

/** End-of-day balances over the ledger's window, walked exactly as `computeCashSignal` walks `balance`. */
function walkDaily(items: readonly LedgerItem[], ledger: ForecastLedger): string[] {
  const sorted = [...items].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let bal = ledger.startBalanceAtAnchor;
  let cursor = 0;
  while (cursor < sorted.length && sorted[cursor]!.date < ledger.fromISO) {
    bal = Math.round((bal + sorted[cursor]!.amount) * 100) / 100;
    cursor++;
  }
  const totalDays = Math.round((ledger.to.getTime() - ledger.fromDateOnly.getTime()) / 86_400_000) + 1;
  const out: string[] = [];
  for (let i = 0; i < totalDays; i++) {
    const dISO = fmtISO(addDays(ledger.fromDateOnly, i));
    while (cursor < sorted.length && sorted[cursor]!.date <= dISO) {
      bal = Math.round((bal + sorted[cursor]!.amount) * 100) / 100;
      cursor++;
    }
    out.push(r2(bal));
  }
  return out;
}

/**
 * ⭐ (PR8r) THE THREE VIEWS on `daily[]`. The payoffs and the reserve are the same in
 * all three. `expected` IS `balance` — the curve every figure reads.
 */
function withViews(daily: Array<{ date: string; balance: string }>, ledger: ForecastLedger): CashSignalDailyPoint[] {
  const scheduled = walkDaily(scheduledItems(ledger), ledger);
  const conservative = walkDaily(conservativeItems(ledger), ledger);
  return daily.map((d, i) => ({
    date: d.date,
    balance: d.balance,
    scheduled: scheduled[i]!,
    expected: d.balance,
    conservative: conservative[i]!,
  }));
}

function everydayHookOut(f: EverydayHookFacts): CashSignalEverydayHook {
  return {
    status: f.status,
    itemId: f.itemId,
    billAmount: f.billAmount === null ? null : r2(f.billAmount),
    allowanceAmount: r2(f.allowanceAmount),
    discrepancy: f.discrepancy,
    periodStart: f.period.start,
    periodEnd: f.period.end,
    payoffDate: f.period.payoffDate,
    plan: r2(f.plan),
    spent: r2(f.spent),
    remaining: r2(f.remaining),
    overage: r2(f.overage),
    unplanned: r2(f.unplanned),
    needsClassification: r2(f.needsClassification),
    owed: f.owed === null ? null : r2(f.owed),
    payoff: f.payoff === null ? null : r2(f.payoff),
    payment: f.payment ? { txnId: f.payment.txnId, date: f.payment.occurredOn, amount: r2(f.payment.amount) } : null,
  };
}

function everydayOut(e: LedgerEveryday): CashSignalEveryday {
  return {
    weekly: everydayHookOut(e.weekly),
    monthly: everydayHookOut(e.monthly),
    billMatched: e.billMatched.map((m) => ({
      txnId: m.txnId,
      date: m.occurredOn,
      txnAmount: r2(m.txnAmount),
      planKey: m.planKey,
      planLabel: m.planLabel,
      planAmount: m.planAmount === null ? null : r2(m.planAmount),
      overage: m.overage === null ? null : r2(m.overage),
      conflict: m.conflict,
    })),
  };
}

function listedPlan(p: import("./forecastLedger").LedgerListedPlan): CashSignalListedPlan {
  return {
    planKey: p.planKey,
    itemId: p.itemId,
    occurrenceDate: p.occurrenceDate,
    dueDate: p.dueDate,
    amount: r2(p.amount),
    label: p.label,
    daysOverdue: p.daysOverdue,
  };
}
