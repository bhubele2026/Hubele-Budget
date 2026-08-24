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
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon ? (
          <span
            className={cn(
              "surface inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-control ring-1 ring-brand-line",
              iconClass,
            )}
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          {/* `Page`'s display step — an account page is a page, so its title
              is the same size as every other page title in the app. */}
          <h1 className="text-display leading-tight font-semibold text-brand-navy">
            {title}
          </h1>
          {subtitle ? (
            <p className="text-label text-neutral-500">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-start gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
