import { cx } from "@/lib/cx";

/**
 * Skeleton shapes for a genuine cold load, and only for that: a refresh keeps
 * the last figures on screen. Static on purpose — no shimmer (the motion law
 * permits a sheet slide, a meter fill and the focus ring, nothing else). They
 * carry no text and no numbers, so nothing here can be read as a value.
 */
export function SkeletonLine({ className }: { className?: string }) {
  return <span aria-hidden className={cx("block h-3 rounded-1 bg-paper-2", className ?? "w-40")} />;
}

const FIGURE_SHAPE = {
  xl: "h-9 w-52 sm:h-11",
  md: "h-7 w-28",
  sm: "h-5 w-16",
} as const;

export function SkeletonFigure({ size }: { size: keyof typeof FIGURE_SHAPE }) {
  return <span aria-hidden className={cx("block rounded-1 bg-paper-2", FIGURE_SHAPE[size])} />;
}

export function SkeletonMeter() {
  return (
    <span aria-hidden className="block">
      <span className="block h-7 w-36 rounded-1 bg-paper-2" />
      <span className="mt-3 block h-2 w-full rounded-1 bg-paper-2" />
    </span>
  );
}
