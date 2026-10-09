import type { CSSProperties, ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { AccountAccentName } from "@/lib/accountIdentity";

export type PanelSpan = 3 | 4 | 6 | 8 | 12;

/**
 * - `flush`: no body padding — tables and ledgers draw edge to edge and pad
 *   their own cells.
 * - `sticky-safe`: clips with `overflow: clip` instead of `hidden`, so a
 *   `position: sticky` row inside (a ledger's bulk bar) sticks to `<main>`
 *   rather than to the panel (index.css, `.panel-sticky-safe`).
 * - `static`: no hover lift — for a panel that is not itself a destination.
 */
export type PanelVariant = "flush" | "sticky-safe" | "static";

const SPAN: Record<PanelSpan, string> = {
  3: "span-3", 4: "span-4", 6: "span-6", 8: "span-8", 12: "span-12",
};
const ACCENT: Record<AccountAccentName, string> = {
  checking: "panel-accent-checking",
  amex: "panel-accent-amex",
  card2: "panel-accent-card2",
  other: "panel-accent-other",
};

export type PanelProps = {
  /** Usually a string. (C13) A node lets a page hide the words visually on a
   *  phone while the heading keeps its name (the forecast register panel,
   *  whose view tabs fill a phone-width head). */
  title: ReactNode;
  sub?: string;
  accent?: AccountAccentName;
  actions?: ReactNode;
  to?: string;
  span?: PanelSpan;
  /** One variant or several (`["sticky-safe", "flush"]`). */
  variant?: PanelVariant | readonly PanelVariant[];
  className?: string;
  /** Extra classes and style for the body (the box under the head). */
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  children: ReactNode;
  "data-testid"?: string;
};

function variantsOf(v: PanelProps["variant"]): ReadonlySet<PanelVariant> {
  return new Set(v == null ? [] : typeof v === "string" ? [v] : v);
}

/** A titled card on the grid. `accent` paints the 4 px identity edge; `to`
 *  turns the title into a link to the full page; `actions` sit in the head. */
export function Panel(props: PanelProps) {
  const v = variantsOf(props.variant);
  const title = props.to ? (
    <Link
      href={props.to}
      className="rounded-control text-title font-semibold text-brand-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
    >
      {props.title}
    </Link>
  ) : (
    <h2 className="text-title font-semibold text-brand-navy">{props.title}</h2>
  );
  return (
    <section
      data-testid={props["data-testid"]}
      className={cn(
        "panel",
        !v.has("static") && "panel-link",
        v.has("sticky-safe") && "panel-sticky-safe",
        v.has("flush") && "panel-flush",
        props.accent && ACCENT[props.accent],
        props.span && SPAN[props.span],
        props.className,
      )}
    >
      <header className="panel-head">
        <div className="min-w-0 flex-1">
          {title}
          {props.sub ? <p className="text-micro text-neutral-500">{props.sub}</p> : null}
        </div>
        {props.actions ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
      </header>
      <div className={cn(!v.has("flush") && "p-4", props.bodyClassName)} style={props.bodyStyle}>
        {props.children}
      </div>
    </section>
  );
}

/**
 * A panel whose body has a FIXED height, so a chart's `ResponsiveContainer`
 * (which measures its parent) always has a sized box to fill — never 0 px on
 * the first frame, never a height that grows with its own content. No chart
 * library is imported here: this is just the box, safe on any chunk.
 */
export function ChartPanel({
  height = 280,
  ...props
}: Omit<PanelProps, "bodyStyle"> & { height?: number }) {
  return (
    <Panel
      {...props}
      bodyClassName={cn("relative w-full min-w-0", props.bodyClassName)}
      bodyStyle={{ height }}
    />
  );
}

/**
 * A flush panel for tables: an optional header row of column labels, then the
 * rows. With `maxHeight` the rows scroll inside the panel under a header row
 * that stays put; without it the panel grows with its rows (pair it with
 * `variant="sticky-safe"` when a sticky row inside must stick to `<main>`).
 */
export function TablePanel({
  head,
  maxHeight,
  children,
  variant,
  ...props
}: Omit<PanelProps, "bodyStyle" | "bodyClassName"> & {
  head?: ReactNode;
  maxHeight?: number | string;
}) {
  const extra = variant == null ? [] : typeof variant === "string" ? [variant] : variant;
  return (
    <Panel {...props} variant={["flush", ...extra]}>
      {head ? (
        <div
          data-testid="table-panel-head"
          className="border-b border-brand-line bg-platinum-2 px-4 py-2 text-micro font-semibold uppercase tracking-wide text-neutral-500"
        >
          {head}
        </div>
      ) : null}
      <div
        data-testid="table-panel-rows"
        className={maxHeight != null ? "overflow-y-auto" : undefined}
        style={maxHeight != null ? { maxHeight } : undefined}
      >
        {children}
      </div>
    </Panel>
  );
}
