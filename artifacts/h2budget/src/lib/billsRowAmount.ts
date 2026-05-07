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

const MONTHLY_MULTIPLIER: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
};

export function formatBillRowAmount(
  perEventAmount: number,
  frequency: BillRowFrequency,
  sign: "+" | "−",
): BillRowAmountDisplay {
  const abs = Math.abs(perEventAmount);
  const suffix = FREQ_SUFFIX[frequency] ?? String(frequency);
  const amountText = `${sign}${formatCurrency(abs)} ${suffix}`;

  const mult = MONTHLY_MULTIPLIER[frequency];
  const monthlyHint =
    mult !== undefined ? `~${formatCurrency(abs * mult)}/mo` : null;

  return { amountText, monthlyHint };
}
