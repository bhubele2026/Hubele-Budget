// ⭐ (S3) "WHY ARE WE OVER?" — ONE PERIOD'S ALLOWANCE, GROUPED. Pure.
//
// The owner's question: "Why are we over weekly and monthly?" This module
// answers it from the SAME classified rows the figures came from — never a
// second rule:
//
//   week   the weekly allowance: the cap's pool (weekly-flagged + unfiled),
//          exactly what `computePosition` counts as `spentWeekDiscretionary`;
//   month  the monthly allowance: monthly-flagged rows, exactly what the
//          Monthly Spend hook counts (`loadHookPayoffs`).
//
// Both figures are `allowanceSpentCents` over `allowanceRowOf` rows (refunds
// netted per account, never below zero). The breakdown groups those rows:
//
//   categories            rows filed to the plan (weekly / monthly flag), by
//                         category; a split row by its parts (each part keeps
//                         the parent's coverage and account; the parent is
//                         never counted again). Refunds are signed, so a
//                         category can net negative.
//   needsClassification   unfiled rows. They count against the WEEKLY cap
//                         (`countsAgainstPlan`); never against the monthly one,
//                         so for a month the group is empty.
//   refundFloorAdjustment actual − Σ groups (≥ 0): non-zero only where an
//                         account's refunds outran its purchases and the pool
//                         floored at 0 there.
//
//   Σ categories + needsClassification + refundFloorAdjustment === actual, to
//   the cent, always (asserted in code: a negative adjustment throws).
//
// ⭐ (F2) KNOWN vs UNRESOLVED — the owner: "the headline compares confirmed
// purchases only". The caller tags each row with the evidence rule's class
// (`classifyEvidence`); an UNRESOLVED row in the plan's pool (an unfiled row
// with contrary evidence: Plaid says loan payment / transfer / income, or the
// forecast suggests a bill) is set apart:
//
//   known       the pool WITHOUT the unresolved rows, netted exactly as
//               `actual` is (`allowanceSpentCents`: per account, never below
//               zero). The plan comparison (`remaining` / `over` /
//               `withinPlan`) reads it.
//   unresolved  actual − known: what the unresolved rows add to the figure
//               ("may add up to"). Its rows sum to amount + nettedByRefunds;
//               `nettedByRefunds` is non-zero only where a refund on the same
//               account outran that account's known purchases.
//   provisional unresolved > max($25, 5% of the plan).
//   excludedPayments  the confirmed payments and transfers in scope (money
//               out the rule already leaves out of spending) — informational.
//
//   known + unresolved === actual, to the cent, always. `actual` itself is
//   unchanged: it is still `computePosition`'s figure (the money position,
//   safe-to-spend and the spine keep counting unresolved rows — cautious).
//   For a month the pool is monthly-FLAGGED rows only, and a flag is the
//   household's own confirmation, so known === actual there.
//
// `usual` is the median of the category's amount over the prior periods
// (`medianCents`, the ways-back helper): 8 weeks for a week, 3 months for a
// month; a period with nothing counts as 0, a period before tracking began is
// left out, and with none left `usual` is null. ⭐ (Q1) With fewer than
// `USUAL_MIN_HISTORY_PERIODS` (2) of those periods holding rows of the
// category, `usual` / `usualFullPeriod` / `aboveUsual` are null and
// `historyPeriods` says how many there were ("Not enough history").
// ⭐ (Final #10) And fewer than HALF of them (`usualHistoryNeeded`: 4 of 8
// weeks, 2 of 3 months): rows in 2 of 8 weeks read "usual $0.00 · above
// usual" (six empty weeks counted 0) — now "Not enough history".
//
// ⭐ (F3) A FAIR "USUAL" FOR A PERIOD STILL RUNNING. Month-to-date against three
// FULL months always read "under usual", so "Why over?" showed nothing above
// usual. For the current period (`sameDaysThrough` = today) each prior period is
// cut at the same point (`samePointInPeriod`: the same weekday; the same day of
// the month, capped at that month's last day) and `usual` is the median of those
// to-date amounts; `usualFullPeriod` keeps the full-period median beside it, and
// `aboveUsual` reads the to-date one. A row ON the cut day counts; a refund dated
// after the cut does not (it nets the full period only). A past period is
// unchanged: full against full (`usualBasis` "full_period").

import {
  allowanceRemainingCents,
  allowanceSpentCents,
  allowanceTotals,
  type AllowanceRow,
  type MovementCoverage,
} from "./householdMoney";
import { addDaysISO, monthBounds, samePointInPeriod, weekBounds } from "./householdTime";
import { USUAL_MIN_HISTORY_PERIODS, hasUsualHistory, medianCents, usualHistoryNeeded } from "./waysBack";
import type { EvidenceClass } from "./evidenceRule";

export type BreakdownPeriod = "week" | "month";
export type BreakdownBasis = "weekly_allowance" | "monthly_allowance";

/** Prior periods `usual` reads: 8 weeks (as ways-back), 3 months. */
export const BREAKDOWN_USUAL_PERIODS: Readonly<Record<BreakdownPeriod, number>> = { week: 8, month: 3 };
/**
 * ⭐ (Q1) NOT ENOUGH HISTORY. A category's `usual` needs at least this many of
 * the prior periods it reads (`priorPeriodStarts`) to hold rows of that
 * category. Below it, `usual`, `usualFullPeriod` and `aboveUsual` are null and
 * `historyPeriods` says how many there were: a category new this week no longer
 * reads "Usual $0.00 · above usual". A category with enough history keeps its
 * real median — "0.00" included (a period with nothing still counts as 0).
 * The ways back's trims use the same threshold (`waysBack.ts`). (Final #10)
 * The threshold is also half of the window (`usualHistoryNeeded`).
 */
export { USUAL_MIN_HISTORY_PERIODS, hasUsualHistory, usualHistoryNeeded };
export const BREAKDOWN_ROWS_DEFAULT = 10;
export const BREAKDOWN_ROWS_MAX = 50;

interface BasisRule {
  basis: BreakdownBasis;
  cadence: "weekly" | "monthly";
  /** The coverage a row filed to this plan carries (after `allowanceRowOf`). */
  filed: MovementCoverage;
  /** The unfiled coverage that counts against this plan, or null when none does. */
  unfiled: MovementCoverage | null;
}

const RULES: Readonly<Record<BreakdownPeriod, BasisRule>> = {
  week: { basis: "weekly_allowance", cadence: "weekly", filed: "allowance_weekly", unfiled: "needs_classification" },
  month: { basis: "monthly_allowance", cadence: "monthly", filed: "allowance_monthly", unfiled: null },
};

export function breakdownBasisOf(period: BreakdownPeriod): BreakdownBasis {
  return RULES[period].basis;
}

/** The coverages a period's plan counts (what to fetch split parts for). */
export function breakdownCountedCoverages(period: BreakdownPeriod): MovementCoverage[] {
  const r = RULES[period];
  return r.unfiled ? [r.filed, r.unfiled] : [r.filed];
}

/** Is `iso` the first day of its period — a household Sunday, or the 1st of a month? */
export function isPeriodStart(period: BreakdownPeriod, iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || addDaysISO(iso, 0) !== iso) return false;
  return period === "week" ? weekBounds(iso).start === iso : monthBounds(iso).start === iso;
}

/** The period containing `iso`: its first and last day (inclusive). */
export function periodBoundsOf(period: BreakdownPeriod, iso: string): { start: string; end: string } {
  if (period === "week") return weekBounds(iso);
  const m = monthBounds(iso);
  return { start: m.start, end: m.end };
}

/**
 * The prior periods `usual` reads, oldest first: the 8 weeks (3 months) before
 * `start`, leaving out any that starts before `trackingStart` (ways-back's rule).
 */
export function priorPeriodStarts(period: BreakdownPeriod, start: string, trackingStart?: string | null): string[] {
  const n = BREAKDOWN_USUAL_PERIODS[period];
  const out: string[] = [];
  let s = start;
  for (let k = 0; k < n; k += 1) {
    s = period === "week" ? addDaysISO(s, -7) : monthBounds(addDaysISO(s, -1)).start;
    if (trackingStart && s < trackingStart) break;
    out.unshift(s);
  }
  return out;
}

/** A split part as `expandSplits` gives it. */
export interface BreakdownSplitPart {
  categoryId: string;
  amount: string | number;
}

/** One classified row of the period, in scope. */
export interface BreakdownRowInput<T> {
  /** Transaction id (ordering tie-break). */
  id: string;
  /** Household date. */
  date: string;
  /** `allowanceRowOf(row, m)`: the coverage it counts in (a refund carries what it nets), its signed spend, its account. */
  allowance: { coverage: MovementCoverage; spend: number; account: string };
  /** The row's own category (effective filing). */
  categoryId: string | null;
  /** Valid split parts (`expandSplits`: they add up to the row), or null. */
  splitParts: readonly BreakdownSplitPart[] | null;
  /**
   * (F2) The evidence rule's class for the row (`classifyEvidence`), or null /
   * omitted when the rule says nothing. Only `unresolved` changes anything:
   * such a row in the plan's pool counts in `unresolved`, not `known`.
   */
  evidenceClass?: EvidenceClass | null;
  /** Passed through to the output untouched. */
  item: T;
}

/** One row (or one split part) in a group. */
export interface BreakdownEntry<T> {
  id: string;
  date: string;
  /** What it adds to its group, whole cents: + a purchase, − a refund. */
  cents: number;
  /** The category it is grouped under (a split part's own category); null when none, or not one of the household's. */
  categoryId: string | null;
  /** The account it nets on (`netAccountOf`). */
  account: string;
  /** A split part: which one, of how many, and the parent's whole contribution. Null for a whole row. */
  splitPart: { index: number; count: number; parentCents: number } | null;
  item: T;
}

export interface BreakdownCategory<T> {
  categoryId: string | null;
  name: string | null;
  cents: number;
  /** cents ÷ actual in basis points (rounded); null when actual is 0. Negative for a category that nets negative. */
  shareBp: number | null;
  count: number;
  /**
   * Median over the prior periods (see the header); null with none. (F3) For the
   * current period, each prior period to the same point (`usualBasis`
   * "same_days"); for a past one, the full periods.
   */
  usualCents: number | null;
  /** (F3) Median over the prior FULL periods; null with none. Equals `usualCents` for a past period. */
  usualFullPeriodCents: number | null;
  /** max(0, cents − usual); null when `usual` is null. (F3) Against the to-date usual for the current period. */
  aboveUsualCents: number | null;
  /**
   * (Q1) How many of the prior periods `usual` reads hold rows of this category
   * (0 – 8 weeks, 0 – 3 months). (Final #10) Below half of them, and never
   * fewer than `USUAL_MIN_HISTORY_PERIODS` (`usualHistoryNeeded`), the three
   * usual figures are null: "Not enough history".
   */
  historyPeriods: number;
  rows: BreakdownEntry<T>[];
  truncated: boolean;
}

export interface BreakdownGroup<T> {
  cents: number;
  count: number;
  rows: BreakdownEntry<T>[];
  truncated: boolean;
  /** Do these rows count against this period's plan? Unfiled rows count against the weekly cap only. */
  countsAgainstPlan: boolean;
}

export interface PeriodBreakdownInputs<T> {
  period: BreakdownPeriod;
  /** The period's classified rows, in scope (an account's, or the household's). */
  rows: readonly BreakdownRowInput<T>[];
  /** The plan's cap in cents, or null when none is set (never 0). */
  planCents: number | null;
  /** (week) The household's carry-over for the week: negative cents, or null. */
  carryOverCents: number | null;
  /** The prior periods (`priorPeriodStarts`) and their rows, each tagged with its period's start. */
  history: {
    starts: readonly string[];
    rows: readonly (BreakdownRowInput<unknown> & { periodStart: string })[];
  };
  /** The household's categories: id → name. A category id not in it groups as "no category". */
  categoryNames: ReadonlyMap<string, string>;
  rowsPerGroup: number;
  /**
   * (F3) The current period's today: each prior period is then cut at the same
   * point (`samePointInPeriod`) for `usual`. Null / omitted for a past period
   * (full against full).
   */
  sameDaysThrough?: string | null;
}

/** (F3) How `usual` was read: the prior periods to the same point, or whole. */
export type UsualBasis = "same_days" | "full_period";

/** (F2) The unresolved rows in the plan's pool. */
export interface BreakdownUnresolvedGroup<T> {
  /** What they add to `actual`: actual − known (≥ 0). */
  cents: number;
  /** Σ rows − cents: what a refund on the same account already netted (usually 0). */
  nettedByRefundsCents: number;
  count: number;
  rows: BreakdownEntry<T>[];
  truncated: boolean;
}

export interface PeriodBreakdownCore<T> {
  basis: BreakdownBasis;
  planCents: number | null;
  carryOverCents: number | null;
  actualCents: number;
  /** (F2) The pool without its unresolved rows, netted as `actual` is. known + unresolved = actual. */
  knownCents: number;
  /** (F2) plan + carry-over − KNOWN (negative when over); null with no plan. */
  remainingCents: number | null;
  /** max(0, −remaining); null with no plan. */
  overCents: number | null;
  /** remaining ≥ 0; null with no plan. */
  withinPlan: boolean | null;
  /** (F2) unresolved > max($25, 5% of the plan). */
  provisional: boolean;
  categories: BreakdownCategory<T>[];
  needsClassification: BreakdownGroup<T>;
  /** (F2) The unresolved rows of the pool (a subset of `needsClassification`'s rows). */
  unresolved: BreakdownUnresolvedGroup<T>;
  /** (F2) Confirmed payments and transfers in scope: money out that is not spending. Informational. */
  excludedPayments: BreakdownGroup<T>;
  refundFloorAdjustmentCents: number;
  /** (F3) "same_days" for the current period, "full_period" for a past one. */
  usualBasis: UsualBasis;
  /** (F3) The current period's cut (today, YYYY-MM-DD) when `usualBasis` is "same_days"; null otherwise. */
  usualThrough: string | null;
  /** The period's other figures, netted the same way, in the same scope. */
  beside: {
    unplannedCents: number;
    /** The weekly pool (weekly-flagged + unfiled); null when it is `actual` (a week). */
    weeklyCents: number | null;
    /** Monthly-flagged; null when it is `actual` (a month). */
    monthlyCents: number | null;
    billMatchedCents: number;
    reimbursableCents: number;
  };
}

const toCents = (v: number | string): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/**
 * A row as it is grouped: whole, or (a valid split) one entry per part. Each
 * part keeps the row's account and coverage, carries the row's sign, and the
 * parts add up to the row's own contribution — or the row counts whole.
 */
export function breakdownEntriesOf<T>(
  row: BreakdownRowInput<T>,
  categoryNames: ReadonlyMap<string, string>,
): BreakdownEntry<T>[] {
  const cents = toCents(row.allowance.spend);
  const known = (id: string | null): string | null => (id && categoryNames.has(id) ? id : null);
  const base = { id: row.id, date: row.date, account: row.allowance.account, item: row.item };
  const parts = row.splitParts;
  if (parts && parts.length > 0 && cents !== 0) {
    const sign = cents < 0 ? -1 : 1;
    const partCents = parts.map((p) => sign * Math.abs(toCents(p.amount)));
    if (partCents.reduce((a, b) => a + b, 0) === cents) {
      return parts.map((p, index) => ({
        ...base,
        cents: partCents[index]!,
        categoryId: known(p.categoryId),
        splitPart: { index, count: parts.length, parentCents: cents },
      }));
    }
  }
  return [{ ...base, cents, categoryId: known(row.categoryId), splitPart: null }];
}

/** Largest first; never "the last purchase". Ties: newest, then id, then part. */
function byAmountDesc<T>(a: BreakdownEntry<T>, b: BreakdownEntry<T>): number {
  return (
    b.cents - a.cents ||
    (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
    (a.splitPart?.index ?? 0) - (b.splitPart?.index ?? 0)
  );
}

/** Σ of one coverage per account, never below zero there — `allowanceTotals`' own netting. */
function coverageNetCents(rows: readonly AllowanceRow[], coverage: string): number {
  const by = new Map<string, number>();
  for (const r of rows) {
    if (r.coverage !== coverage) continue;
    const key = r.account ?? "";
    by.set(key, (by.get(key) ?? 0) + toCents(r.spend));
  }
  let out = 0;
  for (const v of by.values()) out += Math.max(0, v);
  return out;
}

const NO_CATEGORY = "\u0000none";
const keyOf = (id: string | null): string => id ?? NO_CATEGORY;

/** A period's plan figures: what is left, how far over, and whether within. */
export interface AllowancePeriodFigures {
  /** plan + carry-over − actual (negative when over); null with no plan. */
  remainingCents: number | null;
  /** max(0, −remaining); null with no plan. */
  overCents: number | null;
  /** remaining ≥ 0; null with no plan. */
  withinPlan: boolean | null;
}

/**
 * ⭐ (S6) LEFT / OVER for a period's allowance — the breakdown's own figures
 * (`periodBreakdown` returns these), and the spine's `monthAllowance` reads
 * them through this same call, so no screen subtracts plan − actual itself.
 * No plan (null) is never $0: every figure is null.
 */
export function allowancePeriodFigures(
  planCents: number | null,
  carryOverCents: number | null,
  actualCents: number,
): AllowancePeriodFigures {
  if (planCents == null) return { remainingCents: null, overCents: null, withinPlan: null };
  const remainingCents = allowanceRemainingCents(planCents, carryOverCents ?? 0, actualCents);
  return { remainingCents, overCents: Math.max(0, -remainingCents), withinPlan: remainingCents >= 0 };
}

/** (F2) Unresolved rows make the comparison provisional above max($25, 5% of the plan). */
export const BREAKDOWN_PROVISIONAL_MIN_CENTS = 2500;
export const BREAKDOWN_PROVISIONAL_SHARE = 0.05;

/** (F2) Is the plan comparison provisional: unresolved > max($25, 5% of the plan)? With no plan, > $25. */
export function isProvisional(unresolvedCents: number, planCents: number | null): boolean {
  const share = planCents == null ? 0 : Math.round(Math.abs(planCents) * BREAKDOWN_PROVISIONAL_SHARE);
  return unresolvedCents > Math.max(BREAKDOWN_PROVISIONAL_MIN_CENTS, share);
}

/** (Q1) A row as the known / unresolved split reads it: its allowance row and the evidence rule's class. */
export interface EvidenceSplitRow {
  /** `allowanceRowOf(row, m)`: the coverage it counts in, its signed spend (dollars), its account. */
  allowance: { coverage: string; spend: number; account?: string };
  /** The evidence rule's class for the row (`classifyEvidence`), or null / omitted when it says nothing. */
  evidenceClass?: EvidenceClass | null;
}

/** (Q1) Is this row an UNRESOLVED outflow in the period's pool (it leaves `known`, it stays in `actual`)? */
export function isUnresolvedInPool(period: BreakdownPeriod, row: EvidenceSplitRow): boolean {
  const rule = RULES[period];
  const c = row.allowance.coverage;
  return row.evidenceClass === "unresolved" && (c === rule.filed || c === rule.unfiled) && row.allowance.spend > 0;
}

/**
 * ⭐ (Q1) THE ONE KNOWN / UNRESOLVED SPLIT (see `glossary.ts` for the words).
 * The period breakdown's `actual` / `known` / `unresolved` and the money
 * position's `spentWeekDiscretionary` / `knownWeek` / `unresolvedWeek` are this
 * call over the same rows, so the Spending page, the dashboard and Banking can
 * never quote two figures under one name:
 *   actual      the pool (`allowanceSpentCents`): cautious, unresolved included;
 *   known       the pool without its unresolved rows, netted the same way;
 *   unresolved  actual − known (≥ 0 by construction: removing outflows from a
 *               floored pool never raises it — a negative throws).
 */
export function evidenceSplitCents(
  rows: readonly EvidenceSplitRow[],
  period: BreakdownPeriod,
): { actualCents: number; knownCents: number; unresolvedCents: number } {
  const cadence = RULES[period].cadence;
  const actualCents = allowanceSpentCents(
    rows.map((r) => r.allowance),
    cadence,
  );
  const knownCents = allowanceSpentCents(
    rows.filter((r) => !isUnresolvedInPool(period, r)).map((r) => r.allowance),
    cadence,
  );
  const unresolvedCents = actualCents - knownCents;
  if (unresolvedCents < 0) {
    // Impossible by construction: removing outflows from a floored pool never raises it.
    throw new Error(`periodBreakdown: known (${knownCents}) exceeds the figure (${actualCents})`);
  }
  return { actualCents, knownCents, unresolvedCents };
}

/** (F2) The coverages a confirmed payment or transfer carries (money out the spending rule already leaves out). */
const PAYMENT_COVERAGES: ReadonlySet<MovementCoverage> = new Set<MovementCoverage>([
  "transfer",
  "debt_payment",
  "card_payment",
  "excluded",
  "bill_matched",
]);

/** ⭐ THE BREAKDOWN. See the file header. */
export function periodBreakdown<T>(inputs: PeriodBreakdownInputs<T>): PeriodBreakdownCore<T> {
  const rule = RULES[inputs.period];
  const limit = Math.max(1, Math.min(BREAKDOWN_ROWS_MAX, Math.floor(inputs.rowsPerGroup) || BREAKDOWN_ROWS_DEFAULT));
  const allowanceRows = inputs.rows.map((r) => r.allowance);

  // The figure itself, and (F2) its known / unresolved split: (Q1) the one
  // call the money position's week makes too (`evidenceSplitCents`).
  const { actualCents, knownCents, unresolvedCents } = evidenceSplitCents(inputs.rows, inputs.period);

  // ── Group the rows that count against the plan.
  const filedByCategory = new Map<string, BreakdownEntry<T>[]>();
  const unfiled: BreakdownEntry<T>[] = [];
  const unresolvedEntries: BreakdownEntry<T>[] = [];
  const paymentEntries: BreakdownEntry<T>[] = [];
  // (F2) The pool's rows that are unresolved: out of `known`, into `unresolved`.
  const inPool = (c: MovementCoverage): boolean => c === rule.filed || c === rule.unfiled;
  const isUnresolved = (row: BreakdownRowInput<T>): boolean => isUnresolvedInPool(inputs.period, row);
  for (const row of inputs.rows) {
    const coverage = row.allowance.coverage;
    if (PAYMENT_COVERAGES.has(coverage) && row.allowance.spend > 0) {
      paymentEntries.push(...breakdownEntriesOf({ ...row, splitParts: null }, inputs.categoryNames));
      continue;
    }
    if (!inPool(coverage)) continue;
    const unresolved = isUnresolved(row);
    for (const e of breakdownEntriesOf(row, inputs.categoryNames)) {
      if (unresolved) unresolvedEntries.push(e);
      if (coverage === rule.filed) {
        const k = keyOf(e.categoryId);
        const list = filedByCategory.get(k);
        if (list) list.push(e);
        else filedByCategory.set(k, [e]);
      } else {
        unfiled.push(e);
      }
    }
  }

  // ── The usual period, per category, from the prior periods' filed rows.
  // (F3) For the current period, also each prior period to the same point.
  const through = inputs.sameDaysThrough ?? null;
  const cutOf = new Map<string, string>(
    through ? inputs.history.starts.map((s) => [s, samePointInPeriod(inputs.period, s, through)] as const) : [],
  );
  const perPeriod = new Map<string, number>(); // `${periodStart}|${categoryKey}` → cents
  const perPeriodToDate = new Map<string, number>();
  for (const row of inputs.history.rows) {
    if (row.allowance.coverage !== rule.filed) continue;
    const cut = cutOf.get(row.periodStart);
    const toDate = cut !== undefined && row.date <= cut;
    for (const e of breakdownEntriesOf(row, inputs.categoryNames)) {
      const k = `${row.periodStart}|${keyOf(e.categoryId)}`;
      perPeriod.set(k, (perPeriod.get(k) ?? 0) + e.cents);
      if (toDate) perPeriodToDate.set(k, (perPeriodToDate.get(k) ?? 0) + e.cents);
    }
  }
  // (Q1) The prior periods holding rows of the category (a key in `perPeriod`
  // = at least one filed row there, whatever it sums to).
  const historyOf = (key: string): number => inputs.history.starts.filter((s) => perPeriod.has(`${s}|${key}`)).length;
  // (Final #10) Rows in at least half of the window's periods (and 2+).
  const enoughHistory = (key: string): boolean => hasUsualHistory(historyOf(key), inputs.history.starts.length);
  const medianOf = (by: ReadonlyMap<string, number>, key: string): number | null =>
    inputs.history.starts.length === 0 || !enoughHistory(key)
      ? null
      : medianCents(inputs.history.starts.map((s) => by.get(`${s}|${key}`) ?? 0));
  const usualFullOf = (key: string): number | null => medianOf(perPeriod, key);
  const usualOf = (key: string): number | null => (through ? medianOf(perPeriodToDate, key) : usualFullOf(key));

  const sum = (es: readonly BreakdownEntry<T>[]): number => es.reduce((a, e) => a + e.cents, 0);
  const categories: BreakdownCategory<T>[] = [...filedByCategory.entries()].map(([key, entries]) => {
    const categoryId = key === NO_CATEGORY ? null : key;
    const cents = sum(entries);
    const usualCents = usualOf(key);
    const sorted = [...entries].sort(byAmountDesc);
    return {
      categoryId,
      name: categoryId ? (inputs.categoryNames.get(categoryId) ?? null) : null,
      cents,
      shareBp: actualCents > 0 ? Math.round((cents * 10_000) / actualCents) : null,
      count: entries.length,
      usualCents,
      usualFullPeriodCents: usualFullOf(key),
      aboveUsualCents: usualCents == null ? null : Math.max(0, cents - usualCents),
      historyPeriods: historyOf(key),
      rows: sorted.slice(0, limit),
      truncated: sorted.length > limit,
    };
  });
  categories.sort(
    (a, b) =>
      b.cents - a.cents ||
      (a.name ?? "￿").localeCompare(b.name ?? "￿") ||
      (a.categoryId ?? "").localeCompare(b.categoryId ?? ""),
  );

  const unfiledSorted = [...unfiled].sort(byAmountDesc);
  const needsClassification: BreakdownGroup<T> = {
    cents: sum(unfiled),
    count: unfiled.length,
    rows: unfiledSorted.slice(0, limit),
    truncated: unfiledSorted.length > limit,
    countsAgainstPlan: rule.unfiled != null,
  };

  // ── The identity: Σ groups + floor adjustment = actual, to the cent.
  const grouped = categories.reduce((a, c) => a + c.cents, 0) + needsClassification.cents;
  const refundFloorAdjustmentCents = actualCents - grouped;
  if (refundFloorAdjustmentCents < 0) {
    // Impossible by construction (each account's pool floors at 0, never below
    // its own sum); a negative here means the groups and the figure diverged.
    throw new Error(`periodBreakdown: groups (${grouped}) exceed the figure (${actualCents})`);
  }

  // ── Plan, carry-over, remaining (S6: the one left/over helper the spine reads too).
  // (F2) Against KNOWN purchases: the owner's headline. `actual` stays the cautious figure.
  const planCents = inputs.planCents;
  const carryOverCents = inputs.carryOverCents;
  const { remainingCents, overCents, withinPlan } = allowancePeriodFigures(planCents, carryOverCents, knownCents);

  const unresolvedSorted = [...unresolvedEntries].sort(byAmountDesc);
  const unresolvedRowsCents = sum(unresolvedEntries);
  const paymentsSorted = [...paymentEntries].sort(byAmountDesc);

  const totals = allowanceTotals(allowanceRows);
  return {
    basis: rule.basis,
    planCents,
    carryOverCents,
    actualCents,
    knownCents,
    remainingCents,
    overCents,
    withinPlan,
    provisional: isProvisional(unresolvedCents, planCents),
    categories,
    needsClassification,
    unresolved: {
      cents: unresolvedCents,
      nettedByRefundsCents: unresolvedRowsCents - unresolvedCents,
      count: unresolvedEntries.length,
      rows: unresolvedSorted.slice(0, limit),
      truncated: unresolvedSorted.length > limit,
    },
    excludedPayments: {
      cents: sum(paymentEntries),
      count: paymentEntries.length,
      rows: paymentsSorted.slice(0, limit),
      truncated: paymentsSorted.length > limit,
      countsAgainstPlan: false,
    },
    refundFloorAdjustmentCents,
    usualBasis: through ? "same_days" : "full_period",
    usualThrough: through,
    beside: {
      unplannedCents: totals.unplannedCents,
      weeklyCents: rule.cadence === "weekly" ? null : totals.discretionaryCents,
      monthlyCents: rule.cadence === "monthly" ? null : totals.monthlyCents,
      billMatchedCents: coverageNetCents(allowanceRows, "bill_matched"),
      reimbursableCents: coverageNetCents(allowanceRows, "reimbursable"),
    },
  };
}
