import type { ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { AccountAccentName } from "@/lib/accountIdentity";

export type PanelSpan = 3 | 4 | 6 | 8 | 12;

const SPAN: Record<PanelSpan, string> = {
  3: "span-3", 4: "span-4", 6: "span-6", 8: "span-8", 12: "span-12",
};
const ACCENT: Record<AccountAccentName, string> = {
  checking: "panel-accent-checking",
  amex: "panel-accent-amex",
  card2: "panel-accent-card2",
  other: "panel-accent-other",
};

/** A titled card on the grid. `accent` paints the 4 px identity edge; `to`
 *  turns the title into a link to the full page; `actions` sit in the head. */
export function Panel(props: {
  title: string;
  sub?: string;
  accent?: AccountAccentName;
  actions?: ReactNode;
  to?: string;
  span?: PanelSpan;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
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
        "panel panel-link",
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
      <div className="p-4">{props.children}</div>
    </section>
  );
}
