import * as React from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The signature command-center "at a glance" tile (KFI / BH Studio). A card
 * with an icon chip top-left, a chevron top-right, an uppercase muted label, a
 * huge value, and a muted subcaption. The ACTIVE tile wears the teal
 * hero gradient; inactive tiles are calm card surfaces. Drop a row of these at
 * the top of a page via <StatTileRow>.
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
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const interactive = Boolean(href || onClick);

  const body = (
    <div
      className={cn(
        "group relative flex h-full flex-col gap-3 rounded-2xl border p-4 text-left transition-all",
        active
          ? "stat-hero glass-surface"
          : "glass-surface bg-card hover:border-primary/40",
        interactive && "cursor-pointer",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {icon && (
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-xl",
              active ? "bg-white/15 text-white" : "bg-primary/10 text-primary",
            )}
          >
            {icon}
          </span>
        )}
        {interactive && (
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5",
              active ? "text-white/70" : "text-muted-foreground",
            )}
          />
        )}
      </div>
      <div>
        <div
          className={cn(
            "text-[11px] font-medium uppercase tracking-widest",
            active ? "stat-hero-muted" : "text-muted-foreground",
          )}
        >
          {label}
        </div>
        <div className="mt-1 text-2xl md:text-[1.7rem] font-bold tabular-nums leading-none">
          {value}
        </div>
        {sub && (
          <div
            className={cn(
              "mt-1.5 text-xs",
              active ? "stat-hero-muted" : "text-muted-foreground",
            )}
          >
            {sub}
          </div>
        )}
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

/** Responsive row of StatTiles — the page-top "at a glance" strip. */
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
