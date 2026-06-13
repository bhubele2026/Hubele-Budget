import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Big gamified "financial health" ring — a single 0–100 score with a tier
 * label and a one-liner. The score is computed by the caller from real
 * signals (net, runway, streak, pace, debt). Fill animates in.
 */
export function HealthScore({
  score,
  label,
  color,
  blurb,
}: {
  score: number;
  label: string;
  color: string;
  blurb: string;
}) {
  const CX = 70;
  const CY = 70;
  const R = 54;
  const STROKE = 12;
  const C = 2 * Math.PI * R;

  const [fill, setFill] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setFill(Math.max(0, Math.min(1, score / 100))), 80);
    return () => window.clearTimeout(t);
  }, [score]);
  const offset = C * (1 - fill);

  return (
    <Card>
      <CardContent className="p-5 flex items-center gap-5">
        <svg viewBox="0 0 140 140" className="w-[126px] h-[126px] shrink-0" aria-hidden>
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
              transition: "stroke-dashoffset 1200ms cubic-bezier(0.22,1,0.36,1)",
            }}
          />
          <text
            x={CX}
            y={CY + 2}
            textAnchor="middle"
            fill="hsl(var(--foreground))"
            style={{ fontSize: 32, fontWeight: 800 }}
          >
            {score}
          </text>
          <text
            x={CX}
            y={CY + 22}
            textAnchor="middle"
            fill="hsl(var(--muted-foreground))"
            style={{ fontSize: 10, letterSpacing: 1 }}
          >
            / 100
          </text>
        </svg>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
            Financial health
          </div>
          <div
            className="text-2xl font-extrabold tracking-tight"
            style={{ color }}
          >
            {label}
          </div>
          <div className="text-sm text-muted-foreground mt-0.5">{blurb}</div>
        </div>
      </CardContent>
    </Card>
  );
}
