import { useMemo } from "react";
import {
  useListDebts,
  useListDebtBalanceHistory,
  useGetAvalancheSettings,
  useGetAvalancheExtra,
  type DebtBalanceHistoryEntry,
} from "@workspace/api-client-react";
import { PageSkeleton } from "@/components/page-skeleton";
import { DebtPendingHint } from "@/components/debt-pending-hint";
import { formatCurrency, cn } from "@/lib/utils";
import {
  ANIM_AREA,
  ANIM_BAR,
  CHART,
  animBegin,
  catColor,
} from "@/lib/chartTokens";
import { CssFillMeter } from "@/lib/cssBars";
import { emptyNote, th, td, tdNum, Foot, Stat } from "@/ui";
import {
  fmtMonthLabel,
  debtToSim,
  payoffStackedSeries,
  snowballWaterfall,
  interestVsPrincipal,
  perDebtProgress,
  totalPaidOffSoFar,
  totalBalanceHistory,
  debtsKilledOrder,
  debtFreeCountdown,
  totalsForDebts,
  simulate,
  interestIfMinimumsOnly,
  payoffProjectionGauge,
} from "@/lib/reportsAnalytics";
import {
  ResponsiveContainer,
  AreaChart,
  BarChart,
  CartesianGrid,
  Area,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  AXIS_TICK,
  GRID_STROKE,
  LEGEND_STYLE,
  ChartCard,
  PanelCard,
  axisMoney,
  axisMoneyK,
  tooltipMoney,
  tooltipStyle,
  ReportShell,
} from "./reportsShared";

/**
 * ── SERIES COLOURS, AUDITED PER CHART ──────────────────────────────────────
 * Per-debt series take `catColor(i)` — a colour marks an ITEM here, so it must
 * survive a filter and must not be reassigned by rank. Everything else is a
 * two-series chart where the pair has to read as opposites.
 */
export const DEBT_SERIES = {
  /** Actual total-balance history — one series. */
  history: CHART.navy,
  /** Freed minimums vs the running snowball. */
  waterfall: { freed: CHART.orange, cumulative: CHART.navy },
  /** The payment split. Principal is the part that actually kills the debt. */
  split: { principal: CHART.navy, interest: CHART.orangeDeep },
} as const;

export default function DebtPage() {
  // (#a8 per-page fetch) The debt report reads debts + balance history + the
  // avalanche plan — no transaction pull at all (the old shared hook fetched a
  // 95-day txn window this page never rendered).
  const today = useMemo(() => new Date(), []);
  const { data: debts, isLoading: debtsLoading } = useListDebts();
  const { data: debtBalanceHistory } = useListDebtBalanceHistory();
  const { data: avSettings } = useGetAvalancheSettings();
  const { data: avExtra } = useGetAvalancheExtra();
  if (debtsLoading) return <PageSkeleton />;
  return (
    <ReportShell crumb="Debt payoff" title="Debt payoff">
      <DebtSection
        debts={debts ?? []}
        balanceHistory={debtBalanceHistory ?? []}
        strategy={(avSettings?.strategy as "avalanche" | "snowball") ?? "avalanche"}
        extraPerMonth={Number(avExtra?.amount ?? avSettings?.manualExtra ?? 0)}
        today={today}
      />
    </ReportShell>
  );
}

function DebtSection({
  debts,
  balanceHistory,
  strategy,
  extraPerMonth,
  today,
}: {
  debts: import("@workspace/api-client-react").Debt[];
  balanceHistory: DebtBalanceHistoryEntry[];
  strategy: "avalanche" | "snowball";
  extraPerMonth: number;
  today: Date;
}) {
  const simDebts = useMemo(() => debts.map(debtToSim), [debts]);
  const sim = useMemo(
    () => simulate({ debts: simDebts, extraPerMonth, strategy }),
    [simDebts, extraPerMonth, strategy],
  );
  const { totalBalance, totalMin } = useMemo(() => totalsForDebts(debts), [debts]);

  const countdown = useMemo(() => debtFreeCountdown(sim, today), [sim, today]);
  const stacked = useMemo(
    () => payoffStackedSeries(sim, simDebts.filter((d) => (d.status ?? "active") === "active")),
    [sim, simDebts],
  );
  const waterfall = useMemo(() => snowballWaterfall(sim), [sim]);
  const ipBars = useMemo(() => interestVsPrincipal(sim, 24), [sim]);
  const killed = useMemo(() => debtsKilledOrder(sim), [sim]);
  const progress = useMemo(
    () => perDebtProgress(debts, sim, balanceHistory),
    [debts, sim, balanceHistory],
  );
  const totalPaid = useMemo(
    () => totalPaidOffSoFar(debts, balanceHistory),
    [debts, balanceHistory],
  );
  const pastBalanceCurve = useMemo(
    () => totalBalanceHistory(debts, balanceHistory),
    [debts, balanceHistory],
  );
  const minOnlyInterest = useMemo(() => interestIfMinimumsOnly(simDebts), [simDebts]);
  const interestSaved =
    Number.isFinite(minOnlyInterest) && minOnlyInterest > sim.totalInterestPaid
      ? minOnlyInterest - sim.totalInterestPaid
      : 0;
  const gauge = useMemo(() => payoffProjectionGauge(sim, 12), [sim]);
  // (C10) Every balance on this page is now netted, so every balance on this
  // page owes the reader the same disclosure the Debts and Avalanche tables
  // give. `perDebtProgress` returns numbers, not rows, so the source debt is
  // looked up here rather than widening that function's return shape.
  const debtById = useMemo(
    () => new Map(debts.map((d) => [d.id, d] as const)),
    [debts],
  );

  const activeDebts = simDebts.filter((d) => (d.status ?? "active") === "active");
  const maxMonthsLeft = Math.max(
    1,
    ...progress.map((p) => p.monthsLeft ?? sim.monthsToFreedom),
  );

  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          index={0}
          label="Total debt"
          value={formatCurrency(totalBalance)}
          hint={`${activeDebts.length} active`}
          tone="bad"
          data-testid="debt-report-total"
        />
        <Stat
          index={1}
          label="Months to debt-free"
          value={countdown.months !== null ? String(countdown.months) : "∞"}
          hint={
            countdown.date
              ? `${(countdown.months! / 12).toFixed(1)} years on this plan`
              : "No payoff inside the window at this extra"
          }
          data-testid="debt-report-months"
        />
        <Stat
          index={2}
          label="Debt-free date"
          value={countdown.date ? fmtMonthLabel(countdown.date) : "—"}
          hint={countdown.days !== null ? `about ${countdown.days} days` : "—"}
          data-testid="debt-report-date"
        />
        <Stat
          index={3}
          label="Interest avoided"
          value={
            Number.isFinite(minOnlyInterest) ? formatCurrency(interestSaved) : "∞"
          }
          hint={`vs ${formatCurrency(sim.totalInterestPaid)} on plan`}
          data-testid="debt-report-interest-saved"
        />
      </div>

      {/* Paid off so far — the one big number, as % of the starting total. */}
      <PanelCard
        title="Paid off since tracking began"
        help="Share of the starting total balance already cleared. The starting total is the earliest balance on record for each debt."
      >
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span
              className="font-mono text-display font-semibold tabular-nums text-brand-navy"
              data-testid="debt-report-paid-pct"
            >
              {totalPaid.pct.toFixed(1)}%
            </span>
            <span className="font-mono text-micro tabular-nums text-neutral-500">
              {formatCurrency(totalPaid.paidOff)} of{" "}
              {formatCurrency(totalPaid.startingBalance)}
            </span>
          </div>
          <CssFillMeter
            value={totalPaid.paidOff}
            ceiling={totalPaid.startingBalance}
            className="mt-2.5"
            title={`${formatCurrency(totalPaid.paidOff)} of ${formatCurrency(totalPaid.startingBalance)} paid`}
          />
        </div>
        <Foot>
          {totalPaid.trackingSince
            ? `Tracking since ${totalPaid.trackingSince}.`
            : "Tracking starts today."}{" "}
          The plan projects {gauge.pct.toFixed(0)}% more over the next 12 months.
        </Foot>
      </PanelCard>

      {/* Per-debt progress — a table, not eight rings. Each row carries its own
          fill against its own starting balance. */}
      <PanelCard
        title="Per-debt progress"
        help="Filled share is how much of each debt's own starting balance is already paid off. Months left and payoff date come from the current plan."
      >
        {progress.length === 0 ? (
          <div className={emptyNote}>No debts to track yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr>
                  <th className={th}>Debt</th>
                  <th className={cn(th, "w-[22%]")}>Paid off</th>
                  <th className={cn(th, "text-right")}>Paid</th>
                  <th className={cn(th, "text-right")}>Balance</th>
                  <th className={cn(th, "text-right")}>APR</th>
                  <th className={cn(th, "text-right")}>Months left</th>
                  <th className={th}>Payoff</th>
                </tr>
              </thead>
              <tbody>
                {progress.map((p) => (
                  <tr key={p.id} data-testid={`debt-progress-${p.id}`}>
                    <td className={cn(td, "max-w-[200px] truncate font-medium")}>
                      {p.name}
                    </td>
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <CssFillMeter
                          value={p.paidOff}
                          ceiling={p.startingBalance}
                          className="flex-1"
                        />
                        <span className="w-9 shrink-0 text-right font-mono text-micro tabular-nums text-neutral-500">
                          {Math.round(p.paidPct)}%
                        </span>
                      </div>
                    </td>
                    <td className={tdNum}>{formatCurrency(p.paidOff)}</td>
                    <td className={tdNum}>{formatCurrency(p.balance)}</td>
                    <td className={cn(tdNum, "text-neutral-500")}>
                      {(p.apr * 100).toFixed(2)}%
                    </td>
                    <td className={tdNum}>
                      {p.monthsLeft !== null ? p.monthsLeft : "∞"}
                    </td>
                    <td className={cn(td, "text-neutral-500")}>
                      {p.payoffDate ? (
                        fmtMonthLabel(p.payoffDate)
                      ) : (
                        <span className="chip warn">Not in window</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelCard>

      {/* Real past curve */}
      <ChartCard
        title="Total balance — actual history"
        help="Total household debt over time. Balances from before a debt was linked are approximated, and the final point reflects current balances, so paid-off debts drop to zero."
        empty={pastBalanceCurve.length === 0 ? "No history yet" : null}
        hideWhenEmpty
        height={220}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={pastBalanceCurve}
            margin={{ top: 10, right: 16, bottom: 16, left: 0 }}
          >
            <defs>
              <linearGradient id="past-balance" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={DEBT_SERIES.history} stopOpacity={0.7} />
                <stop offset="100%" stopColor={DEBT_SERIES.history} stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="date" tick={AXIS_TICK} interval="preserveStartEnd" />
            <YAxis tick={AXIS_TICK} tickFormatter={axisMoneyK} width={52} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Area {...ANIM_AREA} animationBegin={animBegin(0)} type="monotone"
              dataKey="total"
              stroke={DEBT_SERIES.history}
              fill="url(#past-balance)"
              strokeWidth={2}
              name="Total balance"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Stacked payoff timeline */}
      <ChartCard
        title="Payoff timeline"
        help="Stacked balance per debt over time — each layer disappears as that debt is cleared. A colour marks a debt, so it stays with that debt across the whole chart; past the eighth debt the tail shares one grey and the legend names each."
        empty={activeDebts.length === 0 ? "No active debts to project" : null}
        hideWhenEmpty
        height={340}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={stacked} margin={{ top: 10, right: 16, bottom: 16, left: 0 }}>
            <defs>
              {activeDebts.map((d, i) => (
                <linearGradient key={d.id} id={`payoff-${d.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={catColor(i)} stopOpacity={0.85} />
                  <stop offset="100%" stopColor={catColor(i)} stopOpacity={0.25} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="month" tick={AXIS_TICK} interval="preserveStartEnd" />
            <YAxis tick={AXIS_TICK} tickFormatter={axisMoneyK} width={52} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={LEGEND_STYLE} />
            {activeDebts.map((d, i) => (
              <Area {...ANIM_AREA} key={d.id}
                animationBegin={animBegin(i)}
                type="monotone"
                dataKey={d.name}
                stackId="1"
                stroke={catColor(i)}
                fill={`url(#payoff-${d.id})`}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Snowball waterfall"
          help="As each debt is cleared its minimum is freed and rolls into the next one. Orange is the amount freed by that single payoff; navy is the running total rolling forward."
          empty={waterfall.length === 0 ? "No projected payoffs in this window" : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={waterfall} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="name" tick={AXIS_TICK} angle={-20} textAnchor="end" height={50} />
              <YAxis tick={AXIS_TICK} tickFormatter={axisMoney} width={62} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Legend wrapperStyle={LEGEND_STYLE} />
              <Bar {...ANIM_BAR} animationBegin={animBegin(0)} dataKey="freed" fill={DEBT_SERIES.waterfall.freed} name="Freed this payoff" radius={[4, 4, 0, 0]} />
              <Bar {...ANIM_BAR} animationBegin={animBegin(1)} dataKey="cumulative" fill={DEBT_SERIES.waterfall.cumulative} name="Snowball total" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Interest vs principal"
          help="How each projected monthly payment splits. The interest slice should shrink as the smaller balances die."
          empty={ipBars.length === 0 ? "No projection to draw yet" : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={ipBars} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="month" tick={AXIS_TICK} interval={2} />
              <YAxis tick={AXIS_TICK} tickFormatter={axisMoney} width={62} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Legend wrapperStyle={LEGEND_STYLE} />
              <Bar {...ANIM_BAR} animationBegin={animBegin(0)} dataKey="principal" stackId="1" fill={DEBT_SERIES.split.principal} name="Principal" />
              <Bar {...ANIM_BAR} animationBegin={animBegin(1)} dataKey="interest" stackId="1" fill={DEBT_SERIES.split.interest} name="Interest" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Payoff order + months remaining */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PanelCard
          title="Payoff order"
          help="Projected payoff date for every debt, in the order the current strategy clears them."
        >
          {killed.length === 0 ? (
            <div className={emptyNote}>No projected payoffs yet</div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={cn(th, "w-10 text-right")}>#</th>
                    <th className={th}>Debt</th>
                    <th className={cn(th, "text-right")}>Month</th>
                    <th className={th}>Lands</th>
                  </tr>
                </thead>
                <tbody>
                  {killed.map((k) => (
                    <tr key={`${k.name}-${k.monthIndex}`}>
                      <td className={cn(tdNum, "text-neutral-400")}>{k.rank}</td>
                      <td className={cn(td, "max-w-[200px] truncate font-medium")}>
                        {k.name}
                      </td>
                      <td className={tdNum}>{k.monthIndex}</td>
                      <td className={cn(td, "text-neutral-500")}>{k.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PanelCard>

        <PanelCard
          title="Months remaining"
          help="How long each balance has left on the current plan. A shorter bar is closer to done, so the bar is scaled to the longest remaining debt."
        >
          {progress.length === 0 ? (
            <div className={emptyNote}>No active debts on the books</div>
          ) : (
            <div className="max-h-[320px] space-y-2.5 overflow-y-auto px-4 py-3">
              {progress.map((p) => (
                <div key={p.id}>
                  <div className="mb-1 flex items-baseline justify-between gap-2 text-micro">
                    <span className="truncate font-medium text-neutral-700">
                      {p.name}
                    </span>
                    {/* (C10) `p.balance` is netted now, so the row discloses the
                        netting with the same component and the same words the
                        Debts and Avalanche tables use. */}
                    <span className="flex shrink-0 flex-col items-end">
                      <span className="font-mono tabular-nums text-neutral-500">
                        {p.monthsLeft !== null ? `${p.monthsLeft} mo` : "∞"} ·{" "}
                        {formatCurrency(p.balance)}
                      </span>
                      {debtById.has(p.id) ? (
                        <DebtPendingHint
                          debt={debtById.get(p.id)!}
                          fmt={formatCurrency}
                        />
                      ) : null}
                    </span>
                  </div>
                  <div
                    aria-hidden
                    className="h-1.5 w-full overflow-hidden rounded-full bg-brand-line"
                  >
                    <span
                      className="bar-sweep grow-x block h-full rounded-full"
                      style={{
                        width: `${
                          p.monthsLeft !== null
                            ? Math.max(4, (p.monthsLeft / maxMonthsLeft) * 100)
                            : 100
                        }%`,
                        background: CHART.navy,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </PanelCard>
      </div>

      <p className="text-micro text-neutral-400">
        Projection assumes a total monthly payment of{" "}
        {formatCurrency(totalMin + extraPerMonth)} — {formatCurrency(totalMin)} in
        minimums plus {formatCurrency(extraPerMonth)} extra — on the{" "}
        {strategy === "avalanche"
          ? "avalanche strategy (highest APR first)"
          : "snowball strategy (smallest balance first)"}
        .
      </p>
    </div>
  );
}
