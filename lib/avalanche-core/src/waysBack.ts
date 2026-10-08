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
import { addDaysISO, dayOfWeekISO } from "./householdTime";

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
  coverage: MovementCoverage;
  /** `spendAmount(row)` in whole cents: positive for an outflow, 0 otherwise. */
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
  /** The median weekly spend over the 8 weeks before, cents; null when none of them counts. */
  usualWeek: number | null;
}

export interface WaysBack {
  weekStart: string;
  weekEnd: string;
  overBy: number;
  daysLeft: number;
  hold: { perDay: number | null; leavesUntilPayday: number | null };
  trims: WaysBackTrim[];
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
  const counts = (r: WaysBackRow): r is WaysBackRow & { categoryId: string } =>
    r.categoryId != null && r.spendCents > 0 && WAYS_BACK_TRIM_COVERAGES.includes(r.coverage);
  const thisWeek = new Map<string, number>();
  for (const r of inputs.rows) {
    if (!counts(r) || r.date < position.weekStart || r.date > position.weekEnd) continue;
    thisWeek.set(r.categoryId, (thisWeek.get(r.categoryId) ?? 0) + r.spendCents);
  }
  const nameOf = (id: string) => inputs.categoryNames.get(id) ?? "";
  const top = [...thisWeek.entries()]
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
  for (const r of inputs.rows) {
    if (!counts(r) || !wanted.has(r.categoryId) || r.date >= position.weekStart) continue;
    const ws = addDaysISO(r.date, -dayOfWeekISO(r.date));
    if (!weekStarts.includes(ws)) continue;
    const key = `${ws}|${r.categoryId}`;
    perWeek.set(key, (perWeek.get(key) ?? 0) + r.spendCents);
  }
  const trims: WaysBackTrim[] = top.map((t) => ({
    categoryId: t.categoryId,
    name: t.name,
    spentWeek: t.spentWeek,
    usualWeek: medianCents(weekStarts.map((ws) => perWeek.get(`${ws}|${t.categoryId}`) ?? 0)),
  }));

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
    carryOver: {
      nextWeekStart,
      nextWeekCap: capCents == null ? null : Math.max(0, capCents + adjustmentCents),
      applied: applied != null,
      adjustment: applied,
    },
  };
}
