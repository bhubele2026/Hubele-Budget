import * as React from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The building block of the drill-through UI: a flat, hairline-bordered card
 * (no blur shadow) with an optional eyebrow, a big value slot, a mini-visual
 * slot, and a click/href target. Interactive variants show a right-chevron
 * and lift on hover via border + faint bg only — never a floating shadow.
 *
 *   <DrillCard eyebrow="Spending" value={<MoneyText amount={spend} />}
 *              visual={<StackBar segments={mix} />} href="/reports/spending" />
 */
export function DrillCard({
  eyebrow,
  value,
  sub,
  visual,
  href,
  onClick,
  accent,
  className,
  children,
  interactive,
}: {
  eyebrow?: React.ReactNode;
  /** The big headline slot (a MoneyText, a number, a label). */
  value?: React.ReactNode;
  /** Secondary line under the value. */
  sub?: React.ReactNode;
  /** Mini-visual slot (Sparkline / StackBar / RingStat / …). */
  visual?: React.ReactNode;
  href?: string;
  onClick?: () => void;
  /** Optional left identity stripe color (e.g. a card-brand token). */
  accent?: string;
  className?: string;
  children?: React.ReactNode;
  /** Force the interactive affordance even without href/onClick. */
  interactive?: boolean;
}) {
  const isInteractive = Boolean(href || onClick || interactive);

  const body = (
    <div
      className={cn(
        "group relative flex h-full flex-col gap-3 rounded-xl border border-card-border bg-card p-4 text-left transition-colors",
        isInteractive &&
          "cursor-pointer hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      style={
        accent
          ? { borderLeftColor: accent, borderLeftWidth: 3 }
          : undefined
      }
    >
      {(eyebrow || isInteractive) && (
        <div className="flex items-center justify-between gap-2">
          {eyebrow && (
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              {eyebrow}
            </span>
          )}
          {isInteractive && (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          )}
        </div>
      )}

      {value != null && (
        <div className="text-2xl font-bold tabular-nums leading-none">
          {value}
        </div>
      )}
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}

      {children}

      {visual && <div className="mt-auto pt-1">{visual}</div>}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block h-full no-underline">
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="block h-full w-full text-left"
      >
        {body}
      </button>
    );
  }
  return body;
}
