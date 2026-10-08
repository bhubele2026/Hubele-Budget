import { useMemo, useState, type KeyboardEvent } from "react";
import { Maximize2 } from "lucide-react";
import { Panel } from "@/components/next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { householdToday } from "@/lib/householdDay";
import { groupMarkers, kindEvents, stepDate, type KindedEvent } from "@/lib/forecastEventKinds";
import { ProjectedBalanceChart } from "../../forecast/ProjectedBalanceChart";
import { ChartLegend } from "./ChartLegend";
import type { ForecastNextCtx } from "./types";

/** Kinded events + markers, derived once from the same events the register and
 *  the tooltip read. */
export function useChartModel(ctx: ForecastNextCtx) {
  const events = ctx.proj?.events;
  const kinded = useMemo(() => kindEvents(events ?? [], ctx.debtLinks), [events, ctx.debtLinks]);
  const markers = useMemo(() => {
    const byDate = new Map(ctx.dailySeries.map((d) => [d.rawDate, d.balance]));
    return groupMarkers(kinded, byDate);
  }, [kinded, ctx.dailySeries]);
  const incomeByDate = useMemo(() => {
    const m = new Map<string, Array<{ label: string; amount: number }>>();
    for (const e of kinded) {
      if (e.amount <= 0) continue;
      const slot = m.get(e.date) ?? [];
      slot.push({ label: e.label, amount: e.amount });
      m.set(e.date, slot);
    }
    return m;
  }, [kinded]);
  return { kinded, markers, incomeByDate };
}

export function ChartPanel({
  ctx,
  kinded,
  markers,
  incomeByDate,
  selectedDate,
  onSelectDate,
}: {
  ctx: ForecastNextCtx;
  kinded: KindedEvent[];
  markers: ReturnType<typeof useChartModel>["markers"];
  incomeByDate: ReturnType<typeof useChartModel>["incomeByDate"];
  selectedDate: string | null;
  onSelectDate: (iso: string | null) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const label = `${ctx.bankAccountName}${ctx.bankAccountMask ? ` ••${ctx.bankAccountMask}` : ""}`;
  const noCurve = ctx.dailySeries.length === 0 || ctx.proj?.status === "no_data";

  const chart = (
    <ProjectedBalanceChart
      variant="expanded"
      data={ctx.dailySeries}
      cashBuffer={ctx.cashBufferNum}
      lowestPoint={ctx.lowestPoint}
      bigBillMarkers={ctx.bigBillMarkers}
      eventsByDate={ctx.eventsByDate}
      onJumpToPlan={ctx.jumpToPlan}
      onMarkMissed={ctx.onMarkMissed}
      lockedPlanKeys={ctx.partialPlanKeys}
      todayISO={householdToday()}
      markers={markers}
      incomeByDate={incomeByDate}
      riskShading
      selectedDate={selectedDate}
      onSelectDate={onSelectDate}
      hoverSelects
      horizonKey={ctx.horizonDays}
    />
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      onSelectDate(stepDate(ctx.dailySeries, selectedDate, e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "Escape" && selectedDate) {
      e.preventDefault();
      onSelectDate(null);
    }
  };

  return (
    <Panel
      title={`Projected cash — ${label}`}
      sub={`${ctx.horizonDays} days. Solid up to today, dashed after.`}
      span={12}
      data-testid="card-projected-balance-chart"
      actions={
        !noCurve ? (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="press inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-micro font-semibold text-brand-navy ring-1 ring-brand-line hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 lg:hidden"
            data-testid="chart-expand"
          >
            <Maximize2 className="h-3 w-3" aria-hidden="true" />
            Expand
          </button>
        ) : null
      }
    >
      {ctx.cashProjectionLoading && ctx.dailySeries.length === 0 ? (
        <Skeleton className="h-[360px] w-full lg:h-[460px]" />
      ) : noCurve ? (
        <div
          className="flex h-[360px] w-full flex-col items-center justify-center gap-3 px-4 text-center lg:h-[460px]"
          data-testid="empty-projected-balance"
        >
          <p className="text-body text-neutral-500">Set a bank snapshot or add planned items to draw the curve.</p>
          <Button size="sm" onClick={ctx.openSnapshot} data-testid="button-empty-set-bank-snapshot">
            Set bank snapshot
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div
            tabIndex={0}
            role="group"
            aria-label="Projected cash chart. Left and right arrow keys move the selected day; Escape clears it."
            onKeyDown={onKeyDown}
            className="h-[360px] w-full rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 lg:h-[460px]"
            data-testid="chart-surface"
          >
            {chart}
          </div>
          <ChartLegend />
        </div>
      )}
      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DialogContent
          className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-3 rounded-none p-4 sm:rounded-none"
          data-testid="chart-sheet"
        >
          <DialogTitle className="text-title font-semibold text-brand-navy">Projected cash — {label}</DialogTitle>
          <div className="min-h-0 flex-1" onKeyDown={onKeyDown}>
            {sheetOpen && chart}
          </div>
          <ChartLegend />
        </DialogContent>
      </Dialog>
      <span className="sr-only" aria-live="polite" data-testid="selected-day-live">
        {selectedDate ? `Selected day ${selectedDate}. ${kinded.filter((e) => e.date === selectedDate).length} events.` : ""}
      </span>
    </Panel>
  );
}
