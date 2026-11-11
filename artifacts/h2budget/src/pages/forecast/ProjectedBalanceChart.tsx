import { useEffect, useMemo, useRef, useState } from "react";
// (C13) Through the kit, never from "recharts" directly (`chartsDoor.test.ts`).
import {
  RcResponsiveContainer as ResponsiveContainer,
  RcAreaChart as AreaChart,
  RcArea as Area,
  RcXAxis as XAxis,
  RcYAxis as YAxis,
  RcCartesianGrid as CartesianGrid,
  RcTooltip as RechartsTooltip,
  RcReferenceLine as ReferenceLine,
  RcReferenceDot as ReferenceDot,
  RcReferenceArea as ReferenceArea,
  RcLabel as RechartsLabel,
  ANIM_AREA,
  AXIS_TICK,
  CALM_STROKE,
  CHART,
  compactUSD,
  DRAW_MS,
  FOLLOW_MS,
  MARKER,
  MORPH_MS,
  PULSE_MS,
  niceAxis,
  useXTicks,
} from "@/lib/charts";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import type { PlanLine } from "@/lib/forecastMatch";
import { tooltipPlanLine } from "@/lib/forecastPastDue";
import { runsBelow, type MarkerGroup } from "@/lib/forecastEventKinds";
import { BUF_CHAR_PX, bufferBox, bufferLabelAbove, LOW_CHAR_PX, PLATE_PAD, placeCalmLabels, placeLowLabel, type Box } from "@/lib/chartLabelPlacement";
import { useReducedMotion } from "@/hooks/useReducedMotion";

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
  /** (PR6) The resolution key date (see lib/forecastPastDue). */
  occurrenceDate?: string;
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

/** Session keys that have already drawn their sweep (module scope: survives leaving and returning to the page). */
const DRAWN = new Set<string>();

export function ProjectedBalanceChart({
  data,
  cashBuffer,
  lowestPoint,
  bigBillMarkers,
  eventsByDate,
  onJumpToPlan,
  onMarkMissed,
  lockedPlanKeys,
  variant = "classic",
  todayISO,
  markers,
  riskShading = false,
  selectedDate,
  onSelectDate,
  hoverSelects = false,
  horizonKey,
  incomeByDate,
  lowLabel = "full",
  monthTicks = false,
  startLabel = null,
  openingBalance = null,
  sessionKey,
  calm = false,
  showBills = false,
  dayTotals,
}: {
  data: DailyPoint[];
  cashBuffer: number;
  lowestPoint: { x: string; y: number; rawDate: string } | null;
  bigBillMarkers: BigBillMarker[];
  eventsByDate: Map<string, DayEvent[]>;
  onJumpToPlan: (itemId: string, date: string) => void;
  onMarkMissed: (row: PlanLine) => void;
  /** (PR5b) `<itemId>|<date>` of partly-paid plans: no Mark missed for them —
   *  the write would replace the partial and un-pay its row. */
  lockedPlanKeys?: ReadonlySet<string>;
  /**
   * "classic" (default) is the old page's chart, untouched. "expanded" is the
   * `/next/forecast` chart: solid-to-today then dashed, grouped event markers,
   * risk shading, a selectable day, and an animation that only plays when the
   * data actually changed. Every prop below is ignored in "classic".
   */
  variant?: "classic" | "expanded";
  /** ISO day the solid line ends on and the "Today" rule stands on. */
  todayISO?: string;
  markers?: MarkerGroup[];
  /** Tint the days under the cash buffer, and more strongly the days under zero. */
  riskShading?: boolean;
  /** Keyed by DATE, never by index, so it survives refetches and horizon changes. */
  selectedDate?: string | null;
  onSelectDate?: (iso: string | null) => void;
  /** Desktop: resting the pointer on a day selects it (debounced). */
  hoverSelects?: boolean;
  /** Changing this crossfades the chart in (one key per horizon). */
  horizonKey?: string | number;
  /** Money-in rows per day, listed in the tooltip. */
  incomeByDate?: Map<string, Array<{ label: string; amount: number }>>;
  /** "full" (default): "Lowest $X · <date>". "short": "Low $X", for a narrow
   *  chart whose legend already names the date (the dashboard panel on a
   *  phone clipped the full label at the plot's edge). */
  lowLabel?: "full" | "short";
  /** Axis ticks as "Oct 9" instead of "10-09" (the expanded chart always does). */
  monthTicks?: boolean;
  /**
   * (T1/C2) Expanded only: the caption drawn at the curve's first point, one or two short lines
   * ("Oct 16 · opens $0.00 · closes $2,614.20" / "Bank read $0.00 Oct 15, 7:02 AM · +2 rows since").
   * The first point is that day's CLOSE; the caption says both moments.
   */
  startLabel?: string | readonly string[] | null;
  /** (C2) The balance at the START of the first day (`cashSignal.opening.balance`); the first-day tooltip says opening and close. */
  openingBalance?: number | null;
  /**
   * Classic and calm: the chart sweeps in ONCE per session for this key (the dashboard's "dash-forecast", the
   * Forecast page's own). A later mount, or a new horizon's data on the mounted chart, appears without a re-sweep.
   */
  sessionKey?: string;
  /**
   * ⭐ (Readable forecast) Expanded only: the calmer chart. Small payday ticks are the only resting markers;
   * bill, card and debt markers, their counts and the big-bill rings appear only with `showBills` (the
   * legend's "Show bills"), exactly as the chart drew them before. The tooltip is the date, the balance and
   * "In $A · Out $B" (`dayTotals`); the names and their actions live in the day panel. Off (default): the
   * chart as it always was — the dashboard and `/review` keep it.
   *
   * ⭐ (Clean forecast line) Calm with the bills hidden is ONE solid navy line over the soft navy fill, paydays
   * as quiet ticks along the bottom edge, horizontal grid lines only, and three plated labels (Today, the low
   * point, "Cushion"). Calm also owns its motion: one mask sweep per session (`sessionKey`), no chart-library
   * first draw stacked on it, no remount on a horizon change (the line reshapes), a hover dot and hairline that
   * glide, and one ring pulse on the low point after the sweep. All of it is off under reduced motion.
   */
  calm?: boolean;
  showBills?: boolean;
  /** Calm tooltip: each day's money in and out (`inOutByDate`, the day panel's grouping). */
  dayTotals?: ReadonlyMap<string, { moneyIn: number; moneyOut: number }>;
}) {
  const expanded = variant === "expanded";
  // The Forecast page's chart (calm). Its motion rules hold with the bills shown too.
  const calmX = expanded && calm;
  // Calm and bills hidden: the clean line. With "Show bills" the chart is the full one.
  const quiet = calmX && !showBills;
  // JS-driven motion cannot see the CSS media query: the hover glide, the reshape and the pulse ask here.
  const reduced = useReducedMotion();
  const [firstDraw] = useState(() => !(sessionKey && (!expanded || calm) && DRAWN.has(sessionKey)));
  const [swept, setSwept] = useState(false);
  useEffect(() => {
    if (!sessionKey || (expanded && !calm)) return;
    DRAWN.add(sessionKey);
    if (expanded) return; // calm: the sweep is the CSS mask alone, nothing to time here
    const t = setTimeout(() => setSwept(true), ANIM_AREA.animationDuration + 150);
    return () => clearTimeout(t);
  }, [sessionKey, expanded, calm]);
  // (Clean forecast line) The low point's ring is mounted for the first draw only, then taken away: a later
  // render, a new horizon or a selected day can never play it again.
  const [pulse, setPulse] = useState(() => calmX && firstDraw && !reduced);
  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(false), DRAW_MS + PULSE_MS + 200);
    return () => clearTimeout(t);
  }, [pulse]);
  // Content fingerprint — see the draw-restart note above.
  const fp = data.map((d) => `${d.rawDate}:${d.balance}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const series = useMemo(() => data, [fp]);
  const xtk = useXTicks(series as unknown as Array<Record<string, unknown>>, "rawDate");
  const scale = useScale(series, cashBuffer);

  // Expanded only. `chartData` is `series` itself unless a "today" split is asked
  // for, so the classic chart keeps the very same array reference.
  const chartData = useMemo(
    () =>
      expanded && todayISO
        ? series.map((d) => ({
            ...d,
            past: d.rawDate <= todayISO ? d.balance : null,
            future: d.rawDate >= todayISO ? d.balance : null,
          }))
        : series,
    [series, expanded, todayISO],
  );
  const risk = useMemo(
    () =>
      expanded && riskShading
        ? { below: runsBelow(series, cashBuffer), negative: runsBelow(series, 0) }
        : null,
    [series, expanded, riskShading, cashBuffer],
  );
  // The draw plays once per content fingerprint: it keeps running through
  // unrelated re-renders (selection, hover) until it has had its time, then
  // stays off until the data changes again.
  // (Clean forecast line) Calm starts settled: its first draw is the mask sweep, never the library's reveal.
  const [settledFp, setSettledFp] = useState<string | null>(() => (calmX ? fp : null));
  useEffect(() => {
    if (!expanded) return;
    const t = setTimeout(() => setSettledFp(fp), (calmX ? MORPH_MS : ANIM_AREA.animationDuration) + 150);
    return () => clearTimeout(t);
  }, [expanded, calmX, fp]);
  const animateNow = expanded ? settledFp !== fp : !sessionKey || (firstDraw && !swept);
  // Calm: the line RESHAPES when its data changes (a new horizon, a refetch that moved a number) and at no other
  // time. "Show bills" swaps the series it is drawn from; a swap in the middle of a reshape ends the reshape
  // rather than letting the new series draw itself in.
  const morph = useRef({ fp, showBills, live: true });
  if (morph.current.fp !== fp) morph.current = { fp, showBills, live: true };
  else if (morph.current.showBills !== showBills) morph.current = { fp, showBills, live: false };
  const areaAnim = calmX
    ? {
        isAnimationActive: !reduced && settledFp !== fp && morph.current.live,
        animationDuration: MORPH_MS,
        animationEasing: "ease-in-out" as const,
        // The hover dot is the chart's own (it glides); the library's would jump beside it.
        activeDot: false,
      }
    : { ...ANIM_AREA, isAnimationActive: ANIM_AREA.isAnimationActive && animateNow };
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // (E5) A pointer resting where the page loaded is not a choice: Safari fires a mousemove after the page changes
  // under a still cursor, which used to replace the day the reader arrived on (`?day=`). Hover counts only
  // once the pointer has really moved (3 px) since this chart appeared.
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const trackPointer = (e: { clientX: number; clientY: number }) => {
    const p = pointer.current;
    if (!p) pointer.current = { x: e.clientX, y: e.clientY, moved: false };
    else if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 3) p.moved = true;
  };
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);
  const canHover =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const selectedInWindow = !!selectedDate && series.some((d) => d.rawDate === selectedDate);

  // (E4) The plot's size, measured, so the low-point label and the axis ticks can be placed by rule.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!expanded || !el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      setBox((b) => (b && b.w === w && b.h === h ? b : w > 0 && h > 0 ? { w, h } : b));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);
  // At most 5 axis ticks on a phone, 12 elsewhere (even spread, first and last always).
  const narrow = box != null && box.w < 640;
  const tickN = narrow ? 5 : 0;
  const lenS = series.length;
  const firstS = series[0]?.rawDate;
  const lastS = series[lenS - 1]?.rawDate;
  const fewTicks = useMemo(() => {
    if (!tickN || lenS <= tickN) return null;
    const idx = new Set<number>();
    for (let i = 0; i < tickN; i++) idx.add(Math.round((i * (lenS - 1)) / (tickN - 1)));
    return [...idx].sort((a, b) => a - b).map((i) => series[i]!.rawDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickN, lenS, firstS, lastS]);
  // Hovering or focusing a day shows that day's marker (the others stay quiet).
  const [hoverDate, setHoverDate] = useState<string | null>(null);

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
  // (E4) Collision rule, from the measured plot: below the dot in the top half or near the buffer label,
  // right-anchored near the right edge (above); the buffer label yields when neither side clears it.
  const LEFT = 56;
  const RIGHT = 16;
  const TOP = 14;
  const BOTTOM = 16 + 30;
  // (Clean forecast line) The clean chart says it short ("Low $X · Dec 1"), so the low point and the cushion
  // label fit side by side on a phone. Everywhere else the words are as they were.
  const lowText = !lowestPoint
    ? ""
    : quiet
      ? `Low ${formatCurrency(lowestPoint.y)} · ${longTick(lowestPoint.rawDate)}`
      : `Lowest ${formatCurrency(lowestPoint.y)} · ${formatDate(lowestPoint.rawDate)}`;
  // (Clean forecast line) On the clean chart the rule is the "Cushion".
  const bufText = `${quiet ? "Cushion" : "Cash buffer"} ${formatCurrency(cashBuffer)}`;
  const placed = (() => {
    if (!expanded || !box || !lowestPoint) return null;
    const plotW = box.w - LEFT - RIGHT;
    const plotH = box.h - TOP - BOTTOM;
    const [d0, d1] = scale.domain as [number, number];
    if (plotW <= 0 || plotH <= 0 || !(d1 > d0)) return null;
    const yPx = (v: number) => TOP + ((d1 - v) / (d1 - d0)) * plotH;
    const bufY = Number.isFinite(cashBuffer) ? yPx(cashBuffer) : null;
    const bufAbove = bufY != null && bufferLabelAbove(bufY, TOP + plotH);
    const buf = bufY != null ? bufferBox(box.w - RIGHT, bufY, bufText.length * BUF_CHAR_PX, bufAbove) : null;
    return {
      bufAbove,
      ...placeLowLabel({
        dotX: LEFT + lowFrac * plotW,
        dotY: yPx(lowestPoint.y),
        plotTop: TOP,
        plotH,
        plotLeft: LEFT,
        plotRight: box.w - RIGHT,
        anchor: lowAnchor,
        lowWidth: lowText.length * LOW_CHAR_PX,
        buffer: buf,
      }),
    };
  })();
  // ⭐ (Clean forecast line) The clean chart's three plated labels, placed together from the measured plot.
  const todayIdx = todayISO ? series.findIndex((d) => d.rawDate === todayISO) : -1;
  const calmPlaced = (() => {
    if (!quiet || !box) return null;
    const plotW = box.w - LEFT - RIGHT;
    const plotH = box.h - TOP - BOTTOM;
    const [d0, d1] = scale.domain as [number, number];
    const n = series.length;
    if (plotW <= 0 || plotH <= 0 || !(d1 > d0) || n < 2) return null;
    const yPx = (v: number) => TOP + ((d1 - v) / (d1 - d0)) * plotH;
    const xPx = (i: number) => LEFT + (i / (n - 1)) * plotW;
    return placeCalmLabels({
      plot: { x0: LEFT, x1: box.w - RIGHT, y0: TOP, y1: TOP + plotH },
      todayX: todayIdx >= 0 ? xPx(todayIdx) : null,
      todayWidth: TODAY_TEXT.length * BUF_CHAR_PX + 2 * PLATE_PAD,
      low: lowestPoint && lowIdx >= 0 ? { dotX: xPx(lowIdx), dotY: yPx(lowestPoint.y), width: lowText.length * LOW_CHAR_PX, anchor: lowAnchor } : null,
      cushion: Number.isFinite(cashBuffer) ? { y: yPx(cashBuffer), width: bufText.length * BUF_CHAR_PX + 2 * PLATE_PAD } : null,
      curveSpan: (x0, x1) => {
        const a = Math.max(0, Math.floor(((x0 - LEFT) / plotW) * (n - 1)));
        const b = Math.min(n - 1, Math.ceil(((x1 - LEFT) / plotW) * (n - 1)));
        let top = Infinity;
        let bottom = -Infinity;
        for (let i = a; i <= b; i++) {
          const v = series[i]?.balance;
          if (v == null || !Number.isFinite(v)) continue;
          top = Math.min(top, yPx(v));
          bottom = Math.max(bottom, yPx(v));
        }
        return top <= bottom ? { y0: top, y1: bottom } : null;
      },
    });
  })();
  const lowBelow = calmPlaced?.low ? calmPlaced.low.below : placed?.below ?? false;
  const lowAnchorUsed = calmPlaced?.low ? calmPlaced.low.anchor : placed?.anchor ?? lowAnchor;
  const lowDrop = calmPlaced?.low?.dy ?? 0;
  const bufAbove = placed?.bufAbove ?? false;
  const hideBufferLabel = calmPlaced ? calmPlaced.cushion == null && Number.isFinite(cashBuffer) : placed?.hideBuffer ?? false;
  // Only the big-bill days, paydays and the selected / hovered day draw a marker; the lowest point always draws.
  const bigDates = new Set(bigBillMarkers.map((m) => m.date));
  // (Clean forecast line) Quiet: only the SELECTED day's marker rests on the line; the hovered day has the
  // gliding dot instead.
  const shownMarkers = (markers ?? []).filter((m) =>
    quiet
      ? m.date === selectedDate
      : m.kinds.includes("payday") || bigDates.has(m.date) || m.date === selectedDate || m.date === hoverDate,
  );
  // (Clean forecast line) Quiet: every payday is a small tick on the plot's bottom edge, off the line.
  const paydayTicks = quiet ? (markers ?? []).filter((m) => m.kinds.includes("payday")) : [];
  const shownBigBills = quiet ? [] : bigBillMarkers;
  // ⭐ (T2) Only a projected NEGATIVE is rust. A low point at or above $0 — even under the buffer — is
  // marked in navy: the buffer line and its tint already say "under the buffer", quietly.
  const lowNegative = !!lowestPoint && lowestPoint.y < 0;
  const lowFill = lowNegative ? CHART.orangeDeep : CHART.navy;
  const lowInk = lowNegative ? CHART.badInk : CHART.navy;
  // (T2) The zero rule shows whenever the curve touches or crosses $0 (and when the axis goes below it).
  const touchesZero = series.some((d) => Number.isFinite(d.balance) && d.balance <= 0);
  const first = series[0];
  const startLines: readonly string[] = startLabel == null ? [] : typeof startLabel === "string" ? [startLabel] : startLabel;
  // (Readable forecast) The start caption is drawn only where it cannot meet the low-point label (the outer fifth).
  const startLabelShown = !(calm && lowestPoint && lowFrac <= 0.2);

  const tooltipEl = (
    <RechartsTooltip
      // Bill names inside the tooltip are clickable — they deep-link
      // into the register below (#335).
      // (Readable forecast) The calm tooltip holds no buttons, so it never catches the pointer.
      wrapperStyle={{ pointerEvents: calm && expanded ? "none" : "auto" }}
      // (Clean forecast line) Calm: the hairline and the dot are the chart's own and glide between days;
      // the card follows in FOLLOW_MS. Reduced motion: both simply appear in place.
      {...(calmX
        ? {
            cursor: <HoverCursor domain={scale.domain as [number, number]} glide={!reduced} />,
            isAnimationActive: !reduced,
            animationDuration: FOLLOW_MS,
            animationEasing: "ease-out" as const,
          }
        : {})}
      content={({ active, payload }: { active?: boolean; payload?: any[] }) => {
        if (!active || !payload || payload.length === 0) return null;
        const p = payload[0]?.payload as
          | { rawDate?: string; balance?: number; actual?: number | null }
          | undefined;
        const rawDate = p?.rawDate;
        const balance = Number(p?.balance);
        if (calm && expanded) {
          const isFirst = openingBalance != null && Number.isFinite(openingBalance) && !!rawDate && rawDate === data[0]?.rawDate;
          const t = rawDate ? dayTotals?.get(rawDate) : undefined;
          return (
            <div className="min-w-[168px] rounded-card bg-white px-3 py-2 text-micro shadow-lift ring-1 ring-brand-line" data-testid="tooltip-calm" data-date={rawDate}>
              <div className="font-semibold text-brand-navy">{rawDate ? formatDate(rawDate) : ""}</div>
              {isFirst ? (
                <div className="mt-1 flex items-center justify-between gap-4" data-testid="tooltip-opening">
                  <span className="text-neutral-500">Opening</span>
                  <span className="font-mono tabular-nums text-neutral-700">{formatCurrency(openingBalance)}</span>
                </div>
              ) : null}
              <div className="mt-1 flex items-center justify-between gap-4">
                <span className="text-neutral-500">{isFirst ? "Close" : "Balance"}</span>
                <span className="font-mono tabular-nums text-neutral-700" data-testid="tooltip-balance">
                  {Number.isFinite(balance) ? formatCurrency(balance) : "—"}
                </span>
              </div>
              {t && (t.moneyIn !== 0 || t.moneyOut !== 0) ? (
                <div className="mt-1 font-mono tabular-nums text-neutral-600" data-testid="tooltip-in-out">
                  In {formatCurrency(t.moneyIn)} · Out {formatCurrency(Math.abs(t.moneyOut))}
                </div>
              ) : null}
            </div>
          );
        }
        const dayEvents = rawDate ? eventsByDate.get(rawDate) : undefined;
        return (
          <div className="min-w-[188px] rounded-card bg-white px-3 py-2 text-micro shadow-lift ring-1 ring-brand-line">
            <div className="font-semibold text-brand-navy">
              {rawDate ? formatDate(rawDate) : ""}
            </div>
            {openingBalance != null && Number.isFinite(openingBalance) && rawDate && rawDate === data[0]?.rawDate ? (
              <div className="mt-1 flex items-center justify-between gap-4" data-testid="tooltip-opening">
                <span className="text-neutral-500">Opening</span>
                <span className="font-mono tabular-nums text-neutral-700">{formatCurrency(openingBalance)}</span>
              </div>
            ) : null}
            <div className="mt-1 flex items-center justify-between gap-4">
              <span className="text-neutral-500">
                {openingBalance != null && rawDate && rawDate === data[0]?.rawDate ? "Close" : "Balance"}
              </span>
              <span className="font-mono tabular-nums text-neutral-700">
                {Number.isFinite(balance) ? formatCurrency(balance) : "—"}
              </span>
            </div>
            {expanded &&
              rawDate &&
              (incomeByDate?.get(rawDate)?.length ?? 0) > 0 && (
                <div className="mt-2 border-t border-brand-line pt-2">
                  <div className="mb-1 text-micro font-semibold uppercase tracking-wide text-neutral-400">
                    Money in
                  </div>
                  {incomeByDate!.get(rawDate)!.map((inc, i) => (
                    <div key={`${inc.label}-${i}`} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-neutral-600">{inc.label}</span>
                      <span className="font-mono tabular-nums text-ok">{formatCurrency(inc.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
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
                          !!b.itemId &&
                          !!b.originalDate &&
                          b.dragged &&
                          !lockedPlanKeys?.has(`${b.itemId}|${b.originalDate}`) &&
                          // (PR6) …nor by its occurrence key.
                          !(b.occurrenceDate && lockedPlanKeys?.has(`${b.itemId}|${b.occurrenceDate}`));
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
                                  // (PR6) Sends the occurrence key, not the moved-to date.
                                  onMarkMissed(tooltipPlanLine({ ...b, itemId: b.itemId! }, rawDate));
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
  );

  return (
    // `.chart-in` fades the wrapper up; `.area-draw` sweeps a feathered mask
    // left→right so the curve reads as being plotted across the horizon.
    // (Clean forecast line) Calm: ONE sweep (the mask alone), and no remount on a horizon change — the node
    // stays, so the sweep cannot replay and the line reshapes from the curve already on screen.
    <div
      ref={boxRef}
      onPointerMove={expanded ? trackPointer : undefined}
      key={expanded && !calm ? horizonKey : undefined}
      // `chart-reshaping`: only while the line tweens to new data — the new curve's marks wait for it (index.css).
      className={cn(firstDraw && (calmX ? "area-draw draw-once" : "chart-in area-draw"), calmX && "chart-calm", calmX && areaAnim.isAnimationActive && "chart-reshaping", "h-full w-full")}
      data-first-draw={calmX ? String(firstDraw) : undefined}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 14, right: 16, bottom: 16, left: 0 }}
          {...(expanded && onSelectDate
            ? {
                // Tap / click selects. Desktop hover selects once the pointer rests.
                onClick: (st: { activeLabel?: string | number } | undefined) => {
                  if (st?.activeLabel != null) onSelectDate(String(st.activeLabel));
                },
                onMouseMove: (st: { activeLabel?: string | number } | undefined) => {
                  const d = st?.activeLabel;
                  if (d == null) return;
                  if (!pointer.current?.moved) return;
                  // Quiet draws nothing from the hovered day (the cursor glides on its own): no re-render per day.
                  if (!quiet) setHoverDate((h) => (h === String(d) ? h : String(d)));
                  if (!(hoverSelects && canHover)) return;
                  if (hoverTimer.current) clearTimeout(hoverTimer.current);
                  hoverTimer.current = setTimeout(() => onSelectDate(String(d)), 140);
                },
                onMouseLeave: () => setHoverDate(null),
              }
            : {})}
        >
          <defs>
            <linearGradient id="projectedBalanceGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.navy} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART.navy} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="projectedBalanceGradFuture" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.mid} stopOpacity={0.14} />
              <stop offset="100%" stopColor={CHART.mid} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          {quiet ? (
            // (Clean forecast line) Light horizontal lines only.
            <CartesianGrid vertical={false} stroke={CHART.grid} />
          ) : (
            <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
          )}
          <XAxis
            dataKey="rawDate"
            tick={AXIS_TICK}
            tickFormatter={(v: string) => (expanded || monthTicks ? longTick(v) : shortDate(v))}
            ticks={expanded && fewTicks ? fewTicks : xtk}
            interval="preserveStartEnd"
            minTickGap={28}
            // (Readable forecast) A few px lower, so the first date clears the y axis's bottom figure.
            {...(calm ? { tickMargin: 6 } : {})}
          />
          <YAxis
            tick={AXIS_TICK}
            tickFormatter={(v: number) => compactUSD(v)}
            width={56}
            domain={scale.domain}
            ticks={scale.ticks}
          />
          {!calmX && tooltipEl}
          {risk?.below.map((r, i) => (
            <ReferenceArea
              key={`risk-b-${i}-${r.x1}`}
              x1={r.x1}
              x2={r.x2}
              fill={CHART.orangeDeep}
              fillOpacity={0.1}
              stroke="none"
              ifOverflow="hidden"
              data-testid="risk-below-buffer"
            />
          ))}
          {risk?.negative.map((r, i) => (
            <ReferenceArea
              key={`risk-n-${i}-${r.x1}`}
              x1={r.x1}
              x2={r.x2}
              fill={CHART.orangeDeep}
              fillOpacity={0.24}
              stroke="none"
              ifOverflow="hidden"
              data-testid="risk-below-zero"
            />
          ))}
          {expanded && (scale.domain[0] < 0 || touchesZero) && (
            <ReferenceLine y={0} stroke={CHART.steel} strokeWidth={1} ifOverflow="extendDomain" data-testid="ref-zero" />
          )}
          {expanded && todayISO && !quiet && (
            <Area
                {...areaAnim}
                type="linear"
                dataKey="past"
                stroke={CHART.navy}
                strokeWidth={2.25}
                fill="url(#projectedBalanceGrad)"
                name="Actual"
                connectNulls
              />
          )}
          {expanded && todayISO && !quiet && (
            <Area
                {...areaAnim}
                type="linear"
                dataKey="future"
                stroke={CHART.mid}
                strokeWidth={2}
                strokeDasharray="6 4"
                fill="url(#projectedBalanceGradFuture)"
                name="Projected"
                connectNulls
              />
          )}
          {quiet && (
            // ⭐ (Clean forecast line) ONE solid navy line across the whole window, look-back days included,
            // over the same soft navy fill the home chart uses. The "Today" rule marks the split.
            <Area
              {...areaAnim}
              type="linear"
              dataKey="balance"
              stroke={CHART.navy}
              strokeWidth={CALM_STROKE.balance}
              fill="url(#projectedBalanceGrad)"
              name="Balance"
            />
          )}
          {expanded && todayISO && (
              <ReferenceLine x={todayISO} stroke={CHART.mist} strokeWidth={1.25} data-testid="ref-today">
                {quiet ? (
                  <RechartsLabel
                    value={TODAY_TEXT}
                    content={(p: unknown) => {
                      const vb = (p as { viewBox?: { x?: number; y?: number } })?.viewBox ?? {};
                      const w = TODAY_TEXT.length * BUF_CHAR_PX + 2 * PLATE_PAD;
                      const b = calmPlaced?.today ?? { x0: (vb.x ?? 0) + 5, x1: (vb.x ?? 0) + 5 + w, y0: (vb.y ?? 0) + 2, y1: (vb.y ?? 0) + 16 };
                      return <LabelPlate box={b} text={TODAY_TEXT} fill={CHART.steel} testid="chart-today-plate" />;
                    }}
                  />
                ) : (
                  <RechartsLabel value="Today" position="insideTopLeft" fill={CHART.steel} fontSize={10} />
                )}
              </ReferenceLine>
          )}
          {!(expanded && todayISO) && !quiet && (
            <Area
              {...areaAnim}
              type="linear"
              dataKey="balance"
              stroke={CHART.navy}
              strokeWidth={2}
              fill="url(#projectedBalanceGrad)"
              name={expanded ? "Projected" : "Forecast"}
            />
          )}
          {Number.isFinite(cashBuffer) && (
            <ReferenceLine
              y={cashBuffer}
              stroke={CHART.orangeDeep}
              // (Clean forecast line) The same dashed orange rule, thin and quiet.
              strokeDasharray={quiet ? "3 4" : "4 4"}
              strokeWidth={quiet ? CALM_STROKE.cushion : 1.5}
              {...(quiet ? { strokeOpacity: 0.8 } : {})}
              ifOverflow="extendDomain"
              data-testid="ref-cash-buffer"
            >
              {/* Expanded: the right end, under the line, and hidden when the low-point label cannot clear it (the
                  legend names the buffer). Classic keeps the left end. */}
              {!hideBufferLabel && quiet && (
                <RechartsLabel
                  value={bufText}
                  content={(p: unknown) => {
                    const vb = (p as { viewBox?: { x?: number; y?: number; width?: number } })?.viewBox ?? {};
                    const w = bufText.length * BUF_CHAR_PX + 2 * PLATE_PAD;
                    const b = calmPlaced?.cushion?.box ?? bufferBox((vb.x ?? 0) + (vb.width ?? 0), vb.y ?? 0, w, false);
                    return <LabelPlate box={b} text={bufText} fill={CHART.badInk} testid="chart-cushion-plate" />;
                  }}
                />
              )}
              {!hideBufferLabel && !quiet && (
                <RechartsLabel
                  value={bufText}
                  position={expanded ? (bufAbove ? "insideBottomRight" : "insideTopRight") : "insideTopLeft"}
                  fill={CHART.badInk}
                  fontSize={10}
                />
              )}
            </ReferenceLine>
          )}
          {shownBigBills.map((m) => {
            const top = m.bills.find((b) => !!b.itemId) ?? m.bills[0];
            // (C13) The expanded chart already draws a kind marker on every
            // event day, so a big bill is a navy RING around its day's marker
            // there: the ring jumps to the plan (FC-28), the marker inside
            // still selects the day. The classic chart keeps its filled dot.
            return (
              <ReferenceDot
                key={`big-bill-${m.date}`}
                x={m.date}
                y={m.balance}
                r={expanded ? 10 : 5}
                fill={expanded ? "none" : CHART.navy}
                stroke={expanded ? CHART.navy : "#ffffff"}
                strokeWidth={expanded ? 2 : 1.5}
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
          {expanded && selectedInWindow && (
            <ReferenceLine
              x={selectedDate!}
              stroke={CHART.navy}
              strokeWidth={1.5}
              ifOverflow="extendDomain"
              data-testid="ref-selected-day"
            />
          )}
          {/* (Clean forecast line) Calm: the hover hairline and dot draw here, over the line and its rules and
              under the markers and the plated labels. */}
          {calmX && tooltipEl}
          {expanded &&
            paydayTicks.map((m) => (
              // On the plot's bottom edge (the axis's own lowest value), never on the line.
              <ReferenceDot
                key={`pd-${m.date}`}
                x={m.date}
                y={scale.domain[0]}
                r={4}
                ifOverflow="extendDomain"
                isFront
                shape={(p: { cx?: number; cy?: number }) => (
                  <PaydayTick cx={p.cx ?? 0} cy={p.cy ?? 0} date={m.date} onSelect={onSelectDate} />
                )}
              />
            ))}
          {expanded &&
            shownMarkers.map((m) => (
              <ReferenceDot
                key={`mk-${m.date}`}
                x={m.date}
                y={m.balance}
                r={6}
                ifOverflow="extendDomain"
                isFront
                shape={(p: { cx?: number; cy?: number }) => (
                  <MarkerShape
                    cx={p.cx ?? 0}
                    cy={p.cy ?? 0}
                    group={m}
                    selected={m.date === selectedDate}
                    onSelect={onSelectDate}
                    // Calm: no count where it would sit on the low-point label (that day's words already name it).
                    showCount={!quiet && !(calm && m.date === lowestPoint?.rawDate)}
                  />
                )}
              />
            ))}
          {expanded && startLines.length > 0 && first && Number.isFinite(first.balance) && (
            <ReferenceDot
              x={first.rawDate}
              y={first.balance}
              r={4}
              fill={CHART.navy}
              stroke="#ffffff"
              strokeWidth={1.5}
              ifOverflow="extendDomain"
              isFront
              data-testid="ref-start-point"
            >
              {startLabelShown && <RechartsLabel
                value={startLines.join(" ")}
                content={(p: unknown) => {
                  const vb = (p as { viewBox?: { cx?: number; cy?: number; x?: number; y?: number } })?.viewBox ?? {};
                  const cx = vb.cx ?? vb.x ?? 0;
                  const cy = vb.cy ?? vb.y ?? 0;
                  // Anchored inward from the left edge; below the dot when the low point's label sits above it.
                  return (
                    <text x={cx + 6} y={lowIdx === 0 ? cy + 20 : cy - 10 - (startLines.length - 1) * 13} textAnchor="start" fill={CHART.navy} fontSize={11} fontWeight={600} data-testid="chart-start-label">
                      {startLines.map((line, i) => (
                        <tspan key={i} x={cx + 6} dy={i === 0 ? 0 : 13} fontWeight={i === 0 ? 600 : 500} data-testid={`chart-start-line-${i}`}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                  );
                }}
              />}
            </ReferenceDot>
          )}
          {pulse && lowestPoint && (
            // ONE soft ring after the sweep (`.low-pulse`); unmounted once it has played. Its own key: the chart
            // library keys a child by its position, and a marker appearing before it must not remount it.
            <ReferenceDot
              key="low-pulse"
              x={lowestPoint.x}
              y={lowestPoint.y}
              r={5}
              ifOverflow="extendDomain"
              isFront
              shape={(p: { cx?: number; cy?: number }) => (
                <circle
                  className="low-pulse"
                  cx={p.cx ?? 0}
                  cy={p.cy ?? 0}
                  r={6}
                  fill="none"
                  stroke={lowFill}
                  strokeWidth={2}
                  pointerEvents="none"
                  data-testid="low-pulse"
                />
              )}
            />
          )}
          {lowestPoint && (
            <ReferenceDot
              x={lowestPoint.x}
              y={lowestPoint.y}
              r={5}
              fill={lowFill}
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
                value={lowText}
                content={(p: unknown) => {
                  const vb =
                    (p as { viewBox?: { cx?: number; cy?: number; x?: number; y?: number } })
                      ?.viewBox ?? {};
                  const cx = vb.cx ?? vb.x ?? 0;
                  const cy = vb.cy ?? vb.y ?? 0;
                  // "short" sits BELOW the dot: it is the lowest point, so
                  // the curve is above it everywhere and the words never lie
                  // on the line (above, they crossed the dip's own walls).
                  const labelY = (lowLabel === "short" || (expanded && lowBelow) ? cy + 18 : cy - 12) + lowDrop;
                  // (Readable forecast) A plate in the panel's own white behind the words: the selected-day rule
                  // and the curve's walls pass behind them, never through them.
                  const w = lowText.length * LOW_CHAR_PX + 6;
                  const x0 = lowAnchorUsed === "start" ? cx - 3 : lowAnchorUsed === "end" ? cx - w + 3 : cx - w / 2;
                  const label = (
                    <text
                      // (Clean forecast line) The clean chart centres the words on their plate.
                      x={quiet ? x0 + w / 2 : cx}
                      y={labelY}
                      textAnchor={quiet ? "middle" : lowAnchorUsed}
                      fill={lowInk}
                      data-tone={lowNegative ? "bad" : "neutral"}
                      data-testid="chart-low-label"
                      fontSize={11}
                      fontWeight={600}
                      // (Readable forecast) A halo in the panel's own white, so the curve's walls never run
                      // through the words on a narrow chart.
                      style={calm ? { paintOrder: "stroke", stroke: "var(--color-platinum-0)", strokeWidth: 3, strokeLinejoin: "round" } : undefined}
                    >
                      {lowLabel === "short" ? `Low ${formatCurrency(lowestPoint.y)}` : lowText}
                    </text>
                  );
                  if (!calm) return label;
                  // (Clean forecast line) The clean chart draws the plate where the three labels were placed together.
                  if (quiet && calmPlaced?.low) {
                    return <LabelPlate box={calmPlaced.low.box} text={lowText} fill={lowInk} size={11} testid="chart-low-plate" textTestid="chart-low-label" tone={lowNegative ? "bad" : "neutral"} />;
                  }
                  return (
                    <g data-testid="chart-low-plate" data-plate="">
                      <rect x={x0} y={labelY - 11} width={w} height={15} rx={3} style={{ fill: "var(--color-platinum-0)", fillOpacity: quiet ? 1 : 0.92 }} />
                      {label}
                    </g>
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


/** "2026-05-14" → "May 14": the expanded axis has room for the month word. */
function longTick(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** One marker per day. Shape tells the kind apart as well as colour: payday an
 *  up-tick, bill a dot, card payment a square, debt payment a diamond. A day
 *  with several events is ONE marker carrying the count. */
function MarkerShape({
  cx,
  cy,
  group,
  selected,
  onSelect,
  showCount = true,
}: {
  cx: number;
  cy: number;
  group: MarkerGroup;
  selected: boolean;
  onSelect?: (iso: string | null) => void;
  /** (Readable forecast) The calm chart draws no counts: the day panel lists the day. */
  showCount?: boolean;
}) {
  const fill = MARKER[group.kind];
  const common = { fill, stroke: "#ffffff", strokeWidth: 1.5 } as const;
  return (
    <g
      data-testid={`marker-${group.date}`}
      data-kind={group.kind}
      data-count={group.count}
      style={{ cursor: onSelect ? "pointer" : undefined }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(group.date);
      }}
    >
      {selected && <circle cx={cx} cy={cy} r={11} fill="none" stroke={CHART.navy} strokeWidth={1.5} />}
      {group.kind === "payday" && (
        <path d={`M${cx} ${cy - 7} L${cx - 6} ${cy + 4} L${cx + 6} ${cy + 4} Z`} {...common} />
      )}
      {group.kind === "bill" && <circle cx={cx} cy={cy} r={5} {...common} />}
      {group.kind === "card" && <rect x={cx - 5} y={cy - 5} width={10} height={10} {...common} />}
      {group.kind === "debt" && (
        <path d={`M${cx} ${cy - 7} L${cx + 7} ${cy} L${cx} ${cy + 7} L${cx - 7} ${cy} Z`} {...common} />
      )}
      {showCount && group.count > 1 && (
        <text x={cx + 8} y={cy - 7} fontSize={10} fontWeight={700} fill={CHART.navy}>
          {group.count}
        </text>
      )}
    </g>
  );
}

/**
 * (Clean forecast line) The calm chart's payday mark: a small quiet tick standing on the plot's bottom edge,
 * just above the axis. Clicking it selects the day (a wider unseen target makes it easy to hit).
 */
function PaydayTick({ cx, cy, date, onSelect }: { cx: number; cy: number; date: string; onSelect?: (iso: string | null) => void }) {
  return (
    <g
      data-testid={`payday-tick-${date}`}
      data-edge="bottom"
      style={{ cursor: onSelect ? "pointer" : undefined }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(date);
      }}
    >
      <rect x={cx - 7} y={cy - 16} width={14} height={16} fill="transparent" />
      <line x1={cx} x2={cx} y1={cy - 9} y2={cy - 2} stroke={MARKER.payday} strokeWidth={CALM_STROKE.paydayTick} strokeLinecap="round" strokeOpacity={0.6} />
    </g>
  );
}

const TODAY_TEXT = "Today";

/** (Clean forecast line) A chart label on a small plate in the panel's own surface colour: rules and the line pass behind the words. */
function LabelPlate({
  box,
  text,
  fill,
  testid,
  size = 10,
  textTestid,
  tone,
}: {
  box: Box;
  text: string;
  fill: string;
  testid: string;
  size?: number;
  textTestid?: string;
  tone?: "bad" | "neutral";
}) {
  return (
    <g data-testid={testid} data-plate="" pointerEvents="none">
      <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0} rx={3} style={{ fill: "var(--color-platinum-0)" }} />
      <text x={(box.x0 + box.x1) / 2} y={(box.y0 + box.y1) / 2 + size * 0.36} textAnchor="middle" fill={fill} fontSize={size} fontWeight={600} data-testid={textTestid} data-tone={tone}>
        {text}
      </text>
    </g>
  );
}

/**
 * (Clean forecast line) The calm chart's hover cursor: a thin hairline and a dot ON the line. The chart library
 * hands it the active day's x (`points`) and row (`payload`); both nodes stay mounted while the pointer is on
 * the plot and move by `transform`, so with `glide` they travel between days (`.chart-glide`) instead of
 * jumping. No layout is read or written.
 */
function HoverCursor({
  domain,
  glide,
  points,
  payload,
}: {
  domain: readonly [number, number];
  glide: boolean;
  points?: ReadonlyArray<{ x: number; y: number }>;
  payload?: ReadonlyArray<{ payload?: { balance?: number | null } }>;
}) {
  const top = points?.[0];
  const bottom = points?.[1];
  if (!top || !bottom) return null;
  const [d0, d1] = domain;
  const bal = Number(payload?.[0]?.payload?.balance);
  const y = Number.isFinite(bal) && d1 > d0 ? top.y + ((d1 - bal) / (d1 - d0)) * (bottom.y - top.y) : null;
  const cls = glide ? "chart-glide" : undefined;
  return (
    <g pointerEvents="none" data-testid="hover-cursor">
      <line
        className={cls}
        x1={0}
        x2={0}
        y1={top.y}
        y2={bottom.y}
        stroke={CHART.mist}
        strokeWidth={CALM_STROKE.hairline}
        style={{ transform: `translateX(${top.x}px)` }}
        data-testid="hover-hairline"
      />
      {y != null && (
        <circle
          className={cls}
          cx={0}
          cy={0}
          r={4.5}
          fill={CHART.navy}
          strokeWidth={2}
          style={{ stroke: "var(--color-platinum-0)", transform: `translate(${top.x}px, ${y}px)` }}
          data-testid="hover-dot"
        />
      )}
    </g>
  );
}
