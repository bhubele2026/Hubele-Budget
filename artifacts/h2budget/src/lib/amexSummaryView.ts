import { classifyCardCredit, type CardRowKind, type SpendContext } from "@workspace/avalanche-core";
import type { AmexSummary, Category, Transaction } from "@workspace/api-client-react";
import { monthFirstISO, monthLastISO } from "@/components/account-page/month-navigator";
import { currentWeekRange, type RangeMode } from "@/lib/timeRange";
import { householdToday } from "@/lib/householdDay";
import { formatCurrency } from "@/lib/utils";

/**
 * (W4) Pure helpers behind the Amex page's summary: the period the summary
 * asks for, the plan line it prints, and which ledger rows a figure opens.
 * No money is computed here: every amount is the server's string.
 */

export type AmexFigure = "purchases" | "payments" | "credits";

type MonthKey = { year: number; month: number };
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;

/**
 * The summary's period from the page's controls: Week on the current month is
 * this Sun–Sat week; Week on any other month, and Month, is that month; Year is
 * that calendar year. The API refuses a `from` after today, so a period that
 * has not started yet asks for nothing (null).
 */
export function amexSummaryPeriod(
  mode: RangeMode,
  month: MonthKey,
  now: Date = new Date(),
): { from: string; to: string } | null {
  const today = householdToday(now);
  const thisMonth = today.slice(0, 7);
  const monthStr = `${month.year}-${pad(month.month + 1)}`;
  let from: string;
  let to: string;
  if (mode === "wk" && monthStr === thisMonth) {
    ({ from, to } = currentWeekRange(now));
  } else if (mode === "yr") {
    from = iso(month.year, 0, 1);
    to = iso(month.year, 11, 31);
  } else {
    from = monthFirstISO(month);
    to = monthLastISO(month);
  }
  if (from > today) return null;
  return { from, to };
}

export type AmexPlanLine =
  | { kind: "weekly_hook" | "monthly_hook"; label: string; amount: string | null; to: string; linkText: string }
  | { kind: "debt"; label: string; amount: string | null; to: string; linkText: string };

/** The plan comparison line, by `planLink.kind`; null for `none`. */
export function amexPlanLine(plan: AmexSummary["planLink"]): AmexPlanLine | null {
  switch (plan.kind) {
    case "weekly_hook":
      return { kind: "weekly_hook", label: "Saturday payoff", amount: plan.payoff ?? null, to: "/forecast", linkText: "Forecast" };
    case "monthly_hook":
      return { kind: "monthly_hook", label: "Monthly payoff", amount: plan.payoff ?? null, to: "/forecast", linkText: "Forecast" };
    case "debt":
      return { kind: "debt", label: "On the payoff plan: minimum", amount: plan.minimum ?? null, to: "/debts", linkText: "Debt" };
    default:
      return null;
  }
}

/** " (includes $Y unconfirmed)" when the server's unconfirmed part is above $0; nothing at $0. */
function unconfirmedWords(unresolved: string): string {
  return Math.round(Number(unresolved) * 100) > 0 ? ` (includes ${formatCurrency(unresolved)} unconfirmed)` : "";
}

/**
 * "Adds $560.00 to this week's household plan" — never the card's own budget.
 * (Q5) The amount is the plan's pool (weekly-flagged + unfiled), the cautious total, so the
 * unconfirmed part is said only when there is one. (hh-split) The part is the server's own split
 * of the same figure (`weeklyUnresolved` / `monthlyUnresolved`, GET /money/period-breakdown's
 * `unresolved` for the card): "(includes $Y unconfirmed)" at $Y > 0, nothing at $0. The monthly
 * part says it only when the monthly figure has one. Never a figure worked out here.
 */
export function householdLine(
  hc: AmexSummary["householdContribution"],
  mode: RangeMode,
  isThisWeek: boolean,
): string {
  const week = formatCurrency(hc.weeklyPlan);
  const weekUnconfirmed = unconfirmedWords(hc.weeklyUnresolved);
  if (mode === "wk" && isThisWeek) return `Adds ${week} to this week's household plan${weekUnconfirmed}`;
  return `Adds ${week} weekly${weekUnconfirmed} and ${formatCurrency(hc.monthlyPlan)} monthly${unconfirmedWords(hc.monthlyUnresolved)} to the household plan`;
}

/** A row's place on the card's ledger, by the server's own rule (classification only). */
export function amexRowKind(t: Transaction, categories: readonly Category[] | undefined): CardRowKind | null {
  const ctx: SpendContext = {
    categoriesById: new Map((categories ?? []).map((c) => [c.id, { name: c.name, debtId: null, kind: c.kind }])),
    debtCategoryIds: new Set(),
  };
  return classifyCardCredit(
    {
      amount: t.amount,
      source: t.source,
      isTransfer: t.isTransfer,
      categoryId: t.categoryId ?? null,
      description: t.description,
      debtId: t.debtId ?? null,
      isExternalCardPayment: t.isExternalCardPayment,
      reimbursable: t.reimbursable,
      pfcDetailed: t.pfcDetailed ?? null,
    },
    ctx,
    { reimbursableIsSpend: true },
  );
}

/** Does a ledger row belong to the figure the owner opened? */
export function rowInFigure(figure: AmexFigure, kind: CardRowKind | null): boolean {
  if (figure === "purchases") return kind === "purchase";
  if (figure === "payments") return kind === "payment";
  return kind === "refund" || kind === "other_credit";
}

export const FIGURE_WORDS: Record<AmexFigure, string> = {
  purchases: "Purchases",
  payments: "Payments",
  credits: "Credits & refunds",
};

/**
 * (P1) The Summary's title IS its period (the card is named once, in the
 * page's header): "This week · Oct 11 – 17", "October 2026", or "2026". Week
 * on another month reads as that month, as `amexSummaryPeriod` asks for it.
 */
export function summaryTitle(mode: RangeMode, month: MonthKey, now: Date = new Date()): string {
  const thisMonth = householdToday(now).slice(0, 7);
  const monthStr = `${month.year}-${pad(month.month + 1)}`;
  if (mode === "wk" && monthStr === thisMonth) return `This week · ${currentWeekRange(now).label}`;
  if (mode === "yr") return String(month.year);
  return monthWordsOf(month);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function monthWordsOf(m: MonthKey): string {
  return `${MONTH_NAMES[m.month] ?? ""} ${m.year}`.trim();
}
/** "October" for a month's link words. */
export function monthNameOf(m: MonthKey): string {
  return MONTH_NAMES[m.month] ?? "";
}

/**
 * Where the household link goes, for the period the Summary shows: this week's
 * page for the current week; any other period opens the month that holds it
 * (`?start=`: a month's first day; a year, the month holding its end).
 */
export function whyOverPath(
  mode: RangeMode,
  isThisWeek: boolean,
  period?: { from: string; to: string } | null,
  accountRowId?: string | null,
): string {
  // (T4) One card: Spending reads `?account=<plaid_accounts.id>` and shows that card's part.
  const acct = accountRowId ? `account=${encodeURIComponent(accountRowId)}` : "";
  if (mode === "wk" && isThisWeek) return acct ? `/spending/week?${acct}` : "/spending/week";
  const day = period ? (mode === "yr" ? period.to : period.from) : null;
  const qs = [day ? `start=${day}` : "", acct].filter(Boolean).join("&");
  return `/spending/month${qs ? `?${qs}` : ""}`;
}

/**
 * The plan's state for the household link, from the same rules Spending uses:
 * the spine's `knownWithinPlan` for this week, the month's own breakdown
 * (`plan.status`, `withinOfRemaining`) for a month. "loading" and "failed" are
 * their own states: neither is "no plan".
 */
export type OverLinkPlan = "loading" | "failed" | "none" | "over" | "set";

export type OverLinkInput =
  | { period: "year" }
  | {
      period: "week" | "month";
      /** "October" (a month), for "View October spending →". */
      monthName?: string;
      /** The current week or month: only it can be given a plan. */
      current: boolean;
      plan: OverLinkPlan;
      /** `useOwner()`: true, false or "unknown". */
      owner?: boolean | "unknown";
    };

export type OverLinkState = "over" | "within" | "set_plan" | "review" | "view" | "year";

/**
 * (P1) "Why are we over? →" only when the household IS over: a link that asks
 * why when nothing is over (or no plan is set) reads as an accusation.
 *   over                              → "Why are we over? →"
 *   set, not over                     → "View this week's spending →" / "View October spending →"
 *   no plan, current, the owner       → "Set a weekly plan →" / "Set a monthly plan →"
 *   no plan, current, anyone else     → "Review this week →" / "Review this month →"
 *   no plan on a past month, loading,
 *   or the plan read failed           → "View … spending →"
 *   a year                            → "View spending by month →"
 */
export function overLinkView(input: OverLinkInput): { text: string; state: OverLinkState } {
  if (input.period === "year") return { text: "View spending by month →", state: "year" };
  const week = input.period === "week";
  const view = week ? "View this week's spending →" : `View ${input.monthName ?? "this month's"} spending →`;
  if (input.plan === "over") return { text: "Why are we over? →", state: "over" };
  if (input.plan === "set") return { text: view, state: "within" };
  if (input.plan === "none" && input.current) {
    if (input.owner === true) return { text: week ? "Set a weekly plan →" : "Set a monthly plan →", state: "set_plan" };
    return { text: week ? "Review this week →" : "Review this month →", state: "review" };
  }
  return { text: view, state: "view" };
}
