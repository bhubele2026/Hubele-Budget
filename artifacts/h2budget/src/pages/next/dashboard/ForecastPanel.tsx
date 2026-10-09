import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Panel, shortDate } from "@/components/next";
import { ACCOUNT_ACCENT } from "@/lib/chartTokens";
import { buildEventsByDate } from "@/lib/forecastPastDue";
import { cn, formatCurrency } from "@/lib/utils";
import { useCashSignalQ } from "./queries";
import { BELOW_FOLD } from "./belowFoldSizes";
import { dayLabel, Gate, rise } from "./shared";

/** The chart (and recharts with it) loads only when this panel mounts. */
const Chart = lazy(() =>
  import("@/pages/forecast/ProjectedBalanceChart").then((m) => ({ default: m.ProjectedBalanceChart })),
);

const HORIZONS = [30, 90, 180] as const;
const noop = () => {};

export default function ForecastPanel() {
  const [days, setDays] = useState<number>(90);
  const [, navigate] = useLocation();
  const q = useCashSignalQ(days);
  const proj = q.data;

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
      sub="Projected cash (checking)"
      span={8}
      className={cn(rise(BELOW_FOLD.forecast.rise), BELOW_FOLD.forecast.minH)}
      data-testid="dash-forecast"
      actions={
        <div className="flex gap-1" role="group" aria-label="Forecast horizon">
          {HORIZONS.map((h) => (
            <button key={h} type="button" onClick={() => setDays(h)} aria-pressed={days === h}
              data-testid={`dash-horizon-${h}`}
              className={`rounded-control px-2 py-0.5 text-micro font-semibold ring-1 ring-brand-line ${days === h ? "bg-brand-navy text-white" : "text-neutral-600 hover:bg-neutral-50"}`}>
              {h}d
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
                    <span aria-hidden className="size-2 rounded-full" style={{ background: ACCOUNT_ACCENT.checking }} />
                    Projected cash (checking)
                  </span>
                  <span>Buffer {formatCurrency(view!.buffer)}</span>
                  {view!.lowestPoint ? (
                    <span data-testid="dash-forecast-low">
                      Low point {formatCurrency(view!.lowestPoint.y)} · {dayLabel(view!.lowestPoint.rawDate)}
                    </span>
                  ) : null}
                </div>
                <div className="h-64 w-full" data-testid="dash-forecast-chart">
                  <Suspense fallback={<div className="skeleton h-full w-full rounded-control" />}>
                    <Chart
                      data={view!.series}
                      cashBuffer={view!.buffer}
                      lowestPoint={view!.lowestPoint}
                      bigBillMarkers={[]}
                      eventsByDate={view!.byDate}
                      onJumpToPlan={() => navigate("/forecast")}
                      onMarkMissed={noop}
                    />
                  </Suspense>
                </div>
              </>
            )}
            <div className="mt-3 flex gap-4 text-label">
              <Link href="/next/forecast" className="text-brand-navy underline">Open the full forecast</Link>
            </div>
          </div>
        )}
      </Gate>
    </Panel>
  );
}
