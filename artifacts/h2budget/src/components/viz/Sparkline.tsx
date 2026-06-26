import { useId } from "react";
import { useReducedMotion } from "framer-motion";
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ResponsiveContainer,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

/**
 * Tiny trend line/area, ~28px tall, no axes or labels — a glanceable shape
 * that sits beside a number. Pairs with any tile in the viz kit. Pass raw
 * numbers; the spark scales to its own min/max.
 */
export function Sparkline({
  data,
  variant = "area",
  color = "hsl(var(--chart-1))",
  height = 28,
  className,
  strokeWidth = 1.75,
}: {
  data: number[];
  variant?: "area" | "line";
  color?: string;
  height?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const reduce = useReducedMotion();
  const gid = useId().replace(/:/g, "");
  const series = (data ?? []).map((v, i) => ({ i, v: Number(v) || 0 }));
  if (series.length < 2) return <div style={{ height }} className={className} />;

  // Pad the Y domain a touch so a flat-ish line isn't clipped to the edges.
  const values = series.map((d) => d.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min || Math.abs(max) || 1) * 0.12;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {variant === "area" ? (
          <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
            <defs>
              <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[min - pad, max + pad]} />
            <Area
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={strokeWidth}
              fill={`url(#spark-${gid})`}
              isAnimationActive={!reduce}
              animationDuration={700}
              dot={false}
            />
          </AreaChart>
        ) : (
          <LineChart data={series} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
            <YAxis hide domain={[min - pad, max + pad]} />
            <Line
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={strokeWidth}
              isAnimationActive={!reduce}
              animationDuration={700}
              dot={false}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
