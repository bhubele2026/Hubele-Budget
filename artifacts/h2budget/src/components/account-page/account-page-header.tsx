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
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2.5">
          {icon ? (
            <span className={cn("inline-flex text-muted-foreground", iconClass)}>
              {icon}
            </span>
          ) : null}
          {title}
        </h1>
        {subtitle ? (
          <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-start gap-2 flex-wrap">{actions}</div>
      ) : null}
    </div>
  );
}
