import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The 12-column responsive grid (12 ≥1024px, 6 ≥640px, 1 below). Children
 *  size themselves with `span-3|4|6|8|12` (see Panel's `span` prop). */
export function PageGrid({
  children,
  className,
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={cn("grid-12", className)} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * (2026-11-12) NO ENTRANCES: a page is simply there when it opens (owner's
 * brief: "remove decorative entrance movement"). `rise(i)` was the per-cell
 * stagger; it now returns no class, so its ~40 call sites need no edit and
 * nothing rises. Kept as a function so a call site still type-checks.
 */
export function rise(_i: number): string {
  return "";
}
