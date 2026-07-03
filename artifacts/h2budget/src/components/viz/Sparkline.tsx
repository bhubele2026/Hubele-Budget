import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Tiny trend line/area, ~28px tall, no axes or labels — a glanceable shape
 * that sits beside a number. Pairs with any tile in the viz kit. Pass raw
 * numbers; the spark scales to its own min/max.
 *
 * Hand-rolled inline SVG (no charting lib) so it stays out of the heavy
 * recharts bundle. Renders a smooth <path> for the line and a filled <path>
 * for the area variant. Width is responsive via a fixed viewBox + width:100%;
 * strokes use non-scaling-stroke so they stay crisp at any width.
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
  const gid = useId().replace(/:/g, "");
  const values = (data ?? []).map((v) => Number(v) || 0);
  if (values.length < 2) return <div style={{ height }} className={className} />;

  // Fixed horizontal viewBox units; the SVG stretches to fill its container.
  const W = 100;
  const top = 2;
  const bottom = height - 2;

  // Pad the Y domain a touch so a flat-ish line isn't clipped to the edges.
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min || Math.abs(max) || 1) * 0.12;
  const lo = min - pad;
  const range = max + pad - lo; // always > 0 given pad > 0

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = bottom - ((v - lo) / range) * (bottom - top);
    return [x, y] as const;
  });

  // Smooth the line with a Catmull-Rom spline expressed as cubic béziers, so
  // it reads like the old recharts type="monotone" curve.
  const linePath = points
    .map(([x, y], i) => {
      if (i === 0) return `M ${x} ${y}`;
      const [x0, y0] = points[i - 1];
      const [xp0, yp0] = points[i - 2] ?? points[i - 1];
      const [xn, yn] = points[i + 1] ?? points[i];
      const c1x = x0 + (x - xp0) / 6;
      const c1y = y0 + (y - yp0) / 6;
      const c2x = x - (xn - x0) / 6;
      const c2y = y - (yn - y0) / 6;
      return `C ${c1x} ${c1y} ${c2x} ${c2y} ${x} ${y}`;
    })
    .join(" ");

  const areaPath = `${linePath} L ${W} ${height} L 0 ${height} Z`;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-hidden="true"
      >
        {variant === "area" && (
          <defs>
            <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
        )}
        {variant === "area" && (
          <path d={areaPath} fill={`url(#spark-${gid})`} stroke="none" />
        )}
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
