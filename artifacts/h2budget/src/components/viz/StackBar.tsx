import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";

export type StackSegment = {
  label: string;
  value: number;
  color: string;
};

/**
 * Horizontal 100%-stacked bar — category mix, spend split, who-owes-what.
 * Renders a thin colored bar plus an optional legend with values and shares.
 */
export function StackBar({
  segments,
  height = 10,
  className,
  showLegend = true,
  legendMax = 5,
  money = true,
}: {
  segments: StackSegment[];
  height?: number;
  className?: string;
  showLegend?: boolean;
  legendMax?: number;
  /** Format legend values as currency (vs raw number). */
  money?: boolean;
}) {
  const segs = (segments ?? []).filter((s) => (Number(s.value) || 0) > 0);
  const total = segs.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  if (total <= 0) return null;

  return (
    <div className={cn("w-full", className)}>
      <div
        className="flex w-full overflow-hidden rounded-full bg-muted"
        style={{ height }}
        role="img"
        aria-label="Spend mix"
      >
        {segs.map((s, i) => (
          <div
            key={`${s.label}-${i}`}
            style={{
              width: `${((Number(s.value) || 0) / total) * 100}%`,
              background: s.color,
            }}
            title={`${s.label} · ${money ? formatCurrency(s.value) : s.value}`}
          />
        ))}
      </div>
      {showLegend && (
        <div className="mt-3 space-y-1.5">
          {segs.slice(0, legendMax).map((s, i) => (
            <div key={`${s.label}-${i}`} className="flex items-center gap-2 text-xs">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ background: s.color }}
              />
              <span className="flex-1 truncate">{s.label}</span>
              <span className="tabular-nums font-medium">
                {money ? formatCurrency(s.value) : s.value}
              </span>
              <span className="tabular-nums text-muted-foreground w-9 text-right">
                {Math.round(((Number(s.value) || 0) / total) * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
