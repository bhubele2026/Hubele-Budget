import { useEffect, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { cn } from "@/lib/utils";

export type MiniBar = {
  value: number;
  label?: string;
  /** Optional override; otherwise colored by sign / accent. */
  color?: string;
};

/**
 * A row of 7–12 bars — weekly cadence, day-of-week, last-N anything. Bars
 * scale to the largest absolute value. Negative values render below an
 * implied baseline in the negative color. Click a bar to drill.
 */
export function MiniBars({
  data,
  height = 40,
  className,
  onBarClick,
  accent = "hsl(var(--chart-1))",
  signed = false,
  activeIndex,
}: {
  data: Array<number | MiniBar>;
  height?: number;
  className?: string;
  onBarClick?: (index: number) => void;
  accent?: string;
  /** Color positive/negative differently (over/under style). */
  signed?: boolean;
  /** Highlight one bar (e.g. the selected week). */
  activeIndex?: number;
}) {
  const reduce = useReducedMotion();
  // Grow-in on mount: bars render at 0 height, then transition up on the
  // next frame. Skipped entirely under reduced motion (also keeps jsdom
  // tests single-render — the test matchMedia polyfill answers "reduce").
  const [grown, setGrown] = useState(reduce);
  useEffect(() => {
    if (reduce || grown) return;
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(raf);
  }, [reduce, grown]);
  const bars: MiniBar[] = (data ?? []).map((d) =>
    typeof d === "number" ? { value: d } : d,
  );
  if (!bars.length) return <div style={{ height }} className={className} />;

  const max = Math.max(...bars.map((b) => Math.abs(Number(b.value) || 0)), 1);

  return (
    <div
      className={cn("flex items-end gap-1", className)}
      style={{ height }}
      role={onBarClick ? "group" : undefined}
    >
      {bars.map((b, i) => {
        const v = Number(b.value) || 0;
        const h = Math.max(2, (Math.abs(v) / max) * height);
        const color =
          b.color ??
          (signed
            ? v < 0
              ? "hsl(var(--negative))"
              : "hsl(var(--positive))"
            : accent);
        const isActive = activeIndex === i;
        const bar = (
          <div
            className="rounded-[3px] transition-[height] duration-700 ease-out"
            style={{
              height: grown ? h : 0,
              background: color,
              opacity: activeIndex == null || isActive ? 1 : 0.42,
              outline: isActive ? `2px solid ${color}` : undefined,
              outlineOffset: 1,
            }}
          />
        );
        // Flat-matte: bars never grow into slabs — thickness is capped and the
        // bar centers in its track when the track is wider than the cap.
        return onBarClick ? (
          <button
            key={i}
            type="button"
            onClick={() => onBarClick(i)}
            className="flex-1 flex items-end justify-center h-full min-w-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-[3px]"
            title={b.label}
            aria-label={b.label ?? `Bar ${i + 1}`}
          >
            <span className="block w-full max-w-10">{bar}</span>
          </button>
        ) : (
          <div
            key={i}
            className="flex-1 flex items-end justify-center h-full min-w-0"
            title={b.label}
          >
            <span className="block w-full max-w-10">{bar}</span>
          </div>
        );
      })}
    </div>
  );
}
