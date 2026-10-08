import { Link } from "wouter";
import { cx } from "@/lib/cx";
import { prefetchRoute } from "@/lib/routePrefetch";
import type { SegmentedOption } from "./Segmented";

/**
 * The sections of one destination as a row of text links, the current one
 * underlined by a moss rule (and `aria-current`). Desktop only: a phone gets
 * the same options as a Segmented row.
 */
export function SectionIndex<K extends string>({
  label,
  options,
  value,
  "data-testid": testId,
}: {
  label: string;
  options: readonly (SegmentedOption<K> & { href: string })[];
  value: K;
  "data-testid"?: string;
}) {
  return (
    <nav aria-label={label} data-testid={testId}>
      <ul className="flex items-stretch gap-6 border-b border-rule">
        {options.map((o) => {
          const on = o.key === value;
          return (
            <li key={o.key} className="relative">
              <Link
                href={o.href}
                aria-current={on ? "page" : undefined}
                onMouseEnter={() => prefetchRoute(o.href)}
                onFocus={() => prefetchRoute(o.href)}
                className={cx("flex items-center gap-1 py-2 type-label", on ? "text-ink" : "text-ink-2 hover:text-ink")}
              >
                {o.label}
                {o.badge != null && o.badge > 0 && <span className="tnum text-ink-2">{o.badge}</span>}
              </Link>
              {on && <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-moss" />}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
