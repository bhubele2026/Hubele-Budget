import * as React from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const TILE_GRADS = 6;

/**
 * The signature command-center "at a glance" tile (KFI / BH Studio). A juicy
 * gradient card with an icon chip top-left, a chevron top-right, an uppercase
 * label, a huge value, and a subcaption pinned to the bottom. Each tile wears
 * its own vibrant summer gradient — pass `tone` (an index) to pick one, or drop
 * a row of these in <StatTileRow> and the gradients auto-rotate. The whole app
 * is flat/square; these tiles are the deliberate rounded, lifted hero moment.
 */
export function StatTile({
  label,
  value,
  sub,
  icon,
  active = false,
  tone = 0,
  href,
  onClick,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  active?: boolean;
  /** Which summer gradient to wear (0–5, wraps). Usually set by StatTileRow. */
  tone?: number;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const interactive = Boolean(href || onClick);
  const grad = `tile-grad-${((tone % TILE_GRADS) + TILE_GRADS) % TILE_GRADS}`;

  const body = (
    <div
      className={cn(
        "stat-card group relative flex h-full min-h-[120px] flex-col justify-between gap-5 p-4 text-left",
        grad,
        active && "ring-2 ring-white/70",
        interactive && "cursor-pointer",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {icon && (
          <span className="flex h-9 w-9 items-center justify-center rounded-[12px] bg-white/20 text-white backdrop-blur-sm">
            {icon}
          </span>
        )}
        {interactive && (
          <ChevronRight className="h-4 w-4 shrink-0 text-white/75 transition-transform group-hover:translate-x-0.5" />
        )}
      </div>
      <div>
        <div className="text-[11px] font-medium uppercase tracking-widest text-white/75">
          {label}
        </div>
        <div className="mt-1 text-2xl md:text-[1.7rem] font-bold tabular-nums leading-none text-white">
          {value}
        </div>
        {sub && <div className="mt-1.5 text-xs text-white/75">{sub}</div>}
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
 * Responsive row of StatTiles — the page-top "at a glance" strip. Auto-assigns
 * a rotating gradient `tone` to each child tile (unless the child already set
 * one) so a row reads as four distinct summer gradients out of the box.
 */
export function StatTileRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  let i = 0;
  const toned = React.Children.map(children, (child) => {
    if (
      React.isValidElement(child) &&
      child.type === StatTile &&
      (child.props as { tone?: number }).tone === undefined
    ) {
      return React.cloneElement(child as React.ReactElement<{ tone?: number }>, {
        tone: i++,
      });
    }
    return child;
  });

  return (
    <div
      className={cn(
        "grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 stagger-children",
        className,
      )}
    >
      {toned}
    </div>
  );
}
