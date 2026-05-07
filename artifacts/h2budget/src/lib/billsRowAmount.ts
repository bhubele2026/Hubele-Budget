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

// Frequencies whose per-event amount differs from the per-month figure
// the Budget page shows for the viewed month. These get a "/mo" hint
// computed from the API's calendar-expanded monthlyAmount so the row
// hint always agrees with the Budget page row for the same month.
const SHOWS_MONTHLY_HINT: Record<string, true> = {
  weekly: true,
  biweekly: true,
  semimonthly: true,
};

export function formatBillRowAmount(
  perEventAmount: number,
  frequency: BillRowFrequency,
  sign: "+" | "−",
  monthlyAmount?: number,
): BillRowAmountDisplay {
  const abs = Math.abs(perEventAmount);
  const suffix = FREQ_SUFFIX[frequency] ?? String(frequency);
  const amountText = `${sign}${formatCurrency(abs)} ${suffix}`;

  const monthlyHint =
    SHOWS_MONTHLY_HINT[frequency] && monthlyAmount !== undefined
      ? `~${formatCurrency(Math.abs(monthlyAmount))}/mo`
      : null;

  return { amountText, monthlyHint };
}
