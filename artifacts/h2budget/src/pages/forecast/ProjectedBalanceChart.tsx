import { useMemo } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ReferenceDot,
  Label as RechartsLabel,
} from "recharts";
import {
  ANIM_AREA,
  AXIS_TICK,
  CHART,
  compactUSD,
  niceAxis,
  useXTicks,
} from "@/lib/charts";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { PlanLine } from "@/lib/forecastMatch";

/**
 * ⭐ THE CASH CURVE — the one chart on the most-used screen in the app.
 *
 * Lives in its own module for two reasons. `useXTicks` is a hook, and the page
 * derives this series *below* its loading early-return, so calling it there
 * would break the rules of hooks. And the page was 3,755 lines; the chart is
 * the most self-contained thing in it.
 *
 * ⚠️ THE DRAW MUST NOT RESTART. Recharts bumps its internal animation id on
 * every data-REFERENCE change and starts the sweep over — on a page with this
 * much local state (inbox paging, selection, hover, highlight), a fresh array
 * each render means the curve never finishes drawing, it just strobes. Two
 * guards: `series` is memoised on a CONTENT fingerprint, and `useXTicks` keys
 * its memo on primitives. Both must stay.
 *
 * ⚠️ RENDER-ONLY. Every number here arrives as a prop, already computed by the
 * page from the cash-signal endpoint. Nothing is derived, rounded or re-summed
 * in this file.
 */

export type DailyPoint = { date: string; rawDate: string; balance: number };

export type DayEvent = {
  label: string;
  amount: number;
  itemId?: string;
  dragged: boolean;
  originalDate?: string;
};

export type BigBillMarker = {
  date: string;
  total: number;
  bills: Array<{ label: string; amount: number; itemId?: string }>;
  balance: number;
};

/** Y extent with ≥8% headroom, always including zero and the buffer line — a
 *  balance chart that crops zero exaggerates every dip, and a buffer line off
 *  the top of the plot is the one annotation the reader came for. */
function useScale(series: DailyPoint[], cashBuffer: number) {
  const len = series.length;
  const firstX = series[0]?.rawDate;
  const lastX = series[len - 1]?.rawDate;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const d of series) {
      if (!Number.isFinite(d.balance)) continue;
      lo = Math.min(lo, d.balance);
      hi = Math.max(hi, d.balance);
    }
    if (Number.isFinite(cashBuffer)) {
      lo = Math.min(lo, cashBuffer);
      hi = Math.max(hi, cashBuffer);
    }
    return niceAxis(lo, hi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [len, firstX, lastX, cashBuffer]);
}

export function ProjectedBalanceChart({
  data,
  cashBuffer,
  lowestPoint,
  bigBillMarkers,
  eventsByDate,
  onJumpToPlan,
  onMarkMissed,
}: {
  data: DailyPoint[];
  cashBuffer: number;
  lowestPoint: { x: string; y: number; rawDate: string } | null;
  bigBillMarkers: BigBillMarker[];
  eventsByDate: Map<string, DayEvent[]>;
  onJumpToPlan: (itemId: string, date: string) => void;
  onMarkMissed: (row: PlanLine) => void;
}) {
  // Content fingerprint — see the draw-restart note above.
  const fp = data.map((d) => `${d.rawDate}:${d.balance}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const series = useMemo(() => data, [fp]);
  const xtk = useXTicks(series as unknown as Array<Record<string, unknown>>, "rawDate");
  const scale = useScale(series, cashBuffer);

  /**
   * ⚠️ ANCHOR THE LOW-POINT LABEL AWAY FROM THE EDGE IT SITS ON.
   *
   * `position="top"` centres the text on the dot, and the low point is very
   * often day ONE (a big bill lands immediately, or the horizon opens at the
   * trough). Centred on x=0 the label runs off the left of the svg and the
   * reader sees "t $4,218.55 · Aug 23" — the word "Lowest" clipped clean off.
   * Anchor it inward whenever the point falls in the outer fifth.
   */
  const lowIdx = lowestPoint
    ? series.findIndex((d) => d.rawDate === lowestPoint.rawDate)
    : -1;
  const lowFrac = lowIdx >= 0 && series.length > 1 ? lowIdx / (series.length - 1) : 0.5;
  // `position="insideTopLeft"` does nothing useful on a ReferenceDot — its
  // viewBox is the 10px circle, so every "inside" variant lands in the same
  // place as "top". Anchoring has to be done on the <text> itself.
  const lowAnchor: "start" | "middle" | "end" =
    lowFrac <= 0.2 ? "start" : lowFrac >= 0.8 ? "end" : "middle";

  return (
    // `.chart-in` fades the wrapper up; `.area-draw` sweeps a feathered mask
    // left→right so the curve reads as being plotted across the horizon.
    <div className="chart-in area-draw h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 14, right: 16, bottom: 16, left: 0 }}>
          <defs>
            <linearGradient id="projectedBalanceGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.navy} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART.navy} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
          <XAxis
            dataKey="rawDate"
            tick={AXIS_TICK}
            tickFormatter={(v: string) => shortDate(v)}
            ticks={xtk}
            interval="preserveStartEnd"
            minTickGap={28}
          />
          <YAxis
            tick={AXIS_TICK}
            tickFormatter={(v: number) => compactUSD(v)}
            width={56}
            domain={scale.domain}
            ticks={scale.ticks}
          />
          <RechartsTooltip
            // Bill names inside the tooltip are clickable — they deep-link
            // into the register below (#335).
            wrapperStyle={{ pointerEvents: "auto" }}
            content={({ active, payload }: { active?: boolean; payload?: any[] }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0]?.payload as
                | { rawDate?: string; balance?: number; actual?: number | null }
                | undefined;
              const rawDate = p?.rawDate;
              const balance = Number(p?.balance);
              const dayEvents = rawDate ? eventsByDate.get(rawDate) : undefined;
              return (
                <div className="min-w-[188px] rounded-card bg-white px-3 py-2 text-micro shadow-lift ring-1 ring-brand-line">
                  <div className="font-semibold text-brand-navy">
                    {rawDate ? formatDate(rawDate) : ""}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-4">
                    <span className="text-neutral-500">Balance</span>
                    <span className="font-mono tabular-nums text-neutral-700">
                      {Number.isFinite(balance) ? formatCurrency(balance) : "—"}
                    </span>
                  </div>
                  {dayEvents &&
                    dayEvents.length > 0 &&
                    rawDate &&
                    (() => {
                      // (#650) Only events actually PULLED FORWARD from a
                      // pre-snapshot pending plan belong under "dragging";
                      // bills naturally due on this calendar day go under
                      // their own heading.
                      const dragged = dayEvents.filter((b) => b.dragged);
                      const dueToday = dayEvents.filter((b) => !b.dragged);
                      const sections: Array<{ title: string; bills: typeof dayEvents }> = [];
                      if (dragged.length > 0) {
                        sections.push({ title: "Dragged onto this day", bills: dragged });
                      }
                      if (dueToday.length > 0) {
                        sections.push({ title: "Due this day", bills: dueToday });
                      }
                      return sections.map((section, sIdx) => (
                        <div
                          key={section.title}
                          className={
                            sIdx === 0 ? "mt-2 border-t border-brand-line pt-2" : "mt-2"
                          }
                        >
                          <div className="mb-1 text-micro font-semibold uppercase tracking-wide text-neutral-400">
                            {section.title}
                          </div>
                          <div className="flex flex-col gap-0.5">
                            {section.bills.map((b, idx) => {
                              const canJump = !!b.itemId;
                              // (#682) Per-plan "Mark missed" is surfaced only
                              // for dragged rows — that is the recurring source
                              // of the day-1 dip this tooltip exists to explain.
                              const canMarkMissed =
                                !!b.itemId && !!b.originalDate && b.dragged;
                              return (
                                <div
                                  key={`${b.itemId ?? "_"}-${idx}`}
                                  className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-neutral-50"
                                >
                                  <button
                                    type="button"
                                    disabled={!canJump}
                                    onClick={() => {
                                      if (b.itemId) onJumpToPlan(b.itemId, rawDate);
                                    }}
                                    data-testid={`tooltip-bill-${rawDate}-${b.itemId ?? idx}`}
                                    className={`flex min-w-0 flex-1 items-center justify-between gap-3 border-0 bg-transparent p-0 text-left font-[inherit] text-inherit ${
                                      canJump ? "cursor-pointer" : "cursor-default"
                                    }`}
                                  >
                                    <span className="min-w-0 truncate text-neutral-600">
                                      {b.label}
                                    </span>
                                    <span className="font-mono tabular-nums text-bad">
                                      {formatCurrency(b.amount)}
                                    </span>
                                  </button>
                                  {canMarkMissed && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onMarkMissed({
                                          kind: "plan",
                                          itemId: b.itemId!,
                                          label: b.label,
                                          amount: b.amount,
                                          date: rawDate,
                                          originalDate: b.originalDate!,
                                          status: "pending_plan",
                                        });
                                      }}
                                      data-testid={`tooltip-mark-missed-${b.itemId}-${b.originalDate}`}
                                      title="Mark this past-due plan as missed so it stops dragging the projection"
                                      className="press whitespace-nowrap rounded-control bg-white px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-bad ring-1 ring-bad/25 hover:bg-bad-bg"
                                    >
                                      Mark missed
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ));
                    })()}
                </div>
              );
            }}
          />
          <Area
            {...ANIM_AREA}
            type="monotone"
            dataKey="balance"
            stroke={CHART.navy}
            strokeWidth={2}
            fill="url(#projectedBalanceGrad)"
            name="Forecast"
          />
          {Number.isFinite(cashBuffer) && (
            <ReferenceLine
              y={cashBuffer}
              stroke={CHART.orangeDeep}
              strokeDasharray="4 4"
              strokeWidth={1.5}
              ifOverflow="extendDomain"
              data-testid="ref-cash-buffer"
            >
              {/* Left, not right: the buffer sits low in the plot, so a
                  right-anchored label lands on the last x tick and gets
                  clipped by the svg edge. */}
              <RechartsLabel
                value={`Cash buffer ${formatCurrency(cashBuffer)}`}
                position="insideTopLeft"
                fill={CHART.orangeDeep}
                fontSize={10}
              />
            </ReferenceLine>
          )}
          {bigBillMarkers.map((m) => {
            const top = m.bills.find((b) => !!b.itemId) ?? m.bills[0];
            return (
              <ReferenceDot
                key={`big-bill-${m.date}`}
                x={m.date}
                y={m.balance}
                r={5}
                fill={CHART.navy}
                stroke="#ffffff"
                strokeWidth={1.5}
                ifOverflow="extendDomain"
                isFront
                data-testid={`big-bill-marker-${m.date}`}
                cursor={top?.itemId ? "pointer" : undefined}
                onClick={() => {
                  if (top?.itemId) onJumpToPlan(top.itemId, m.date);
                }}
              />
            );
          })}
          {lowestPoint && (
            <ReferenceDot
              x={lowestPoint.x}
              y={lowestPoint.y}
              r={5}
              fill={CHART.orangeDeep}
              stroke="#ffffff"
              strokeWidth={2}
              ifOverflow="extendDomain"
              isFront
              data-testid="ref-lowest-point"
            >
              {/* `value` is kept so anything reading the label as a prop still
                  sees the text; `content` is what actually paints, because the
                  anchor has to move when the low point sits on an edge. */}
              <RechartsLabel
                value={`Lowest ${formatCurrency(lowestPoint.y)} · ${formatDate(lowestPoint.rawDate)}`}
                content={(p: unknown) => {
                  const vb =
                    (p as { viewBox?: { cx?: number; cy?: number; x?: number; y?: number } })
                      ?.viewBox ?? {};
                  const cx = vb.cx ?? vb.x ?? 0;
                  const cy = vb.cy ?? vb.y ?? 0;
                  return (
                    <text
                      x={cx}
                      y={cy - 12}
                      textAnchor={lowAnchor}
                      fill={CHART.orangeDeep}
                      fontSize={11}
                      fontWeight={600}
                    >
                      {`Lowest ${formatCurrency(lowestPoint.y)} · ${formatDate(lowestPoint.rawDate)}`}
                    </text>
                  );
                }}
              />
            </ReferenceDot>
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** "2026-05-14" → "05-14". Axis ticks have ~40px; the full date does not fit. */
function shortDate(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${m}-${d}`;
}
