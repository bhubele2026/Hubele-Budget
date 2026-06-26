import type { RangeMode } from "@/lib/timeRange";
import { cn } from "@/lib/utils";

const OPTIONS: { value: RangeMode; label: string }[] = [
  { value: "wk", label: "Wk" },
  { value: "mo", label: "Mo" },
  { value: "yr", label: "Yr" },
];

/**
 * The one shared time-range control. Wk is the weekly-first default; Mo/Yr are
 * opt-in. A flat, hairline segmented control — no shadows. Drop it on any
 * surface that frames data by period and wire it to a RangeMode state.
 */
export function TimeRangeToggle({
  value,
  onChange,
  className,
  size = "sm",
}: {
  value: RangeMode;
  onChange: (mode: RangeMode) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border border-card-border bg-card p-0.5",
        className,
      )}
      role="group"
      aria-label="Time range"
    >
      {OPTIONS.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "rounded-md font-medium transition-colors tabular-nums",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`range-${o.value}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
