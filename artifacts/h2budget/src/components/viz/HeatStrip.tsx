import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";

/**
 * A row of N cells whose opacity encodes intensity — daily spend heat, a
 * GitHub-contributions-style strip. Darkest cell = the heaviest day. Pass
 * raw amounts; the strip normalizes to its own max.
 */
export function HeatStrip({
  data,
  labels,
  height = 24,
  className,
  color = "var(--negative)",
  onCellClick,
  money = true,
}: {
  data: number[];
  labels?: string[];
  height?: number;
  className?: string;
  /** Raw HSL tri/space token name, e.g. "var(--negative)". */
  color?: string;
  onCellClick?: (index: number) => void;
  money?: boolean;
}) {
  const cells = (data ?? []).map((v) => Number(v) || 0);
  if (!cells.length) return <div style={{ height }} className={className} />;
  const max = Math.max(...cells.map((v) => Math.abs(v)), 1);

  return (
    <div className={cn("flex gap-1", className)} style={{ height }}>
      {cells.map((v, i) => {
        const intensity = Math.abs(v) / max; // 0..1
        const opacity = v === 0 ? 0.08 : 0.22 + intensity * 0.78;
        const title = `${labels?.[i] ?? `Day ${i + 1}`} · ${
          money ? formatCurrency(v) : v
        }`;
        const cell = (
          <div
            className="h-full w-full rounded-[3px]"
            style={{ background: `hsl(${color} / ${opacity})` }}
          />
        );
        return onCellClick ? (
          <button
            key={i}
            type="button"
            title={title}
            aria-label={title}
            onClick={() => onCellClick(i)}
            className="flex-1 min-w-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-[3px]"
          >
            {cell}
          </button>
        ) : (
          <div key={i} className="flex-1 min-w-0" title={title}>
            {cell}
          </div>
        );
      })}
    </div>
  );
}
