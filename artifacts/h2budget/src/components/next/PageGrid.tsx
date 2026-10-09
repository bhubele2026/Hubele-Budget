import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The 12-column responsive grid (12 ≥1024px, 6 ≥640px, 1 below). Children
 *  size themselves with `span-3|4|6|8|12` (see Panel's `span` prop). */
export function PageGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid-12", className)}>{children}</div>;
}

/**
 * Entry stagger for a grid cell, on the existing dial: `tile-in` (fade up on `--ease-enter`)
 * delayed by `i × --stagger`. Literal strings so Tailwind sees them. The
 * reduced-motion block kills `.tile-in` and zeroes `--stagger`.
 *
 * ⚠️ Never on a panel that hosts sticky rows or a drag overlay: the entrance
 * is a transform, and a transformed ancestor re-anchors `position: fixed`.
 */
const RISE = [
  "[animation-delay:calc(0*var(--stagger))]",
  "[animation-delay:calc(1*var(--stagger))]",
  "[animation-delay:calc(2*var(--stagger))]",
  "[animation-delay:calc(3*var(--stagger))]",
  "[animation-delay:calc(4*var(--stagger))]",
  "[animation-delay:calc(5*var(--stagger))]",
  "[animation-delay:calc(6*var(--stagger))]",
  "[animation-delay:calc(7*var(--stagger))]",
  "[animation-delay:calc(8*var(--stagger))]",
  "[animation-delay:calc(9*var(--stagger))]",
];
export function rise(i: number): string {
  return cn("tile-in", RISE[Math.min(Math.max(i, 0), RISE.length - 1)]);
}
