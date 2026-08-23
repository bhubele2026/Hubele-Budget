import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  CHART,
  MORPH_MS,
  PREFERS_REDUCED_MOTION,
  REVEAL_MS,
  barColorForSign,
  barWidthPct,
  rampByRank,
} from "@/lib/chartTokens";

/**
 * `CssBars` — a ranked bar list built from plain DOM, not a charting library.
 *
 * **Why this exists (chart law 4).** Recharts restarts its draw animation on
 * every data-REFERENCE change. Any list that re-reads itself while the pointer
 * moves — "rest on a month, the biggest-charges list follows" — therefore
 * strobes under recharts: each hover snaps the bars back to zero and regrows
 * them. So hover-scrubbed and frequently-updating lists are CSS bars, always.
 *
 * **What makes it glide.** Every row is rendered on EVERY render and is never
 * unmounted; rows that fall out of the visible set go to `opacity: 0` and
 * become inert. Keeping their DOM identity is the whole trick — React never
 * tears a row down and rebuilds it, so a row entering or leaving simply fades
 * where it stands. Rank changes are a `translateY`, magnitude changes are a
 * `width`. Nothing reflows, nothing enters, nothing leaves.
 *
 * **Height is fixed** at `visibleCount * rowHeight`, so the card cannot resize
 * while the list re-reads under a moving cursor.
 *
 * Transition timing is expressed inline but reads `--ease-move` from the
 * global stylesheet with a local fallback, so the app's motion system can take
 * over the curve later without an inline style overriding it.
 */

/** One row. `id` must be STABLE across renders — it is the DOM identity that
 *  makes the glide work; never key on array position. */
export interface CssBarRow {
  id: string;
  label: string;
  /** Level (a total) or delta (a change), per `mode`. */
  value: number;
  /** Optional dim trailing text, e.g. the level behind a delta. */
  hint?: string;
}

const EASE_MOVE = "var(--ease-move, cubic-bezier(0.65, 0, 0.35, 1))";

/**
 * Bars sweep in fully on first paint, then tween at the faster morph speed for
 * every later change — replaying the full entrance on every hover would read
 * as lag, not polish.
 */
function useBarDuration(): number {
  const painted = useRef(false);
  const [dur, setDur] = useState(REVEAL_MS);
  useEffect(() => {
    if (painted.current) return;
    painted.current = true;
    const t = setTimeout(() => setDur(MORPH_MS), REVEAL_MS);
    return () => clearTimeout(t);
  }, []);
  return dur;
}

/** First paint draws bars from zero. Reduced motion starts them at full width. */
function useReveal(): boolean {
  const [revealed, setRevealed] = useState(PREFERS_REDUCED_MOTION);
  useEffect(() => {
    if (PREFERS_REDUCED_MOTION) return;
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return revealed;
}

export function CssBars({
  rows,
  mode = "level",
  format,
  topN,
  ramp = false,
  onPick,
  selectedId = null,
  rowHeight = 28,
  labelWidth = 150,
  valueWidth = 92,
  ariaLabel,
  className,
}: {
  /**
   * ALL candidate rows, in a STABLE identity order (e.g. sorted once by name
   * or by id). Do not re-sort this between renders — the component derives
   * rank itself and positions rows by transform; re-sorting the array would
   * swap DOM nodes and defeat the glide.
   */
  rows: CssBarRow[];
  /** "level" grows each bar from the left; "delta" diverges from a centre zero line. */
  mode?: "level" | "delta";
  /** Renders the number beside each bar. Colour is never the only signal. */
  format: (value: number) => string;
  /** Show only the top N by magnitude; the rest stay mounted but transparent. */
  topN?: number;
  /** Colour "level" bars by rank on the sequential NAVY_RAMP instead of by sign. */
  ramp?: boolean;
  onPick?: (id: string) => void;
  selectedId?: string | null;
  rowHeight?: number;
  labelWidth?: number;
  valueWidth?: number;
  ariaLabel?: string;
  className?: string;
}) {
  const revealed = useReveal();
  const dur = useBarDuration();

  // Rank + visibility, derived from magnitude. Keyed on a value fingerprint so
  // the memo survives a caller that rebuilds its rows array every render.
  const fp = rows.map((r) => `${r.id}:${r.value}`).join("|");
  const { rankOf, activeIds, max, visibleCount } = useMemo(() => {
    const ranked = [...rows].sort(
      (a, b) => Math.abs(Number(b.value)) - Math.abs(Number(a.value)),
    );
    const limit = topN == null ? ranked.length : Math.max(0, Math.min(topN, ranked.length));
    const shown = ranked.slice(0, limit);
    return {
      rankOf: new Map(shown.map((r, i) => [r.id, i])),
      activeIds: new Set(shown.map((r) => r.id)),
      // Scale to the VISIBLE rows only — a hidden row must not set the scale
      // for bars nobody can see.
      max: Math.max(1e-9, ...shown.map((r) => Math.abs(Number(r.value)))),
      visibleCount: shown.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, topN]);

  const isDelta = mode === "delta";
  const height = Math.max(1, visibleCount) * rowHeight;

  const rowTransition = PREFERS_REDUCED_MOTION
    ? undefined
    : `transform ${MORPH_MS}ms ${EASE_MOVE}, opacity ${MORPH_MS}ms ${EASE_MOVE}`;
  const barTransition = PREFERS_REDUCED_MOTION
    ? undefined
    : `width ${dur}ms ${EASE_MOVE}, left ${dur}ms ${EASE_MOVE}, background-color ${MORPH_MS}ms ${EASE_MOVE}`;

  return (
    <div
      className={cn("relative", className)}
      style={{ height }}
      role="list"
      aria-label={ariaLabel}
    >
      {/* The zero line for delta mode, drawn once behind the rows. This wrapper
          mirrors a row's column layout exactly so the hairline lands on the
          track's true midpoint at any card width. */}
      {isDelta && (
        <div
          className="pointer-events-none absolute inset-0 flex items-stretch gap-3 px-1"
          aria-hidden="true"
        >
          <span style={{ width: labelWidth }} className="shrink-0" />
          <span className="relative flex-1">
            <span
              className="absolute inset-y-0 left-1/2 w-px"
              style={{ background: CHART.grid }}
            />
          </span>
          <span style={{ width: valueWidth }} className="shrink-0" />
        </div>
      )}

      {rows.map((r) => {
        const v = Number(r.value) || 0;
        const rank = rankOf.get(r.id);
        const active = activeIds.has(r.id);
        const w = barWidthPct(v, max);
        const drawn = revealed ? w : 0;
        const color = ramp && !isDelta && rank != null
          ? rampByRank(rank, visibleCount)
          : barColorForSign(v);
        const selected = selectedId === r.id;
        const Tag = onPick ? "button" : "div";

        return (
          <Tag
            key={r.id}
            {...(onPick
              ? { type: "button" as const, onClick: () => onPick(r.id) }
              : { role: "listitem" })}
            aria-hidden={!active}
            tabIndex={onPick && active ? 0 : -1}
            title={`${r.label} — ${format(v)}`}
            className={cn(
              "absolute inset-x-0 flex items-center gap-3 rounded px-1 text-left",
              onPick && "hover:bg-muted/60 active:bg-muted",
              selected && "bg-primary/[0.06] ring-1 ring-inset ring-primary/20",
            )}
            style={{
              height: rowHeight,
              // Rank is a transform, never a reorder — the node stays put in
              // the DOM and slides to its new row.
              transform: `translateY(${(rank ?? visibleCount) * rowHeight}px)`,
              opacity: active ? 1 : 0,
              pointerEvents: active ? "auto" : "none",
              transition: rowTransition,
            }}
          >
            <span
              style={{ width: labelWidth }}
              className={cn(
                "shrink-0 truncate text-right text-xs",
                selected ? "font-semibold text-primary" : "text-muted-foreground",
              )}
            >
              {r.label}
            </span>

            <span className="relative h-[14px] flex-1">
              {isDelta ? (
                <span
                  className="absolute inset-y-0 rounded-sm"
                  style={{
                    background: color,
                    left: v >= 0 ? "50%" : `${50 - drawn / 2}%`,
                    width: `${drawn / 2}%`,
                    transition: barTransition,
                  }}
                />
              ) : (
                <span
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{
                    background: color,
                    width: `${drawn}%`,
                    transition: barTransition,
                  }}
                />
              )}
            </span>

            {/* Mono tabular numerals: the digits must not jitter sideways as
                values change under a moving cursor. */}
            <span
              style={{ width: valueWidth }}
              className="shrink-0 text-right font-mono text-xs tabular-nums"
            >
              <span
                className={cn(
                  "font-semibold",
                  isDelta && v > 0 && "text-primary",
                  isDelta && v < 0 && "text-[hsl(var(--negative))]",
                  isDelta && v === 0 && "text-muted-foreground",
                  !isDelta && "text-foreground",
                )}
              >
                {format(v)}
              </span>
              {r.hint && (
                <span className="ml-1.5 text-[11px] text-muted-foreground">
                  {r.hint}
                </span>
              )}
            </span>
          </Tag>
        );
      })}
    </div>
  );
}
