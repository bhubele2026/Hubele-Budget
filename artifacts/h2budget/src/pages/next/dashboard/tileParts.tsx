import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { warmHandlers, warmRoute } from "@/lib/warmRoutes";
import { cn } from "@/lib/utils";
import { figLabel } from "@/ui";
import { glowAt, RollIf } from "@/lib/motion";
import { money } from "./shared";

/** The tile shell and its small parts, shared by Tiles.tsx and the lazy week tile. */

type Tone = "ok" | "bad" | "neutral";
type Accent = "checking" | "amex" | "other";

// Literal class names so Tailwind sees them. (2026-11-12) An account's
// identity is a small dot before the title, no longer a 4 px card edge.
const DOT: Record<Accent, string> = {
  checking: "bg-acct-checking",
  amex: "bg-acct-amex",
  other: "bg-acct-other",
};
const CHIP: Record<Tone, string> = {
  ok: "bg-acct-checking-bg text-brand-navy",
  bad: "bg-bad-bg text-bad-ink",
  neutral: "bg-platinum-3 text-neutral-600",
};

export interface TileStatus { word: string; tone: Tone }

export function Tile({
  testid, title, sub, href, accent, status, children, why, index, box = "span-4 min-h-[11.5rem]", body, cell = false,
}: {
  testid: string;
  title: ReactNode;
  /** Account identity or one short line under the title. */
  sub?: ReactNode;
  href: string;
  accent: Accent;
  status?: TileStatus | null;
  children: ReactNode;
  why?: ReactNode;
  index: number;
  /** The tile's place and size in its grid. The six tiles keep the default; the four numbers pass their own. */
  box?: string;
  /** Extra classes for the tile's body (the four numbers sit their figure at the bottom on a phone, so a two-line title beside a one-line one still leaves the row's figures level). */
  body?: string;
  /** (2026-11-12) A CELL of one summary group (`FOUR_GRID`): no panel of its own — the group is the panel and
   *  hairlines split the cells. The title becomes the figure's label. */
  cell?: boolean;
}) {
  const qc = useQueryClient();
  void index; // (2026-11-12) no entrance stagger: the box is simply there.
  return (
    <div
      data-testid={`tile-${testid}`}
      onPointerMove={glowAt}
      className={cn(
        "glow-host press group relative flex flex-col",
        cell
          ? "gap-2 transition-colors hover:bg-brand-tint focus-within:bg-brand-tint"
          : "panel gap-3 p-4 transition-colors hover:border-neutral-300 focus-within:border-neutral-300",
        box,
      )}
    >
      {/* (Every click glides) The dashboard's hover glow: a soft navy light that follows the pointer, under the words. */}
      <span aria-hidden className="tile-glow pointer-events-none absolute inset-0 -z-10" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className={cell ? "text-micro font-medium text-neutral-600" : "text-body font-semibold text-foreground"}>
            <span aria-hidden className={cn("mr-1.5 inline-block size-2 rounded-full align-[0.05em]", DOT[accent])} />
            <Link
              href={href}
              data-testid={`tile-${testid}-link`}
              {...warmHandlers((h) => warmRoute(qc, h), href)}
              className="rounded-control after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand-navy/50 focus-visible:after:rounded-[inherit]"
            >
              {title}
            </Link>
          </h2>
          {sub ? <div className="mt-0.5 text-micro text-neutral-600 [overflow-wrap:anywhere]">{sub}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status ? (
            <span data-testid={`tile-${testid}-status`} data-tone={status.tone} className={cn("rounded-[4px] px-1.5 py-px text-micro font-medium", CHIP[status.tone])}>
              {status.word}
            </span>
          ) : null}
          <span aria-hidden className="text-neutral-500 transition-colors group-hover:text-brand-navy">→</span>
        </div>
      </div>
      <div className={cn("flex flex-1 flex-col gap-2", body)}>{children}</div>
      {why ? <div className="relative z-10 text-micro text-neutral-600">{why}</div> : null}
    </div>
  );
}

/** One named figure. `value` null draws an em dash; `tone` bad takes the rust. No `label`: the tile's title names it. */
export function Fig({ label, value, tone = "neutral", big = false, testid }: {
  label?: string; value: ReactNode; tone?: "neutral" | "bad"; big?: boolean; testid?: string;
}) {
  return (
    <div className="min-w-0">
      {label ? <div className={figLabel}>{label}</div> : null}
      <div
        data-testid={testid}
        className={cn("fig font-semibold", big ? "text-kpi" : "text-body", tone === "bad" ? "text-bad-ink" : "text-foreground")}
      >
        <RollIf value={value} />
      </div>
    </div>
  );
}

/** (Home is four numbers; ONE summary group, 2026-11-12) The four figures in ONE flat panel, split by hairlines
 *  (`.kpi-grid`): two by two on a phone, one row of four from 1024 px. */
export const FOUR_GRID = "span-12 panel kpi-grid grid grid-cols-2 lg:grid-cols-4";
/** One of the four cells: label · figure · one line, the same height across the row. */
export const FOUR_BOX = "min-h-[7rem]";
/** (Home says less) A cell that also carries a thin bar under its number: the bar's height and gap, held from the skeleton on. */
export const FOUR_BOX_BAR = "min-h-[7.75rem] lg:min-h-[7.5rem]";
/** On a phone the four boxes are two by two and a title may take two lines: the number and its line sit at the bottom, level across the row. */
export const FOUR_BODY = "max-lg:justify-end";

/**
 * (Home says less, 2026-11-11) ONE quantity against ONE ceiling as a thin bar: the landing's own small copy of
 * `CssFillMeter` (`lib/cssBars.tsx`), same look and same two motion classes, written with colour tokens only so
 * the open path does not carry the chart tokens. Navy under the plan; past it, the one deep orange, the track
 * rescales to the actual and a hairline marks where the plan ran out. `aria-hidden`: the box says the state in
 * words beside it. No entrance sweep (2026-11-12); `.bar-sweep` tweens a later change of width (off under reduced
 * motion, `index.css`).
 */
export function FillBar({ value, ceiling }: { value: number; ceiling: number }) {
  const v = Math.max(0, Number(value) || 0);
  const plan = Number(ceiling) || 0;
  const ratio = plan > 0 ? v / plan : 0;
  const over = ratio > 1;
  const fillPct = plan <= 0 ? 0 : over ? 100 : Math.min(100, ratio * 100);
  return (
    <div aria-hidden="true" data-over={over ? "true" : undefined} className="relative h-1.5 w-full overflow-hidden rounded-full bg-brand-line">
      <span
        className={cn("bar-sweep absolute inset-y-0 left-0 rounded-full", over ? "bg-brand-orange-deep" : "bg-brand-fill")}
        style={{ width: `${fillPct}%` }}
      />
      {over ? <span className="absolute inset-y-0 w-px bg-white/75" style={{ left: `${(1 / ratio) * 100}%` }} /> : null}
    </div>
  );
}

export const Skel = () => <span className="skeleton block h-7 w-28 rounded" aria-busy="true" />;

export function Why({ children }: { children: ReactNode }) {
  return (
    <details className="group/why">
      <summary className="inline cursor-pointer list-none font-medium text-brand-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 rounded-control">
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

