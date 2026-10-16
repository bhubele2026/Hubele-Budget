import { Suspense, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
import { Link, useLocation } from "wouter";
import { Panel, shortDate } from "@/components/next";
import { ACCOUNT_ACCENT } from "@/lib/chartTokens";
import { buildEventsByDate } from "@/lib/forecastPastDue";
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

/**
 * "Will we run short, and when?" The projected checking balance over 30, 90 or
 * 120 days: the buffer line, days under it shaded, the low point marked, a
 * tooltip per day. The chart draws once per answer (its own fingerprint memo);
 * a horizon switch keeps the chart in place (dimmed, "Loading N days…") while the new one loads. Every link goes to the full forecast.
 */
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
    return { series, lowestPoint, byDate, buffer: Number(proj.cashBuffer) };
  }, [proj]);

  const ready = !!proj && proj.status !== "no_data" && !!view && view.series.length > 0;

  return (
    <Panel
      title="Cash-flow forecast"
      sub="Projected checking balance"
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
              <>
                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-neutral-600" data-testid="dash-forecast-legend">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: ACCOUNT_ACCENT.checking }} />
                    Checking
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="h-0 w-3 border-t border-dashed border-neutral-400" />
                    Buffer {money(view!.buffer)}
                  </span>
                  {/* (T2) Only a projected NEGATIVE is rust; under the buffer at or above $0 is quiet. */}
                  {loading ? (
                    <span data-testid="dash-forecast-loading" role="status">Loading {days} days…</span>
                  ) : view!.lowestPoint ? (
                    <span data-testid="dash-forecast-low">
                      Low point in these {days} days:{" "}
                      <span className={cn("font-mono font-semibold tabular-nums", view!.lowestPoint.y < 0 ? "text-bad-ink" : "text-brand-ink")} data-tone={view!.lowestPoint.y < 0 ? "bad" : "neutral"}>
                        {money(view!.lowestPoint.y)}
                      </span>{" "}
                      on {weekdayLabel(view!.lowestPoint.rawDate)}
                    </span>
                  ) : null}
                </div>
                <div className={cn("h-80 w-full transition-opacity", loading && "opacity-60")} aria-busy={loading} data-testid="dash-forecast-chart">
                  <Suspense fallback={<div className="skeleton h-full w-full rounded-control" />}>
                    <Chart
                      data={view!.series}
                      cashBuffer={view!.buffer}
                      lowestPoint={view!.lowestPoint}
                      bigBillMarkers={[]}
                      eventsByDate={view!.byDate}
                      onJumpToPlan={() => navigate("/forecast")}
                      onMarkMissed={noop}
                      lowLabel="short"
                      monthTicks
                      sessionKey="dash-forecast"
                    />
                  </Suspense>
                </div>
              </>
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
