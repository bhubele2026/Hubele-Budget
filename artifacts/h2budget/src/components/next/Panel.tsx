import type { CSSProperties, ReactNode, Ref } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { useRise } from "@/lib/motion";
import type { AccountAccentName } from "@/lib/accountIdentity";

export type PanelSpan = 3 | 4 | 5 | 6 | 7 | 8 | 12;

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
  3: "span-3", 4: "span-4", 5: "span-5", 6: "span-6", 7: "span-7", 8: "span-8", 12: "span-12",
};
const ACCENT: Record<AccountAccentName, string> = {
  checking: "panel-accent-checking",
  amex: "panel-accent-amex",
  card2: "panel-accent-card2",
  other: "panel-accent-other",
};
/** (2026-11-12) An account's identity on a panel: a small dot before the title, not a 4 px edge. */
const DOT: Record<AccountAccentName, string> = {
  checking: "bg-acct-checking",
  amex: "bg-acct-amex",
  card2: "bg-acct-card2",
  other: "bg-acct-other",
};
/** The one panel heading voice: 15/600 charcoal. */
const TITLE = "text-title font-semibold text-foreground";

export type PanelProps = {
  /** Usually a string. (C13) A node lets a page hide the words visually on a
   *  phone while the heading keeps its name (the forecast register panel,
   *  whose view tabs fill a phone-width head). */
  title: ReactNode;
  sub?: string;
  /** (Q6b) Lets code move keyboard focus to the heading (tabIndex -1, visible ring) after a jump or a retry. */
  titleRef?: Ref<HTMLHeadingElement>;
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

/** A titled section on the grid (flat white, hairline border, 8 px corner).
 *  `accent` puts the account's identity dot before the title; `to` turns the
 *  title into a link to the full page; `actions` sit in the head. */
export function Panel(props: PanelProps) {
  const v = variantsOf(props.variant);
  const dot = props.accent ? (
    <span aria-hidden data-testid="panel-accent-dot" className={cn("mr-2 inline-block size-2 shrink-0 rounded-full align-middle", DOT[props.accent])} />
  ) : null;
  const title = props.to ? (
    <Link
      href={props.to}
      className={cn("rounded-control hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40", TITLE)}
    >
      {dot}
      {props.title}
    </Link>
  ) : (
    <h2
      ref={props.titleRef}
      tabIndex={props.titleRef ? -1 : undefined}
      className={cn(TITLE, props.titleRef && "rounded-control focus:outline-none focus:ring-2 focus:ring-brand-navy/40")}
    >
      {dot}
      {props.title}
    </h2>
  );
  // (Every click glides) It rises once, with its page, on the page's stagger.
  // ⚠️ Not a sticky-safe panel: it hosts sticky rows and the register's drag overlay, and a transform mid-rise would
  // re-anchor them.
  const risen = useRise();
  const rise = v.has("sticky-safe") ? {} : risen;
  return (
    <section
      data-testid={props["data-testid"]}
      style={rise.style}
      className={cn(
        "panel",
        rise.className,
        !v.has("static") && props.to && "panel-link",
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
          {props.sub ? <p className="text-micro text-neutral-600">{props.sub}</p> : null}
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
          className="border-b border-brand-line px-4 py-2 text-micro font-medium text-neutral-500"
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

/**
 * ⭐ A SECTION INSIDE A PANEL (2026-11-12): sections are split by a hairline,
 * never by a card inside a card. An optional small heading row; the body pads
 * itself unless `flush`.
 */
export function PanelSection({
  title,
  actions,
  flush = false,
  className,
  children,
  "data-testid": testId,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <section className={cn("border-t border-brand-line first:border-t-0", className)} data-testid={testId}>
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3">
          {title ? <h3 className="text-label font-semibold text-foreground">{title}</h3> : <span />}
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(!flush && "px-4 py-3")}>{children}</div>
    </section>
  );
}
