import { STATUS_COLOR, type Status } from "@/lib/statusThresholds";
import { cn } from "@/lib/utils";

/**
 * A floor → ceiling fill bar (like the Fuelling card's 1,500 → 2,400 slider).
 * Shows how far `value` sits between `floor` and `ceiling`, colored by status,
 * with end labels. Great for "spent vs planned allowance".
 */
export function FillMeter({
  value,
  floor = 0,
  ceiling,
  status = "neutral",
  floorLabel,
  ceilingLabel,
  format = (n) => `${Math.round(n)}`,
  className,
}: {
  value: number;
  floor?: number;
  ceiling: number;
  status?: Status;
  floorLabel?: string;
  ceilingLabel?: string;
  format?: (n: number) => string;
  className?: string;
}) {
  const span = ceiling - floor;
  const pct = span > 0 ? Math.max(0, Math.min(1, (value - floor) / span)) : 0;
  const over = value > ceiling;
  const color = STATUS_COLOR[status];

  return (
    <div className={cn("w-full", className)}>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${pct * 100}%`, background: color }}
        />
        {/* ceiling marker */}
        {!over && (
          <div className="absolute inset-y-0 right-0 w-px bg-foreground/20" />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{floorLabel ?? format(floor)}</span>
        <span className={over ? "font-semibold text-[hsl(var(--negative))]" : "font-medium text-foreground"}>
          {format(value)}
        </span>
        <span>{ceilingLabel ?? format(ceiling)}</span>
      </div>
    </div>
  );
}
