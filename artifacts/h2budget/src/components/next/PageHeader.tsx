import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * ⭐ THE PAGE HEADER (owner, 2026-11-12: "a consistent page header — title,
 * period/context, actions"). One shape on every page that adopts it:
 *
 *   Title · context                                   [meta] [actions]
 *   [toolbar — period, filters, search: one coordinated row]
 *
 * - `title` is the page's one h1 (22/600, charcoal).
 * - `context` sits beside the title in the supporting grey: the day, the
 *   account, the period ("Today · Thu Nov 12", "Checking ••4821").
 * - `meta` is freshness and state, small, before the actions ("Updated 12 h
 *   ago · 1 pending") — information, never hidden to tidy a screenshot.
 * - `actions` are the page's own buttons (Sync, Add, the one thing to do).
 * - `help` sits right after the title, outside the h1 (its accessible name stays
 *   exactly the title): a `<Help>` "?" that explains the page.
 * - `children` is the toolbar row under it (`Toolbar`).
 * On a phone the actions wrap under the title; nothing is dropped.
 */
export function PageHeader({
  title,
  context,
  meta,
  actions,
  icon,
  help,
  children,
  className,
  titleTestId,
  "data-testid": testId,
}: {
  title: ReactNode;
  context?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** A brand mark before the title (an account page's bank). */
  icon?: ReactNode;
  /** A "?" beside the title, outside the heading. */
  help?: ReactNode;
  children?: ReactNode;
  className?: string;
  titleTestId?: string;
  "data-testid"?: string;
}) {
  return (
    <header className={cn("space-y-3", className)} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          {icon ? (
            <span className="inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-control bg-white ring-1 ring-brand-line">
              {icon}
            </span>
          ) : null}
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-display font-semibold text-foreground" data-testid={titleTestId}>
              {title}
              {context ? <span className="font-normal text-neutral-500"> · {context}</span> : null}
            </h1>
            {help}
          </div>
        </div>
        {meta || actions ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {meta ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-neutral-600">{meta}</div> : null}
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        ) : null}
      </div>
      {children}
    </header>
  );
}
