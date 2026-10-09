import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AccountChip } from "@/components/next/AccountChip";
import type { AccountIdentity } from "@/lib/accountIdentity";

/**
 * The account page's head: brand mark, the page title, and — under it — the
 * account it is showing as an `AccountChip` (accent dot, name, ••mask), so the
 * account's identity is on screen before a single row is (C9). `actions`
 * (add, sync, connect) sit on the right and wrap under the title on a phone.
 */
export function AccountPageHeader({
  title,
  subtitle,
  icon,
  accentBorderClass,
  iconClass,
  actions,
  identity,
  meta,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  accentBorderClass?: string;
  iconClass?: string;
  actions?: ReactNode;
  /** The account on screen: rendered as its chip under the title. */
  identity?: AccountIdentity | null;
  /** Extra words beside the chip (e.g. "Manual entries"). */
  meta?: ReactNode;
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
          {identity || meta ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2" data-testid="account-head-identity">
              {identity ? <AccountChip identity={identity} /> : null}
              {meta}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-start gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
