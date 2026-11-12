import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * ⭐ ONE DISCIPLINED SUMMARY GROUP (owner, 2026-11-12): a screen's headline
 * figures sit in ONE flat panel, split by hairlines — not four floating cards.
 * Two by two on a phone, one row from 1024 px (`.kpi-grid`). Each cell is
 * label · figure · one support line, aligned across the row.
 */
export function SummaryGroup({
  children,
  className,
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={cn("panel kpi-grid", className)} data-testid={testId}>
      {children}
    </div>
  );
}

/** The label above a summary figure: 12/500 grey, with room for a help mark. */
export const SUMMARY_LABEL = "flex items-center gap-1.5 text-micro font-medium text-neutral-600";
/** The summary figure: 22–28/600 charcoal, tabular lining figures. */
export const SUMMARY_FIGURE = "fig mt-1.5 whitespace-nowrap text-kpi font-semibold text-foreground";
/** The one support line under a figure. */
export const SUMMARY_SUPPORT = "mt-1 text-micro text-neutral-600";
