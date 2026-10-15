import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { warmHandlers, warmRoute } from "@/lib/warmRoutes";
import { cn } from "@/lib/utils";
import { figLabel } from "@/ui";
import { money, rise } from "./shared";

/** The tile shell and its small parts, shared by Tiles.tsx and the lazy week tile. */

type Tone = "ok" | "bad" | "neutral";
type Accent = "checking" | "amex" | "other";

// Literal class names so Tailwind sees them.
const EDGE: Record<Accent, string> = {
  checking: "border-l-acct-checking",
  amex: "border-l-acct-amex",
  other: "border-l-acct-other",
};
const CHIP: Record<Tone, string> = {
  ok: "bg-acct-checking-bg text-brand-navy",
  bad: "bg-bad-bg text-bad-ink",
  neutral: "bg-platinum-3 text-neutral-600",
};

export interface TileStatus { word: string; tone: Tone }

export function Tile({
  testid, title, sub, href, accent, status, children, why, index,
}: {
  testid: string;
  title: string;
  /** Account identity or one short line under the title. */
  sub?: ReactNode;
  href: string;
  accent: Accent;
  status?: TileStatus | null;
  children: ReactNode;
  why?: ReactNode;
  index: number;
}) {
  const qc = useQueryClient();
  return (
    <div
      data-testid={`tile-${testid}`}
      className={cn(
        "panel group span-4 relative flex min-h-[11.5rem] flex-col gap-3 border-l-4 p-4",
        EDGE[accent],
        "transition-[transform,box-shadow] duration-200 motion-safe:hover:-translate-y-0.5 hover:shadow-[var(--shadow-milled-lift)] focus-within:shadow-[var(--shadow-milled-lift)]",
        rise(index),
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-body font-semibold text-brand-navy">
            <Link
              href={href}
              data-testid={`tile-${testid}-link`}
              {...warmHandlers((h) => warmRoute(qc, h), href)}
              className="rounded-control after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-brand-navy/50 focus-visible:after:rounded-[inherit]"
            >
              {title}
            </Link>
          </h2>
          {sub ? <div className="mt-0.5 text-micro text-neutral-600 [overflow-wrap:anywhere]">{sub}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status ? (
            <span data-testid={`tile-${testid}-status`} data-tone={status.tone} className={cn("rounded-full px-2 py-0.5 text-micro font-semibold", CHIP[status.tone])}>
              {status.word}
            </span>
          ) : null}
          <span aria-hidden className="text-neutral-400 transition-transform motion-safe:group-hover:translate-x-0.5">→</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2">{children}</div>
      {why ? <div className="relative z-10 text-micro text-neutral-600">{why}</div> : null}
    </div>
  );
}

/** One named figure. `value` null draws an em dash; `tone` bad takes the rust. */
export function Fig({ label, value, tone = "neutral", big = false, testid }: {
  label: string; value: ReactNode; tone?: "neutral" | "bad"; big?: boolean; testid?: string;
}) {
  return (
    <div className="min-w-0">
      <div className={figLabel}>{label}</div>
      <div
        data-testid={testid}
        className={cn("font-mono font-semibold tabular-nums", big ? "text-kpi" : "text-body", tone === "bad" ? "text-bad-ink" : "text-brand-navy")}
      >
        {value}
      </div>
    </div>
  );
}

export const Skel = () => <span className="skeleton block h-7 w-28 rounded" aria-busy="true" />;

export function Why({ children }: { children: ReactNode }) {
  return (
    <details className="group/why">
      <summary className="inline cursor-pointer list-none font-semibold text-brand-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 rounded-control">
        Why?
      </summary>
      <p className="mt-1 max-w-xs">{children}</p>
    </details>
  );
}

/** left/over as one phrase: the server's remaining figure, said by sign. */
export function leftOver(remaining: number): { text: string; over: boolean } {
  return remaining < 0 ? { text: `Over ${money(-remaining)}`, over: true } : { text: `${money(remaining)} left`, over: false };
}

