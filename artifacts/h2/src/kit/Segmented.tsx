import { Link } from "wouter";
import { cx } from "@/lib/cx";
import { prefetchRoute } from "@/lib/routePrefetch";

export interface SegmentedOption<K extends string> {
  key: K;
  label: string;
  /** With an href the option is a link (navigation); without, a pressed-state button. */
  href?: string;
  /** A count shown beside the label when above zero. */
  badge?: number;
}

/**
 * A short row of mutually exclusive choices, set in a hairline box. The phone's
 * version of the SectionIndex, and the range chips on the ledger. The chosen
 * one is shaded AND carries `aria-pressed` / `aria-current`, never colour alone.
 */
export function Segmented<K extends string>({
  label,
  options,
  value,
  onChange,
  className,
  "data-testid": testId,
}: {
  label: string;
  options: readonly SegmentedOption<K>[];
  value: K;
  onChange?: (key: K) => void;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx("inline-flex overflow-hidden rounded-1 border border-rule-strong", className)}
      data-testid={testId}
    >
      {options.map((o) => {
        const on = o.key === value;
        const cls = cx(
          "flex h-8 items-center gap-1 whitespace-nowrap border-l border-rule-strong px-3 type-label first:border-l-0",
          on ? "bg-paper-2 text-ink" : "bg-paper-0 text-ink-2 hover:bg-paper-1",
        );
        const face = (
          <>
            {o.label}
            {o.badge != null && o.badge > 0 && <span className="tnum text-ink-2">{o.badge}</span>}
          </>
        );
        return o.href ? (
          <Link
            key={o.key}
            href={o.href}
            aria-current={on ? "page" : undefined}
            onMouseEnter={() => prefetchRoute(o.href!)}
            onFocus={() => prefetchRoute(o.href!)}
            className={cls}
          >
            {face}
          </Link>
        ) : (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange?.(o.key)} className={cls}>
            {face}
          </button>
        );
      })}
    </div>
  );
}
