import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * A single progress ring with a number in the middle — % to goal, % of a
 * statement cleared, spent-vs-planned. Pass `value` 0..1; the ring sweeps in
 * unless reduced motion is requested.
 */
export function RingStat({
  value,
  size = 64,
  stroke = 6,
  color = "hsl(var(--primary))",
  trackColor = "hsl(var(--muted))",
  centerText,
  centerSub,
  className,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  trackColor?: string;
  /** Defaults to the rounded percentage. Pass "" to hide. */
  centerText?: string;
  centerSub?: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  const [fill, setFill] = useState(reduce ? pct : 0);
  useEffect(() => {
    if (reduce) {
      setFill(pct);
      return;
    }
    const t = window.setTimeout(() => setFill(pct), 60);
    return () => window.clearTimeout(t);
  }, [pct, reduce]);

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const label = centerText ?? `${Math.round(pct * 100)}%`;

  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={trackColor}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fill)}
          style={{ transition: reduce ? undefined : "stroke-dashoffset 0.9s ease-out" }}
        />
      </svg>
      {label !== "" && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="text-center leading-none">
            <div className="text-xs font-bold tabular-nums">{label}</div>
            {centerSub && (
              <div className="text-[9px] uppercase tracking-widest text-muted-foreground mt-0.5">
                {centerSub}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
