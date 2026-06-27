import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical section header: an uppercase wide-tracked eyebrow + a title, with
 * an optional right-aligned action (a "See all ›" link or control). The one
 * heading style used across the app.
 */
export function SectionHeader({
  eyebrow,
  title,
  sub,
  action,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            {eyebrow}
          </div>
        )}
        <h2 className="text-lg font-semibold tracking-tight leading-tight">{title}</h2>
        {sub && <p className="text-sm text-muted-foreground mt-0.5">{sub}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
