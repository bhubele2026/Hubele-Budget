import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ▲/▼ + signed % chip, colored by what's *good*. By default up = positive
 * (green) — but for spend/debt, more is bad, so pass `invert` and a rise
 * shows red. Period-over-period at a glance.
 */
export function DeltaPill({
  value,
  className,
  invert = false,
  suffix = "%",
  digits = 0,
  neutralBelow = 0.05,
}: {
  /** The signed delta, already a percentage number (e.g. 12.4 for +12.4%). */
  value: number;
  className?: string;
  /** When true, a rise is "bad" (red) — use for spend, debt, owed. */
  invert?: boolean;
  suffix?: string;
  digits?: number;
  /** Treat |value| under this as flat/neutral. */
  neutralBelow?: number;
}) {
  const v = Number(value) || 0;
  const flat = Math.abs(v) < neutralBelow;
  const up = v > 0;
  // "good" = green, "bad" = red. Up is good unless inverted.
  const good = flat ? null : invert ? !up : up;
  const tone = flat
    ? "text-muted-foreground bg-muted"
    : good
      ? "text-[hsl(var(--positive))] bg-[hsl(var(--positive)/0.12)]"
      : "text-[hsl(var(--negative))] bg-[hsl(var(--negative)/0.12)]";
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums",
        tone,
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {up && !flat ? "+" : ""}
      {v.toFixed(digits)}
      {suffix}
    </span>
  );
}
