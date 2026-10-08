import type { ReactNode } from "react";
import { Link } from "wouter";
import { cx } from "@/lib/cx";
import { prefetchRoute } from "@/lib/routePrefetch";

export type HouseholdSection = "banks" | "members";

const SECTIONS: ReadonlyArray<{ key: HouseholdSection; href: string; label: string }> = [
  { key: "banks", href: "/household", label: "Banks" },
  { key: "members", href: "/household/members", label: "Members" },
];

/** The two Household pages as text links; on a phone a two-part bar. */
export function HouseholdNav({ current }: { current: HouseholdSection }) {
  return (
    <nav aria-label="Household sections" data-testid="household-nav">
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
                data-testid={`household-nav-${s.key}`}
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

export function HouseholdFrame({ current, children }: { current: HouseholdSection; children: ReactNode }) {
  return (
    <div className="flex flex-col" data-testid={`household-${current}`}>
      <header className="mb-6 flex flex-col gap-4">
        <h1 className="type-headline text-ink">Household</h1>
        <HouseholdNav current={current} />
      </header>
      {children}
    </div>
  );
}

/** A switch that reads as a word, as in What's new. */
export function SwitchRow({
  label,
  on,
  onChange,
  disabled,
  hint,
  "data-testid": testId,
}: {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        data-testid={testId}
        className="inline-flex h-10 items-center gap-3 self-start rounded-1 border border-rule-strong bg-paper-0 px-3 type-label text-ink hover:bg-paper-1 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span aria-hidden className={cx("inline-block size-2 rounded-full", on ? "bg-moss" : "border-2 border-rule-strong")} />
        {label}: {on ? "On" : "Off"}
      </button>
      {hint && <p className="type-caption text-ink-3">{hint}</p>}
    </div>
  );
}
