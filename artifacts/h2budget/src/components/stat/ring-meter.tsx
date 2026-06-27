import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { STATUS_COLOR, type Status } from "@/lib/statusThresholds";
import { cn } from "@/lib/utils";

/**
 * BH-style ring meter: a circular progress ring around a big "X / Y" number
 * with a small unit label, colored by status (green/amber/red). The signature
 * stat-card primitive.
 */
export function RingMeter({
  value,
  target,
  ratio,
  status = "neutral",
  centerTop,
  centerBottom,
  unit,
  size = 96,
  stroke = 8,
  className,
}: {
  /** Numerator shown big (e.g. spent). */
  value?: React.ReactNode;
  /** Denominator shown after the slash (e.g. target). */
  target?: React.ReactNode;
  /** Fill fraction 0..1; clamped. Defaults from value/target if both numeric. */
  ratio: number;
  status?: Status;
  /** Override the center top line (else "value / target"). */
  centerTop?: React.ReactNode;
  centerBottom?: React.ReactNode;
  unit?: string;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
  const [fill, setFill] = useState(reduce ? pct : 0);
  useEffect(() => {
    if (reduce) return setFill(pct);
    const t = window.setTimeout(() => setFill(pct), 60);
    return () => window.clearTimeout(t);
  }, [pct, reduce]);

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = STATUS_COLOR[status];

  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
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
      <div className="absolute inset-0 grid place-items-center text-center leading-none">
        <div>
          <div className="text-sm font-bold tabular-nums">
            {centerTop ?? (
              <>
                {value}
                {target != null && <span className="text-muted-foreground"> / {target}</span>}
              </>
            )}
          </div>
          {(centerBottom || unit) && (
            <div className="mt-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">
              {centerBottom ?? unit}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
