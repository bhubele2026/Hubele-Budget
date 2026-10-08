import type { ReactNode } from "react";
import { Link } from "wouter";
import { cx } from "@/lib/cx";
import { prefetchRoute } from "@/lib/routePrefetch";

export type AskSection = "ask" | "memory";

const SECTIONS: ReadonlyArray<{ key: AskSection; href: string; label: string }> = [
  { key: "ask", href: "/ask", label: "Ask" },
  { key: "memory", href: "/ask/memory", label: "What H2 remembers" },
];

/** The two Ask pages as text links; on a phone a two-part bar. */
export function AskNav({ current }: { current: AskSection }) {
  return (
    <nav aria-label="Ask sections" data-testid="ask-nav">
      <ul className="flex overflow-hidden rounded-1 border border-rule-strong md:gap-6 md:overflow-visible md:rounded-none md:border-0">
        {SECTIONS.map((s) => {
          const active = s.key === current;
          return (
            <li key={s.key} className="flex-auto md:flex-none">
              <Link
                href={s.href}
                aria-current={active ? "page" : undefined}
                onMouseEnter={() => prefetchRoute(s.href)}
                onFocus={() => prefetchRoute(s.href)}
                data-testid={`ask-nav-${s.key}`}
                className={cx(
                  "block whitespace-nowrap px-2 py-2 text-center type-label md:p-0 md:pb-1 md:text-left",
                  active ? "bg-moss-wash text-moss-ink md:border-b-2 md:border-moss md:bg-transparent md:text-ink" : "text-ink-2 hover:text-ink",
                )}
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AskFrame({ current, children }: { current: AskSection; children: ReactNode }) {
  return (
    <div className="flex flex-col" data-testid={`ask-${current}`}>
      <header className="mb-6 flex flex-col gap-4">
        <h1 className="type-headline text-ink">Ask</h1>
        <AskNav current={current} />
      </header>
      {children}
    </div>
  );
}
