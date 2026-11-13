import type { RangeMode } from "@/lib/timeRange";
import { cn } from "@/lib/utils";
import { useRef } from "react";
import { segment } from "@/components/next/Toolbar";
import { useSlidingPill } from "@/lib/motion";

const OPTIONS: { value: RangeMode; label: string }[] = [
  { value: "wk", label: "Wk" },
  { value: "mo", label: "Mo" },
  { value: "yr", label: "Yr" },
];

/**
 * The one shared time-range control. Wk is the weekly-first default; Mo/Yr are
 * opt-in. The app's one segmented control look (`Segmented`/`segment`,
 * components/next/Toolbar). Drop it on any surface that frames data by
 * period and wire it to a RangeMode state.
 */
export function TimeRangeToggle({
  value,
  onChange,
  className,
  size = "sm",
}: {
  /** null = a custom span: no preset is lit. */
  value: RangeMode | null;
  onChange: (mode: RangeMode) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSlidingPill(ref);
  return (
    <div
      ref={ref}
      className={cn(
        "inline-flex items-stretch rounded-control bg-platinum-3 p-0.5 ring-1 ring-brand-line",
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
            className={cn(segment(active), size === "md" && "px-3.5")}
            data-testid={`range-${o.value}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
