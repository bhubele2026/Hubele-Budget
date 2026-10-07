// ⭐ (PR-B1) A REALISTIC WEEKLY CAP — what the plan leaves for everyday
// spending, worked out from the household's own plans and shown with its
// working. It is a SUGGESTION: only the owner sets the cap
// (`PUT /allowance-plans/:id`), and nothing automatic ever writes one.
//
//   takeHomeMonthly      Σ active income plans, as a monthly amount
//   committedMonthly     Σ active bills and subscriptions, as a monthly amount —
//                        except the "Weekly Spend" / "Monthly Spend" items that
//                        FUND the allowance (they are the allowance; counting
//                        them would subtract the allowance from itself) and any
//                        bill linked to a debt (its debt's minimum below stands
//                        for it, as the forecast does)
//   debtMinimumsMonthly  Σ active debts' minimum payments
//   extraMonthly         the Avalanche extra payment
//   goalsMonthly         money set aside for goals (0 until goals ship)
//   discretionaryMonthly = takeHome − committed − minimums − extra − goals
//   suggestedWeekly      = max(0, floor(discretionaryMonthly × 12/52 / 5) × 5)
//                          — per week, rounded DOWN to whole $5
//
// Monthly amounts: weekly × 52/12, biweekly × 26/12, semimonthly × 2,
// monthly × 1, quarterly ÷ 3, annual ÷ 12. A one-time plan is not a monthly
// amount and is left out. Each figure is summed exactly and rounded to the
// cent once. Pure and dependency-free.

/** Plan frequency → how many of it fall in an average month. */
export const MONTHLY_FACTORS: Readonly<Record<string, number>> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
};

/** The recurring items that fund the everyday allowance (matched by name, case and spacing ignored). */
export const EVERYDAY_FUNDING_ITEM_NAMES = ["weekly spend", "monthly spend"] as const;

export function isEverydayFundingItem(name: string | null | undefined): boolean {
  const n = (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return (EVERYDAY_FUNDING_ITEM_NAMES as readonly string[]).includes(n);
}

type Active = boolean | string | null | undefined;
const isActive = (a: Active): boolean => a === true || a === "true";

const dollars = (v: number | string | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** An amount's monthly equivalent in (unrounded) cents; null when the frequency has none. */
export function monthlyCentsOf(amount: number | string, frequency: string): number | null {
  const factor = MONTHLY_FACTORS[frequency];
  if (factor === undefined) return null;
  return Math.abs(dollars(amount)) * 100 * factor;
}

export interface WeeklyLimitInputs {
  incomeItems: ReadonlyArray<{ amount: number | string; frequency: string; active: Active }>;
  /** Every non-income recurring item; the funding items and debt-linked bills are left out here. */
  billItems: ReadonlyArray<{
    name: string;
    amount: number | string;
    frequency: string;
    active: Active;
    debtId?: string | null;
  }>;
  debts: ReadonlyArray<{ minPayment: number | string; status?: string | null }>;
  /** `avalanche_settings.manual_extra`, per month. */
  avalancheExtra: number | string;
  /** 0 until goals ship. */
  goalsMonthly: number | string;
}

export interface WeeklyLimitDerivation {
  takeHomeMonthly: string;
  committedMonthly: string;
  debtMinimumsMonthly: string;
  extraMonthly: string;
  goalsMonthly: string;
  discretionaryMonthly: string;
}

export interface WeeklyLimitSuggestion {
  /** Whole dollars, a multiple of $5, never negative. */
  suggestedWeekly: string;
  derivation: WeeklyLimitDerivation;
}

const money = (cents: number): string => (cents / 100).toFixed(2);

export function deriveWeeklyLimit(inputs: WeeklyLimitInputs): WeeklyLimitSuggestion {
  let takeHome = 0;
  for (const i of inputs.incomeItems) {
    if (!isActive(i.active)) continue;
    takeHome += monthlyCentsOf(i.amount, i.frequency) ?? 0;
  }
  let committed = 0;
  for (const b of inputs.billItems) {
    if (!isActive(b.active) || isEverydayFundingItem(b.name) || b.debtId) continue;
    committed += monthlyCentsOf(b.amount, b.frequency) ?? 0;
  }
  let minimums = 0;
  for (const d of inputs.debts) {
    if ((d.status ?? "active") !== "active") continue;
    minimums += Math.abs(dollars(d.minPayment)) * 100;
  }
  const takeHomeCents = Math.round(takeHome);
  const committedCents = Math.round(committed);
  const minimumsCents = Math.round(minimums);
  const extraCents = Math.round(Math.max(0, dollars(inputs.avalancheExtra)) * 100);
  const goalsCents = Math.round(Math.max(0, dollars(inputs.goalsMonthly)) * 100);
  const discretionaryCents = takeHomeCents - committedCents - minimumsCents - extraCents - goalsCents;
  // Per week (× 12/52), rounded down to whole $5 (500 cents): floor(c × 12 / (52 × 500)) × 500.
  const weeklyCents = Math.max(0, Math.floor((discretionaryCents * 12) / 26_000)) * 500;
  return {
    suggestedWeekly: money(weeklyCents),
    derivation: {
      takeHomeMonthly: money(takeHomeCents),
      committedMonthly: money(committedCents),
      debtMinimumsMonthly: money(minimumsCents),
      extraMonthly: money(extraCents),
      goalsMonthly: money(goalsCents),
      discretionaryMonthly: money(discretionaryCents),
    },
  };
}
