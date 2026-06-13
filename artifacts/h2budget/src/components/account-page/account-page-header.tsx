import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AccountPageHeader({
  title,
  subtitle,
  icon,
  accentBorderClass,
  iconClass,
  actions,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  accentBorderClass?: string;
  iconClass?: string;
  actions?: ReactNode;
}) {
  // accentBorderClass kept for call-site compatibility; the heavy accent bar
  // is gone. The icon IS rendered here — it's the real Amex/Chase brand mark
  // (the decorative piggy/sparkle icons elsewhere are what got stripped).
  void accentBorderClass;
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3 min-w-0">
        {icon ? (
          <span
            className={cn(
              "inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-card",
              iconClass,
            )}
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <h1 className="text-[1.7rem] font-semibold tracking-tight text-foreground leading-tight">
            {title}
          </h1>
          {subtitle ? (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex items-start gap-2 flex-wrap">{actions}</div>
      ) : null}
    </div>
  );
}
