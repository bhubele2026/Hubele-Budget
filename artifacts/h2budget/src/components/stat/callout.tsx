import * as React from "react";
import { Sparkles } from "lucide-react";
import { STATUS_COLOR, type Status } from "@/lib/statusThresholds";
import { cn } from "@/lib/utils";

/**
 * The canonical insight banner — an icon, a coach line, and an optional action
 * button. Tinted by tone. Use for the in-voice nudges across pages (the shared
 * shell behind AiInsightBar-style callouts).
 */
export function Callout({
  children,
  icon,
  tone = "info",
  action,
  className,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  tone?: Status | "info";
  action?: React.ReactNode;
  className?: string;
}) {
  const color =
    tone === "info" ? "hsl(var(--primary))" : STATUS_COLOR[tone as Status];
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-2xl border border-card-border bg-card px-4 py-3",
        className,
      )}
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
      data-testid="callout"
    >
      <span className="mt-0.5 shrink-0" style={{ color }}>
        {icon ?? <Sparkles className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1 text-sm font-medium leading-snug">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
