import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";

/**
 * The standard money renderer: always `tabular-nums`, optionally colored by
 * sign (income/payment green, charge/expense red). Money is this app's
 * typographic hero — use this anywhere a dollar figure is shown so columns
 * align and signs read consistently.
 *
 * App money convention: negative = charge/expense, positive = income/payment.
 */
export function MoneyText({
  amount,
  colored = false,
  signed = false,
  neutralAtZero = true,
  abs = false,
  className,
}: {
  amount: string | number | null | undefined;
  /** Color by sign using the --positive/--negative tokens. */
  colored?: boolean;
  /** Force a leading +/− even for positive values. */
  signed?: boolean;
  neutralAtZero?: boolean;
  /** Render the magnitude only (e.g. "$312.00" for a -312 charge). */
  abs?: boolean;
  className?: string;
}) {
  const num =
    typeof amount === "string"
      ? parseFloat(amount)
      : typeof amount === "number"
        ? amount
        : 0;
  const safe = Number.isFinite(num) ? num : 0;
  const shown = abs ? Math.abs(safe) : safe;

  let colorClass = "";
  if (colored) {
    if (safe === 0 && neutralAtZero) colorClass = "text-muted-foreground";
    else if (safe > 0) colorClass = "text-[hsl(var(--positive))]";
    else if (safe < 0) colorClass = "text-[hsl(var(--negative))]";
  }

  const body = formatCurrency(shown);
  const prefix = signed && safe > 0 && !abs ? "+" : "";

  return (
    <span className={cn("tabular-nums", colorClass, className)}>
      {prefix}
      {body}
    </span>
  );
}
