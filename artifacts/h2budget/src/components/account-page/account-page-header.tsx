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
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 flex-wrap border-l-4 pl-4",
        accentBorderClass ?? "border-blue-600",
      )}
    >
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground flex items-center gap-2">
          {icon ? <span className={cn("inline-flex", iconClass)}>{icon}</span> : null}
          {title}
        </h1>
        {subtitle ? (
          <p className="text-muted-foreground mt-1">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2 flex-wrap">{actions}</div>
      ) : null}
    </div>
  );
}
