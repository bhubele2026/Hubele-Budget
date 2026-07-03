import * as React from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The command-center "at a glance" tile. Minimal, light, blended with the app's
 * frosted theme: a clean white card with a soft border, a muted icon chip
 * top-left, a chevron top-right (when interactive), an uppercase muted label, a
 * big dark value, and a muted subcaption. No gradients, no white-on-dark, no
 * sheen — quiet and consistent with every other card.
 *
 * `tone` is accepted for backward compatibility (StatTileRow still assigns it)
 * but no longer changes the fill — every tile reads the same calm way.
 */
export function StatTile({
  label,
  value,
  sub,
  icon,
  active = false,
  href,
  onClick,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  active?: boolean;
  /** Deprecated — no longer affects styling. Kept so callers/StatTileRow compile. */
  tone?: number;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const interactive = Boolean(href || onClick);

  const body = (
    <div
      className={cn(
        "group relative flex h-full min-h-[124px] flex-col justify-between gap-4 rounded-2xl border border-card-border bg-card p-4 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-200",
        active && "ring-2 ring-primary/40",
        // (Final wrapper) Interactive tiles lift + brighten on hover and give a
        // quiet press — tasteful, reduced-motion safe.
        interactive &&
          "cursor-pointer hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:translate-y-0 active:scale-[0.99] motion-reduce:transform-none motion-reduce:transition-none",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {icon && (
          <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-muted text-muted-foreground [&_svg]:h-5 [&_svg]:w-5">
            {icon}
          </span>
        )}
        {interactive && (
          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        )}
      </div>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div className="mt-1 text-[2rem] md:text-[2.4rem] font-bold tabular-nums leading-none text-foreground">
          {value}
        </div>
        {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
      </div>
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
      <button type="button" onClick={onClick} className="block h-full w-full text-left">
        {body}
      </button>
    );
  }
  return body;
}

/**
 * Responsive row of StatTiles — the page-top "at a glance" strip.
 */
export function StatTileRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 stagger-children",
        className,
      )}
    >
      {children}
    </div>
  );
}
