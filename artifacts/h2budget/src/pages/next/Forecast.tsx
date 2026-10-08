import { useCallback, useEffect, useRef, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { Page } from "@/ui";
import { PageGrid, Panel, StatBlock } from "@/components/next";
import { formatCurrency, formatDate } from "@/lib/utils";
import ForecastPage from "../forecast";
import { ChartPanel, useChartModel } from "./forecast/ChartPanel";
import { DayPanel } from "./forecast/DayPanel";
import type { ForecastNextCtx } from "./forecast/types";

type RegisterTab = "register" | "plan";

const TABS: Array<{ id: RegisterTab; label: string }> = [
  { id: "register", label: "Register & reconcile" },
  { id: "plan", label: "Month & bank" },
];

/** The same headline figures the classic page shows, read off the same cash
 *  signal. */
function SummaryStrip({ ctx }: { ctx: ForecastNextCtx }) {
  const { proj, projReady } = ctx;
  const lowest = proj?.lowestProjected ? Number(proj.lowestProjected) : NaN;
  const buffer = Number.isFinite(ctx.cashBufferNum) ? ctx.cashBufferNum : null;
  const dips = Number.isFinite(lowest) && lowest < Number(proj?.cashBuffer ?? 0);
  return (
    <Panel title="Where the money lands" span={12} data-testid="forecast-kpis">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 xl:grid-cols-6">
        <StatBlock
          data-testid="kpi-bank-today"
          label="Bank today"
          value={formatCurrency(ctx.bankBalance)}
          hint={`${ctx.bankAccountName}${ctx.bankAccountMask ? ` ••${ctx.bankAccountMask}` : ""}`}
        />
        <StatBlock
          data-testid="kpi-cash-buffer"
          label="Cash buffer"
          value={buffer == null ? "—" : formatCurrency(buffer)}
        />
        <StatBlock
          data-testid="kpi-lowest-point"
          label="Lowest point"
          value={projReady && Number.isFinite(lowest) ? formatCurrency(lowest) : "—"}
          tone={dips ? "bad" : "neutral"}
          hint={`${!projReady ? "Set a bank balance to project" : dips ? "under buffer" : "above buffer"}${
            proj?.lowestDate ? ` · ${formatDate(proj.lowestDate)}` : ""
          }`}
        />
        <StatBlock
          data-testid="kpi-ending-balance"
          label="Ending balance"
          value={proj && proj.status !== "no_data" ? formatCurrency(proj.endingBalance ?? 0) : "—"}
          hint={proj?.endingDate ? formatDate(proj.endingDate) : `${ctx.horizonDays}-day horizon`}
        />
        <StatBlock
          data-testid="kpi-projected-income"
          label="Money in"
          value={proj ? formatCurrency(Number(proj.projectedIncome) || 0) : "—"}
          hint={`over ${ctx.horizonDays}d`}
        />
        <StatBlock
          data-testid="kpi-projected-expenses"
          label="Money out"
          value={proj ? formatCurrency(Number(proj.projectedExpenses) || 0) : "—"}
          hint={`over ${ctx.horizonDays}d`}
        />
      </div>
    </Panel>
  );
}

function NextForecastBody({
  ctx,
  tab,
  setTab,
  selectedDate,
  setSelectedDate,
}: {
  ctx: ForecastNextCtx;
  tab: RegisterTab;
  setTab: (t: RegisterTab) => void;
  selectedDate: string | null;
  setSelectedDate: (d: string | null) => void;
}) {
  const { kinded, markers, incomeByDate } = useChartModel(ctx);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);
  // Switch to the register first, then jump: the row has to be on screen.
  const openRegister = useCallback(
    (then: () => void) => {
      if (tab === "register") {
        then();
        return;
      }
      setTab("register");
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(then, 80);
    },
    [tab, setTab],
  );

  return (
    <PageGrid>
      <div className="span-12 space-y-2" data-testid="forecast-controls">
        <div className="flex flex-wrap items-center gap-3">
          {ctx.horizonControls}
          <button
            type="button"
            onClick={ctx.openSettings}
            className="press ml-auto inline-flex items-center gap-1.5 rounded-control px-2.5 py-1 text-micro font-semibold text-neutral-600 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
          >
            <SettingsIcon className="h-3 w-3" aria-hidden="true" /> Settings
          </button>
        </div>
        <p className="text-micro text-neutral-500" data-testid="filters-note">
          What filters do: the horizon and look-back are sent to the forecast, so they change the curve and every figure
          above it. The month picker and the register tabs only change which rows are listed.
        </p>
      </div>

      <SummaryStrip ctx={ctx} />

      <ChartPanel
        ctx={ctx}
        kinded={kinded}
        markers={markers}
        incomeByDate={incomeByDate}
        selectedDate={selectedDate}
        onSelectDate={setSelectedDate}
      />

      <section className="panel span-8 min-w-0" data-testid="register-panel">
        <header className="panel-head">
          <div role="tablist" aria-label="Register views" className="flex flex-wrap items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`register-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`register-pane-${t.id}`}
                onClick={() => setTab(t.id)}
                data-testid={`tab-${t.id}`}
                className={`press rounded-control px-3 py-1.5 text-label font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 ${
                  tab === t.id ? "bg-brand-navy text-white" : "text-neutral-500 hover:bg-neutral-50 hover:text-brand-navy"
                }`}
              >
                {t.label}
                {t.id === "register" && ctx.inboxCount > 0 ? ` · ${ctx.inboxCount}` : ""}
              </button>
            ))}
          </div>
        </header>
        <div
          key={tab}
          role="tabpanel"
          id={`register-pane-${tab}`}
          aria-labelledby={`register-tab-${tab}`}
          className="chart-in space-y-4 p-4"
        >
          {tab === "register" ? (
            ctx.registerBlock
          ) : (
            <>
              {ctx.draggingCard}
              {ctx.bankGrid}
              {ctx.monthBlock}
            </>
          )}
        </div>
      </section>

      <Panel title="Selected day" span={4} data-testid="selected-day-panel">
        <DayPanel
          ctx={ctx}
          kinded={kinded}
          selectedDate={selectedDate}
          onClear={() => setSelectedDate(null)}
          onOpenRegister={openRegister}
        />
      </Panel>
    </PageGrid>
  );
}

export default function NextForecastPage() {
  const [tab, setTab] = useState<RegisterTab>("register");
  // Keyed by DATE and held out here, above the data page, so a refetch or a
  // horizon change never drops it.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  return (
    <div data-testid="page-next-forecast">
      <Page title="Forecast" sub="Preview">
        <ForecastPage
          mode={tab === "register" ? "review" : "overall"}
          renderNext={(ctx) => (
            <NextForecastBody
              ctx={ctx}
              tab={tab}
              setTab={setTab}
              selectedDate={selectedDate}
              setSelectedDate={setSelectedDate}
            />
          )}
        />
      </Page>
    </div>
  );
}
