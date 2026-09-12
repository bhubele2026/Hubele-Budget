import { recurringItemsTable } from "@workspace/db";
import { buildForecastLedger } from "./forecastLedger";

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
  horizonDays?: number;
  fromDate?: string;
  toDate?: string;
  startingBalance?: string;
  endingBalance?: string;
  endingDate?: string | null;
  projectedIncome?: string;
  projectedExpenses?: string;
  acceptedImpact?: string;
  daily?: Array<{ date: string; balance: string }>;
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
     * before today, until PR8) or `pre_window_on_first_day`; null on its own date.
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
  } = {},
): Promise<CashSignal> {
  const ledger = await buildForecastLedger(householdId, ownerUserId, opts);
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
    horizonDays: ledger.daysAhead,
    fromDate: fromISO,
    toDate: toISO,
    startingBalance: r2(startingBalance),
    endingBalance: r2(endingBalance),
    endingDate,
    projectedIncome: r2(projectedIncome),
    projectedExpenses: r2(projectedExpenses),
    acceptedImpact: r2(acceptedImpact),
    daily,
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
