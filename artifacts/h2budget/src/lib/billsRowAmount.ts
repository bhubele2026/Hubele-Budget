import { formatCurrency } from "@/lib/utils";

export type BillRowFrequency =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "onetime"
  | "quarterly"
  | "annual"
  | string;

export type BillRowAmountDisplay = {
  amountText: string;
  monthlyHint: string | null;
};

const FREQ_SUFFIX: Record<string, string> = {
  weekly: "weekly",
  biweekly: "biweekly",
  semimonthly: "semi-monthly",
  monthly: "monthly",
  onetime: "one-time",
  quarterly: "quarterly",
  annual: "annual",
};

// Frequencies whose per-event amount differs from the per-month figure.
// These get a smoothed "/mo" hint based on the per-event amount and how
// many events occur per year, divided by 12 — i.e. the conventional
// monthly equivalent. We deliberately do NOT show the calendar-expanded
// total for the viewed month here, because three-paycheck biweekly months
// would otherwise overstate ongoing monthly income.
//
// Smoothed multipliers (events per year ÷ 12):
//   weekly       52 / 12 ≈ 4.3333
//   biweekly     26 / 12 ≈ 2.1667
//   semimonthly  24 / 12 = 2
const SMOOTHED_MONTHLY_MULTIPLIER: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
};

export function formatBillRowAmount(
  perEventAmount: number,
  frequency: BillRowFrequency,
  sign: "+" | "−",
  // Retained for backward compatibility with existing callers; no longer
  // used for the hint (we derive a smoothed monthly from perEventAmount).
  _monthlyAmount?: number,
): BillRowAmountDisplay {
  const abs = Math.abs(perEventAmount);
  const suffix = FREQ_SUFFIX[frequency] ?? String(frequency);
  const amountText = `${sign}${formatCurrency(abs)} ${suffix}`;

  const multiplier = SMOOTHED_MONTHLY_MULTIPLIER[frequency];
  const monthlyHint =
    multiplier !== undefined
      ? `~${formatCurrency(abs * multiplier)}/mo`
      : null;

  return { amountText, monthlyHint };
}
