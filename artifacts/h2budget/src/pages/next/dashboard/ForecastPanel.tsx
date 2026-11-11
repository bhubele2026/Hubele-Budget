import { Suspense, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
import { Link, useLocation } from "wouter";
import { Panel, shortDate } from "@/components/next";
import { buildEventsByDate } from "@/lib/forecastPastDue";
import { groupMarkers, inOutByDate, kindDayItems, kindEvents, runsBelow, type BankDayRow } from "@/lib/forecastEventKinds";
import { householdToday } from "@/lib/householdDay";
import { ChartLegend } from "@/pages/next/forecast/ChartLegend";
import { cn } from "@/lib/utils";
import { useCashSignalQ } from "./queries";
import { BELOW_FOLD } from "./belowFoldSizes";
import { useFoldMinH } from "./foldDensity";
import { toggle } from "@/ui";
import { Gate, LINK, money, rise, weekdayLabel } from "./shared";

/** The chart (and recharts with it) loads only when this panel mounts. */
const Chart = lazyWithPreload(() =>
  import("@/pages/forecast/ProjectedBalanceChart").then((m) => ({ default: m.ProjectedBalanceChart })),
);

export const HORIZONS = [30, 90, 120] as const;
const noop = () => {};
/** The home chart draws paydays only, so no event needs telling apart as a debt payment. */
const NO_LINKS: ReadonlyMap<string, string> = new Map();
const NO_BANK: BankDayRow[] = [];
const NO_BIG: never[] = [];

/**
 * "Will we run short, and when?" The projected checking balance over 30, 90 or
 * 120 days. (Home says less, 2026-11-11) The same clean line as the Forecast
 * page: one solid navy line, paydays as small ticks on the axis, and plated
 * labels for today, the low point (amount and day) and the cushion. The low
 * point is said ON the chart and in the chart box's `aria-label`; the legend is
 * the short one. The chart draws in once a session (`sessionKey`); a horizon
 * switch keeps it mounted (dimmed, "Loading N days…") and the line reshapes.
 * Every link goes to the full forecast.
 */
/** The chart box, in words: the horizon and the low point (amount and day), for a reader who cannot see the line. */
export function chartWords(days: number, low: { y: number; rawDate: string } | null): string {
  const head = `Checking forecast, next ${days} days.`;
  if (!low) return head;
  return `${head} Lowest ${money(low.y)} on ${weekdayLabel(low.rawDate) ?? low.rawDate}.`;
}

export default function ForecastPanel() {
  const minH = useFoldMinH("forecast");
  const [days, setDays] = useState<number>(90);
  const [, navigate] = useLocation();
  const q = useCashSignalQ(days, { placeholderData: keepPreviousData });
  const proj = q.data;
  // The last horizon's answer stays mounted while this one loads: no skeleton swap, no remount, no re-sweep.
  const loading = q.isPlaceholderData;

  const view = useMemo(() => {
    if (!proj) return null;
    const series = (proj.daily ?? [])
      .map((d) => ({ date: shortDate(d.date), rawDate: d.date, balance: Number(d.balance) }))
      .filter((d) => Number.isFinite(d.balance));
    const lowNum = Number(proj.lowestProjected);
    const match = proj.lowestDate ? series.find((d) => d.rawDate === proj.lowestDate) : undefined;
    const lowestPoint = match && Number.isFinite(lowNum) ? { x: match.rawDate, y: lowNum, rawDate: match.rawDate } : null;
    // The dashboard offers no "mark missed": strip the drag flag so the tooltip shows facts only.
    const byDate = new Map(
      [...buildEventsByDate(proj.events ?? [])].map(([k, v]) => [k, v.map((e) => ({ ...e, dragged: false }))]),
    );
    // The clean chart's marks, read exactly as the Forecast page reads them: every item the walk applied
    // (`dayItems`), else the planned events. Display grouping of the server's amounts; nothing is worked out.
    const { kinded, bank } = proj.dayItems
      ? kindDayItems(proj.dayItems, NO_LINKS)
      : { kinded: kindEvents(proj.events ?? [], NO_LINKS), bank: NO_BANK };
    const markers = groupMarkers(kinded, new Map(series.map((d) => [d.rawDate, d.balance])));
    const dayTotals = inOutByDate(kinded, bank);
    const buffer = Number(proj.cashBuffer);
    return {
      series, lowestPoint, byDate, buffer, markers, dayTotals,
      hasUnder: runsBelow(series, buffer).length > 0,
      hasNegative: runsBelow(series, 0).length > 0,
    };
  }, [proj]);

  // The horizon the curve on screen was worked out for (the last one, while the next loads).
  const shownDays = loading ? (proj?.horizonDays ?? days) : days;

  const ready = !!proj && proj.status !== "no_data" && !!view && view.series.length > 0;

  return (
    <Panel
      title="Checking forecast"
      span={BELOW_FOLD.forecast.span}
      variant="static"
      className={cn(rise(BELOW_FOLD.forecast.rise), minH)}
      data-testid="dash-forecast"
      actions={
        <div className="flex gap-1" role="group" aria-label="Forecast horizon">
          {HORIZONS.map((h) => (
            <button key={h} type="button" onClick={() => setDays(h)} aria-pressed={days === h}
              data-testid={`dash-horizon-${h}`}
              className={cn(toggle(days === h), "px-2 py-0.5 text-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40")}>
              <span className="sm:hidden" aria-hidden>{h}d</span>
              <span className="hidden sm:inline">{h} days</span>
              <span className="sr-only sm:hidden">{h} days</span>
            </button>
          ))}
        </div>
      }
    >
      <Gate q={q} what="The forecast" rows={6}>
        {() => (
          <div>
            {!ready ? (
              <p className="py-8 text-center text-body text-neutral-500" data-testid="dash-forecast-empty">
                The forecast needs a bank balance before it can draw a line.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="relative h-80 w-full">
                  <div
                    role="group"
                    aria-label={chartWords(shownDays, view!.lowestPoint)}
                    className={cn("h-80 w-full transition-opacity", loading && "opacity-60")}
                    aria-busy={loading}
                    data-testid="dash-forecast-chart"
                  >
                    <Suspense fallback={<div className="skeleton h-full w-full rounded-control" />}>
                      <Chart
                        variant="expanded"
                        calm
                        data={view!.series}
                        cashBuffer={view!.buffer}
                        lowestPoint={view!.lowestPoint}
                        bigBillMarkers={NO_BIG}
                        eventsByDate={view!.byDate}
                        onJumpToPlan={() => navigate("/forecast")}
                        onMarkMissed={noop}
                        todayISO={householdToday()}
                        markers={view!.markers}
                        dayTotals={view!.dayTotals}
                        riskShading
                        horizonKey={days}
                        sessionKey="dash-forecast"
                      />
                    </Suspense>
                  </div>
                  {loading ? (
                    <span
                      role="status"
                      className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-control bg-white px-2 py-0.5 text-micro text-neutral-600 shadow-lift ring-1 ring-brand-line"
                      data-testid="dash-forecast-loading"
                    >
                      Loading {days} days…
                    </span>
                  ) : null}
                </div>
                <div data-testid="dash-forecast-legend">
                  <ChartLegend short hasUnder={view!.hasUnder} hasNegative={view!.hasNegative} />
                </div>
              </div>
            )}
            <div className="mt-3 flex gap-4 text-label">
              <Link href="/forecast" className={LINK} data-testid="dash-forecast-link">Open the forecast</Link>
            </div>
          </div>
        )}
      </Gate>
    </Panel>
  );
}
