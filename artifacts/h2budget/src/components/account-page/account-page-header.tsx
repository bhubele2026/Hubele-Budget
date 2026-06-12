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
  // accentBorderClass / iconClass kept in the signature for call-site
  // compatibility; the flat header no longer renders a heavy accent bar.
  void accentBorderClass;
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3 min-w-0">
        {icon ? (
          <span
            className={cn(
              "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-card shadow-sm",
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
