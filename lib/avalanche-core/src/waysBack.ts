// ⭐ (V5) A WAY BACK WHEN THE WEEK IS OVER — computed, never suggested by a model.
//
// The week ran over its cap (or is about to). This answers, in code only:
//
//   overBy        how far past the cap the week is: max(0, −remainingWeek).
//                 0 when the week is not over (or has no cap).
//   daysLeft      days left in the Sunday–Saturday week, today included (1–7).
//   hold.perDay   what is left of the week spread evenly over the days left:
//                 floor(max(0, remainingWeek) ÷ daysLeft), whole cents —
//                 rounded DOWN, so it may read low, never high. null with no cap.
//   hold.leavesUntilPayday
//                 the position's `availableUntilPayday`, unchanged (null with
//                 no bank data — never a false zero).
//   trims         the three categories this week spent most on, among the rows
//                 that count against the cap (`allowance_weekly` and spend not
//                 yet filed, `needs_classification` — the same rows the
//                 position's `spentWeekDiscretionary` sums) that carry a
//                 category. Each with `usualWeek`: the MEDIAN of that
//                 category's spend in each of the 8 weeks before this one (a
//                 week with none counts as 0; a week that starts before the
//                 household's tracking start is not counted; the median of an
//                 even count is the lower-rounded mean of the middle two).
//                 Biggest spend first; ties by name, then id. Rows with no
//                 category are never a trim (there is nothing to name).
//                 (Final #10) Quoted only when the category has rows in at
//                 least half of those weeks (`usualHistoryNeeded`); else null.
//                 ⭐ (F3) TO THE SAME WEEKDAY: the week is still running, so
//                 each of the 8 weeks is cut at today's weekday
//                 (`samePointInPeriod`: today Wednesday → that week's
//                 Sunday–Wednesday) before the median; `usualFullWeek` keeps
//                 the whole-week median beside it. `usualBasis` is always
//                 "same_days" and `usualThrough` is today.
//                 ⭐ (S6) REFUNDS NET, as the week's figure nets them: a row is
//                 `allowanceRowOf`'s (a refund in the coverage it nets, its
//                 credit negative), so a category's spend is purchases less
//                 refunds — signed, exactly as the period breakdown's category
//                 amounts and `usual` sum them. A category that nets to 0 or
//                 less this week is not a trim (there is nothing to cut).
//   carryOver     next week, if the household takes the overage out of it:
//                 nextWeekCap = max(0, next week's cap + adjustment), where the
//                 adjustment is the one already applied (`plan_adjustments`),
//                 or −overBy when none is. null with no cap next week.
//
// Pure and dependency-free: the server loads the rows (`weekAdjustments.ts`)
// and the position (`computePosition`); every sum is here, in whole cents.
// Nothing under `src/ai` may import this module (weekAdjustmentsLaws.test.ts).
//
// ⚠️ Every money figure in the answer is an INTEGER NUMBER OF CENTS.

import type { MoneyPosition } from "./availableToSpend";
import type { MovementCoverage } from "./householdMoney";
import { addDaysISO, dayOfWeekISO, samePointInPeriod } from "./householdTime";

/**
 * (Q1) The fewest prior periods holding rows of a category before its usual is
 * quoted. The period breakdown re-exports it (`USUAL_MIN_HISTORY_PERIODS`): one
 * threshold for "Why over?" and the ways back. Defined here because the
 * breakdown imports this module (`medianCents`), never the reverse.
 */
export const USUAL_MIN_HISTORY_PERIODS = 2;

/**
 * ⭐ (Final #10) A USUAL NEEDS REAL HISTORY. The median runs over every period
 * of the window (8 weeks, 3 months, after tracking began) with an empty one
 * counting 0, so a category with rows in 2 of 8 weeks read "usual $0.00 ·
 * above usual" — the old symptom, for categories that cleared the floor. The
 * usual is quoted only when the category has rows in at least HALF of the
 * window's periods, and never fewer than `USUAL_MIN_HISTORY_PERIODS`:
 * 8 weeks → 4, 3 months → 2, a 3-week window (tracking began then) → 2.
 * Below it `usual` is null: "Not enough history". One rule for "Why over?"
 * (`periodBreakdown`) and the ways back.
 */
export function usualHistoryNeeded(windowPeriods: number): number {
  return Math.max(USUAL_MIN_HISTORY_PERIODS, Math.ceil(windowPeriods / 2));
}

/** (Final #10) Does a category with rows in `historyPeriods` of `windowPeriods` periods get a usual? */
export function hasUsualHistory(historyPeriods: number, windowPeriods: number): boolean {
  return historyPeriods >= usualHistoryNeeded(windowPeriods);
}

/** How many trims the answer offers. */
export const WAYS_BACK_TRIMS = 3;
/** How many weeks before this one set a category's usual week. */
export const WAYS_BACK_USUAL_WEEKS = 8;
/** The coverages that count against the weekly cap — the only rows a trim can come from. */
export const WAYS_BACK_TRIM_COVERAGES: readonly MovementCoverage[] = ["allowance_weekly", "needs_classification"];

/** One classified row of this week or the 8 before it, sized in whole cents. */
export interface WaysBackRow {
  /** `YYYY-MM-DD`. */
  date: string;
  categoryId: string | null;
  /** (S6) `allowanceRowOf(row, m).coverage`: for a refund, the coverage it nets. */
  coverage: MovementCoverage;
  /**
   * (S6) `allowanceRowOf(row, m).spend` in whole cents: + a purchase, − a
   * refund, 0 for anything else.
   */
  spendCents: number;
}

export interface WaysBackAdjustment {
  /** The Sunday of the week it lowers. */
  weekStart: string;
  /** Whole cents, negative. */
  amountCents: number;
  reason: string | null;
}

export interface WaysBackInputs {
  /** The money position for this week (`computePosition`'s answer). */
  position: Pick<MoneyPosition, "todayISO" | "weekStart" | "weekEnd" | "remainingWeek" | "availableUntilPayday">;
  /** Rows dated from 8 weeks before this week's Sunday through this week's Saturday. */
  rows: readonly WaysBackRow[];
  /** Category id → its name. */
  categoryNames: ReadonlyMap<string, string>;
  /** Weeks that start before this day are left out of the usual week. */
  trackingStart?: string | null;
  /** Next week's cap in whole cents (null with none) and the adjustment already applied to it. */
  nextWeek: { capCents: number | null; adjustment: WaysBackAdjustment | null };
}

export interface WaysBackTrim {
  categoryId: string;
  name: string;
  /** This week's spend in the category, cents. */
  spentWeek: number;
  /**
   * The median weekly spend over the 8 weeks before, cents; null when none of
   * them counts. (F3) Each week to today's weekday (see the header).
   */
  usualWeek: number | null;
  /** (F3) The median over the same 8 weeks, whole; null when none of them counts. */
  usualFullWeek: number | null;
  /**
   * (Q1) How many of those weeks hold rows of the category. (Final #10) Below
   * half of them (`usualHistoryNeeded`: 4 of 8, never fewer than 2)
   * `usualWeek` and `usualFullWeek` are null: "Not enough history", never a
   * $0 usual.
   */
  historyPeriods: number;
}

export interface WaysBack {
  weekStart: string;
  weekEnd: string;
  overBy: number;
  daysLeft: number;
  hold: { perDay: number | null; leavesUntilPayday: number | null };
  trims: WaysBackTrim[];
  /** (F3) The usual week is read to the same weekday: always "same_days" (the week is the current one). */
  usualBasis: "same_days";
  /** (F3) Today: each prior week is cut at its weekday. */
  usualThrough: string;
  carryOver: {
    nextWeekStart: string;
    nextWeekCap: number | null;
    applied: boolean;
    adjustment: WaysBackAdjustment | null;
  };
}

const toCents = (v: string | null): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** The median of whole-cent values; an even count takes the lower-rounded mean of the middle two. Null when empty. */
export function medianCents(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.floor((s[mid - 1]! + s[mid]!) / 2);
}

export function computeWaysBack(inputs: WaysBackInputs): WaysBack {
  const { position } = inputs;
  const remainingCents = toCents(position.remainingWeek);
  const overBy = remainingCents == null ? 0 : Math.max(0, -remainingCents);
  const daysLeft = 7 - dayOfWeekISO(position.todayISO);
  const perDay = remainingCents == null ? null : Math.floor(Math.max(0, remainingCents) / daysLeft);

  // ── Trims: this week's biggest categories among the rows that count against the cap.
  // (S6) Signed: a refund (negative) nets its category, as the week's figure nets it.
  const counts = (r: WaysBackRow): r is WaysBackRow & { categoryId: string } =>
    r.categoryId != null && r.spendCents !== 0 && WAYS_BACK_TRIM_COVERAGES.includes(r.coverage);
  const thisWeek = new Map<string, number>();
  for (const r of inputs.rows) {
    if (!counts(r) || r.date < position.weekStart || r.date > position.weekEnd) continue;
    thisWeek.set(r.categoryId, (thisWeek.get(r.categoryId) ?? 0) + r.spendCents);
  }
  const nameOf = (id: string) => inputs.categoryNames.get(id) ?? "";
  const top = [...thisWeek.entries()]
    .filter(([, spentWeek]) => spentWeek > 0) // (S6) fully refunded: nothing to trim
    .map(([categoryId, spentWeek]) => ({ categoryId, spentWeek, name: nameOf(categoryId) }))
    .sort((a, b) => b.spentWeek - a.spentWeek || a.name.localeCompare(b.name) || a.categoryId.localeCompare(b.categoryId))
    .slice(0, WAYS_BACK_TRIMS);

  // ── The usual week: each of the 8 weeks before this one that the household tracked.
  const weekStarts: string[] = [];
  for (let k = WAYS_BACK_USUAL_WEEKS; k >= 1; k--) {
    const start = addDaysISO(position.weekStart, -7 * k);
    if (inputs.trackingStart && start < inputs.trackingStart) continue;
    weekStarts.push(start);
  }
  const wanted = new Set(top.map((t) => t.categoryId));
  const perWeek = new Map<string, number>(); // `${weekStart}|${categoryId}` → cents
  const perWeekToDate = new Map<string, number>(); // (F3) each week to today's weekday
  for (const r of inputs.rows) {
    if (!counts(r) || !wanted.has(r.categoryId) || r.date >= position.weekStart) continue;
    const ws = addDaysISO(r.date, -dayOfWeekISO(r.date));
    if (!weekStarts.includes(ws)) continue;
    const key = `${ws}|${r.categoryId}`;
    perWeek.set(key, (perWeek.get(key) ?? 0) + r.spendCents);
    if (r.date <= samePointInPeriod("week", ws, position.todayISO)) {
      perWeekToDate.set(key, (perWeekToDate.get(key) ?? 0) + r.spendCents);
    }
  }
  const trims: WaysBackTrim[] = top.map((t) => {
    // (Q1) The weeks holding rows of the category (a key in `perWeek`).
    const historyPeriods = weekStarts.filter((ws) => perWeek.has(`${ws}|${t.categoryId}`)).length;
    // (Final #10) Rows in at least half the weeks (and 2+).
    const enough = hasUsualHistory(historyPeriods, weekStarts.length);
    return {
      categoryId: t.categoryId,
      name: t.name,
      spentWeek: t.spentWeek,
      usualWeek: enough ? medianCents(weekStarts.map((ws) => perWeekToDate.get(`${ws}|${t.categoryId}`) ?? 0)) : null,
      usualFullWeek: enough ? medianCents(weekStarts.map((ws) => perWeek.get(`${ws}|${t.categoryId}`) ?? 0)) : null,
      historyPeriods,
    };
  });

  // ── Carry-over: next week with the overage taken out (or the choice already made).
  const nextWeekStart = addDaysISO(position.weekStart, 7);
  const applied = inputs.nextWeek.adjustment;
  const capCents = inputs.nextWeek.capCents;
  const adjustmentCents = applied ? applied.amountCents : -overBy;
  return {
    weekStart: position.weekStart,
    weekEnd: position.weekEnd,
    overBy,
    daysLeft,
    hold: { perDay, leavesUntilPayday: toCents(position.availableUntilPayday) },
    trims,
    usualBasis: "same_days",
    usualThrough: position.todayISO,
    carryOver: {
      nextWeekStart,
      nextWeekCap: capCents == null ? null : Math.max(0, capCents + adjustmentCents),
      applied: applied != null,
      adjustment: applied,
    },
  };
}
