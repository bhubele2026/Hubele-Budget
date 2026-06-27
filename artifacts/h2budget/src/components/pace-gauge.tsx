import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Circular spend-pace gauge: how much of your income you've spent (the ring)
 * vs how far through the month you are (the tick marker). If the ring fill is
 * behind the tick you're ahead of pace; past it, you're burning fast. Animates
 * the fill in on mount.
 */
export function PaceGauge({
  spend,
  income,
  dayOfMonth,
  daysInMonth,
}: {
  spend: number;
  income: number;
  dayOfMonth: number;
  daysInMonth: number;
}) {
  const spentPct = income > 0 ? Math.min(1, spend / income) : 0;
  const elapsedPct = daysInMonth > 0 ? Math.min(1, dayOfMonth / daysInMonth) : 0;
  const ahead = spentPct <= elapsedPct + 0.02;
  const hasIncome = income > 0;

  const CX = 70;
  const CY = 70;
  const R = 52;
  const STROKE = 11;
  const C = 2 * Math.PI * R;

  const [fill, setFill] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setFill(spentPct), 80);
    return () => window.clearTimeout(t);
  }, [spentPct]);
  const offset = C * (1 - fill);

  const color = !hasIncome
    ? "hsl(var(--muted-foreground))"
    : ahead
      ? "hsl(var(--primary))"
      : "hsl(var(--negative))";

  // "On-pace" tick at elapsedPct around the ring (starts at top, clockwise).
  const rad = ((-90 + elapsedPct * 360) * Math.PI) / 180;
  const inner = R - STROKE / 2 - 2;
  const outer = R + STROKE / 2 + 2;

  return (
    <div className="flex items-center gap-5">
      <svg
        viewBox="0 0 140 140"
        className="w-[118px] h-[118px] shrink-0"
        aria-hidden
      >
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={STROKE}
        />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${CX} ${CY})`}
          style={{
            transition:
              "stroke-dashoffset 1100ms cubic-bezier(0.22,1,0.36,1)",
          }}
        />
        {hasIncome ? (
          <line
            x1={CX + inner * Math.cos(rad)}
            y1={CY + inner * Math.sin(rad)}
            x2={CX + outer * Math.cos(rad)}
            y2={CY + outer * Math.sin(rad)}
            stroke="hsl(var(--foreground))"
            strokeWidth={2.5}
          />
        ) : null}
        <text
          x={CX}
          y={CY - 1}
          textAnchor="middle"
          fill="hsl(var(--foreground))"
          style={{ fontSize: 23, fontWeight: 800 }}
        >
          {Math.round(spentPct * 100)}%
        </text>
        <text
          x={CX}
          y={CY + 16}
          textAnchor="middle"
          fill="hsl(var(--muted-foreground))"
          style={{ fontSize: 9, letterSpacing: 1 }}
        >
          OF INCOME
        </text>
      </svg>

      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
          This month&apos;s pace
        </div>
        <div
          className={cn(
            "mt-1 text-xl font-bold",
            !hasIncome
              ? "text-muted-foreground"
              : ahead
                ? "text-positive"
                : "text-[hsl(var(--negative))]",
          )}
        >
          {!hasIncome
            ? "No income logged yet"
            : ahead
              ? "Ahead of pace 🟢"
              : "Burning fast 🔥"}
        </div>
        <div className="text-sm text-muted-foreground mt-0.5">
          Day {dayOfMonth} of {daysInMonth} · {Math.round(spentPct * 100)}% of
          income spent vs {Math.round(elapsedPct * 100)}% of the month gone.
        </div>
      </div>
    </div>
  );
}
