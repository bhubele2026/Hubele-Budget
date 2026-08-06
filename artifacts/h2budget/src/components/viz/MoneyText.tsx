import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";
import { useCountUp } from "@/hooks/useCountUp";

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
  countUp = false,
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
  /** Animate the figure counting up to its value (hero/stat surfaces only —
   *  keep OFF inside long lists, where a hundred counters read as noise).
   *  Honors prefers-reduced-motion via useCountUp. */
  countUp?: boolean;
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

  // Hooks can't be conditional, but the hook early-returns (no rAF work) on
  // a null target — so non-counting call sites pay nothing. Sign/color always
  // follow the TARGET value so a figure never flashes the wrong color
  // mid-count.
  const animated = useCountUp(countUp ? shown : null, 1200);

  let colorClass = "";
  if (colored) {
    if (safe === 0 && neutralAtZero) colorClass = "text-muted-foreground";
    else if (safe > 0) colorClass = "text-[hsl(var(--positive))]";
    else if (safe < 0) colorClass = "text-[hsl(var(--negative))]";
  }

  const body = formatCurrency(countUp ? animated : shown);
  const prefix = signed && safe > 0 && !abs ? "+" : "";

  return (
    <span className={cn("tabular-nums", colorClass, className)}>
      {prefix}
      {body}
    </span>
  );
}
