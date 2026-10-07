import type { ReactNode } from "react";
import { Link } from "wouter";
import { cx } from "@/lib/cx";
import { prefetchRoute } from "@/lib/routePrefetch";
import { DESTINATIONS, isActive } from "./destinations";

/**
 * ⭐ THE MASTHEAD — the wordmark and, on a desktop, the four destinations as
 * text links. The current one carries a thin moss rule beneath it. Phones get
 * the wordmark and the account control here and the destinations in the Dock.
 *
 * Destinations that have not shipped are plain text marked "soon" with
 * `aria-disabled`, not links that lead nowhere.
 */
export function Masthead({ location, account }: { location: string; account?: ReactNode }) {
  return (
    <header className="border-b border-rule bg-paper-0" data-testid="masthead">
      <div className="mx-auto flex h-14 w-full max-w-read items-center gap-8 px-4 sm:px-8">
        <Link
          href="/"
          className="type-headline leading-none font-semibold text-ink"
          aria-label="H2, go to Today"
          data-testid="wordmark"
        >
          H<span className="text-moss">2</span>
        </Link>
        <nav aria-label="Primary" className="hidden h-full md:block" data-testid="masthead-nav">
          <ul className="flex h-full items-stretch gap-6">
            {DESTINATIONS.map((d) => {
              const active = d.live && isActive(location, d.href);
              return (
                <li key={d.key} className="relative flex items-center">
                  {d.live ? (
                    <Link
                      href={d.href}
                      aria-current={active ? "page" : undefined}
                      onMouseEnter={() => prefetchRoute(d.href)}
                      onFocus={() => prefetchRoute(d.href)}
                      className={cx("type-label", active ? "text-ink" : "text-ink-2 hover:text-ink")}
                      data-testid={`masthead-${d.key}`}
                    >
                      {d.label}
                    </Link>
                  ) : (
                    <span
                      role="link"
                      aria-disabled="true"
                      className="type-label text-ink-3"
                      data-testid={`masthead-${d.key}`}
                    >
                      {d.label} <span className="type-caption">soon</span>
                    </span>
                  )}
                  {active && <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-moss" />}
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="ml-auto flex items-center">{account}</div>
      </div>
    </header>
  );
}
