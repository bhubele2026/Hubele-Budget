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
  // accentBorderClass / icon / iconClass kept in the signature for call-site
  // compatibility, but no longer rendered — clean text-only headers read more
  // professional than a decorative logo tile.
  void accentBorderClass;
  void icon;
  void iconClass;
  void cn;
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-[1.7rem] font-semibold tracking-tight text-foreground leading-tight">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-start gap-2 flex-wrap">{actions}</div>
      ) : null}
    </div>
  );
}
