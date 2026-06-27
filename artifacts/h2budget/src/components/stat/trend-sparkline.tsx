import { MiniBars } from "@/components/viz";
import { cn } from "@/lib/utils";

export type TrendPoint = { value: number; label?: string };

/**
 * 8-week over/under trend strip: a small bar per period. Bars where you came in
 * UNDER (value ≤ 0 variance) are green; OVER (value > 0) are red. Pass the
 * signed variance (spend − target) per period, oldest first.
 */
export function TrendSparkline({
  data,
  height = 36,
  activeIndex,
  onBarClick,
  className,
}: {
  data: TrendPoint[];
  height?: number;
  activeIndex?: number;
  onBarClick?: (index: number) => void;
  className?: string;
}) {
  return (
    <MiniBars
      className={cn(className)}
      height={height}
      activeIndex={activeIndex}
      onBarClick={onBarClick}
      data={data.map((p) => ({
        value: p.value,
        label: p.label,
        // under/at target = good (green), over = bad (red)
        color: p.value > 0 ? "hsl(var(--negative))" : "hsl(var(--positive))",
      }))}
    />
  );
}
