import { useMemo, useState } from "react";
import {
  useListTransactions,
  useListCategories,
  useListRecurringItems,
  useGetForecast,
  type Transaction,
  type RecurringItem,
  type ForecastBundle,
} from "@workspace/api-client-react";
import { PageSkeleton } from "@/components/page-skeleton";
import { formatCurrency } from "@/lib/utils";
import { type RangeMode } from "@/lib/timeRange";
import {
  ANIM_AREA,
  ANIM_BAR,
  ANIM_LINE,
  CHART,
  animBegin,
  barColorForSign,
  catColor,
} from "@/lib/chartTokens";
import { fieldLabel, Foot, Stat } from "@/ui";
import {
  fmtISO,
  dailyCashFlow,
  rollupByPeriod,
  withRunningNet,
  rolling30DayBurn,
  cashFlowKpis,
} from "@/lib/reportsAnalytics";
import {
  ResponsiveContainer,
  LineChart,
  AreaChart,
  BarChart,
  ComposedChart,
  CartesianGrid,
  Cell,
  Line,
  Area,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
  AXIS_TICK,
  GRID_STROKE,
  LEGEND_STYLE,
  ChartCard,
  PanelCard,
  axisMoney,
  tooltipMoney,
  tooltipStyle,
  ReportShell,
  ReportsRangeControls,
  daysForMode,
} from "./reportsShared";

/**
 * ── SERIES COLOURS, AUDITED PER CHART ──────────────────────────────────────
 * Grouped by the chart that draws them, because that is the scope a collision
 * actually matters in: two series in the SAME plot must never resolve to one
 * hex. Across different plots, reusing a colour for the same ROLE is the point
 * — "previous period is mist" reads as one convention rather than two.
 * `reportsPalette.test.ts` audits each group for duplicates.
 *
 * The previous version routed all of this through the old alias palette,
 * where `primary` and `emerald` were both #19315b (two series, one pixel) and
 * `navy` was #c4d0e2 — so "Running net" drew in the palest grey on the ramp,
 * all but invisible on a white card.
 *
 * Current period takes the strong colours; the comparison period takes the
 * quiet steel/mist steps and never the same hue as its current counterpart,
 * so the two periods never depend on the dash pattern alone.
 */
export const CASHFLOW_SERIES = {
  /** Income vs expense, with the optional previous-period overlay. */
  inOut: {
    income: CHART.navy, //        #19315b
    expense: CHART.orangeDeep, // #e16d3e
    prevIncome: CHART.mist, //    #8fa3bf
    prevExpense: CHART.steel, //  #4d5d73
  },
  /** Net bars (coloured by sign) + the running and previous-period lines. */
  net: {
    positive: CHART.navy, //      #19315b  (via barColorForSign)
    negative: CHART.orangeDeep, //#e16d3e  (via barColorForSign)
    running: CHART.mid, //        #3b5c8f
    prevNet: CHART.mist, //       #8fa3bf
  },
  /** Single-series charts — nothing to collide with. */
  forecast: CHART.navy,
  burn: CHART.orange,
} as const;
const SERIES = {
  ...CASHFLOW_SERIES.inOut,
  ...CASHFLOW_SERIES.net,
  forecast: CASHFLOW_SERIES.forecast,
  burn: CASHFLOW_SERIES.burn,
};

export default function CashFlowPage() {
  // Weekly-first: opens on the current week; Mo/Yr are opt-in.
  const [mode, setMode] = useState<RangeMode>("wk");
  const [compareToPrev, setCompareToPrev] = useState(false);
  const rangeDays = daysForMode(mode);

  // Date-window derivation lifted verbatim from the old shared reports data hook.
  const today = useMemo(() => new Date(), []);
  const fromDate = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - rangeDays);
    return d;
  }, [today, rangeDays]);
  const prevFromDate = useMemo(() => {
    const d = new Date(fromDate);
    d.setDate(d.getDate() - rangeDays);
    return d;
  }, [fromDate, rangeDays]);
  // (#a8 per-page fetch) Exactly the compare window [prevFrom, today] — the old
  // shared hook over-fetched a 95-day floor for every sub-page. The 365-day cap
  // mirrors the old fetch ceiling, so the Yr view's previous-period series stays
  // empty exactly as it was before (rangeTxns/prevRangeTxns are byte-identical).
  const fetchFromDate = useMemo(() => {
    const span = Math.min(rangeDays * 2, 365);
    const d = new Date(today);
    d.setDate(d.getDate() - span);
    return d;
  }, [today, rangeDays]);

  const { data: txns, isLoading: txnsLoading } = useListTransactions({
    from: fmtISO(fetchFromDate),
    to: fmtISO(today),
    limit: 2000,
  });
  const { data: categories } = useListCategories();
  const { data: recurringItems } = useListRecurringItems();
  const { data: forecast } = useGetForecast({ days: 90 });

  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const excludedCategoryIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of categories ?? []) {
      if (c.excludeFromBudget) s.add(c.id);
    }
    return s;
  }, [categories]);

  const rangeTxns = useMemo(() => {
    if (!txns) return [];
    const fromIso = fmtISO(fromDate);
    return txns.filter((t) => t.occurredOn >= fromIso);
  }, [txns, fromDate]);
  const prevRangeTxns = useMemo(() => {
    if (!txns) return [];
    const prevFromIso = fmtISO(prevFromDate);
    const fromIso = fmtISO(fromDate);
    return txns.filter((t) => t.occurredOn >= prevFromIso && t.occurredOn < fromIso);
  }, [txns, prevFromDate, fromDate]);

  if (txnsLoading) return <PageSkeleton />;
  return (
    <ReportShell
      crumb="Cash flow"
      title="Cash flow"
      controls={
        <ReportsRangeControls
          mode={mode}
          setMode={setMode}
          compareToPrev={compareToPrev}
          setCompareToPrev={setCompareToPrev}
        />
      }
    >
      <CashFlowSection
        txns={rangeTxns}
        prevTxns={prevRangeTxns}
        rangeDays={rangeDays}
        compareToPrev={compareToPrev}
        catNameById={catNameById}
        excludedCategoryIds={excludedCategoryIds}
        recurringItems={recurringItems ?? []}
        forecast={forecast ?? null}
      />
    </ReportShell>
  );
}

/** "+12.3% vs prev" / "−4.0% vs prev", or nothing when compare is off. */
function deltaHint(pct: number | undefined | null): string | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  const sign = pct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(pct).toFixed(1)}% vs prev`;
}

function CashFlowSection({
  txns,
  prevTxns,
  rangeDays,
  compareToPrev,
  catNameById,
  excludedCategoryIds,
  recurringItems,
  forecast,
}: {
  txns: Transaction[];
  prevTxns: Transaction[];
  rangeDays: number;
  compareToPrev: boolean;
  catNameById: Map<string, string>;
  excludedCategoryIds: ReadonlySet<string>;
  recurringItems: RecurringItem[];
  forecast: ForecastBundle | null;
}) {
  const period: "day" | "week" | "month" =
    rangeDays <= 60 ? "day" : rangeDays <= 180 ? "week" : "month";

  const dailyCurr = useMemo(
    () => dailyCashFlow(txns, excludedCategoryIds),
    [txns, excludedCategoryIds],
  );
  const series = useMemo(
    () => withRunningNet(rollupByPeriod(dailyCurr, period)),
    [dailyCurr, period],
  );
  const prevSeries = useMemo(
    () => rollupByPeriod(dailyCashFlow(prevTxns, excludedCategoryIds), period),
    [prevTxns, period, excludedCategoryIds],
  );
  // Merge previous-period series alongside current so charts can show overlay.
  const seriesWithPrev = useMemo(() => {
    return series.map((row, i) => ({
      ...row,
      prevIncome: prevSeries[i]?.income ?? null,
      prevExpense: prevSeries[i]?.expense ?? null,
      prevNet: prevSeries[i]?.net ?? null,
    }));
  }, [series, prevSeries]);

  // Recurring monthly burn — sum of all recurring item monthly-equivalent amounts.
  // Uses real schema fields: `frequency` for cadence, `kind` to split bill vs income.
  const recurringMonthly = useMemo(() => {
    const freqMul: Record<string, number> = {
      weekly: 4.345,
      biweekly: 2.1725,
      "bi-weekly": 2.1725,
      semimonthly: 2,
      "semi-monthly": 2,
      monthly: 1,
      quarterly: 1 / 3,
      semiannual: 1 / 6,
      semiannually: 1 / 6,
      yearly: 1 / 12,
      annually: 1 / 12,
      annual: 1 / 12,
    };
    let income = 0;
    let expense = 0;
    for (const r of recurringItems) {
      if (r.active && r.active !== "true" && r.active !== "1") continue;
      const amt = Math.abs(Number(r.amount) || 0);
      const mul = freqMul[String(r.frequency ?? "monthly").toLowerCase()] ?? 1;
      const monthly = amt * mul;
      const isIncome = String(r.kind ?? "").toLowerCase() === "income";
      if (isIncome) income += monthly;
      else expense += monthly;
    }
    return { income, expense };
  }, [recurringItems]);

  // Build a 90-day projected balance from forecast events + starting balance.
  const forecastSeries = useMemo(() => {
    if (!forecast) return [];
    const startBal = Number(forecast.settings?.startingBalance ?? 0) || 0;
    const sorted = [...(forecast.events ?? [])].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
    let bal = startBal;
    const byDate = new Map<string, number>();
    for (const e of sorted) {
      bal += Number(e.amount) || 0;
      byDate.set(e.date, bal);
    }
    if (byDate.size === 0) return [];
    return Array.from(byDate.entries()).map(([date, balance]) => ({
      date,
      balance: Math.round(balance * 100) / 100,
    }));
  }, [forecast]);
  const burn = useMemo(() => rolling30DayBurn(dailyCurr), [dailyCurr]);
  const kpis = useMemo(() => cashFlowKpis(dailyCurr), [dailyCurr]);
  const prevKpis = useMemo(
    () => cashFlowKpis(dailyCashFlow(prevTxns, excludedCategoryIds)),
    [prevTxns, excludedCategoryIds],
  );
  const pctDelta = (curr: number, prev: number) =>
    prev === 0 ? Number.NaN : ((curr - prev) / Math.abs(prev)) * 100;
  const incomeDelta = compareToPrev
    ? pctDelta(kpis.avgIncome, prevKpis.avgIncome)
    : null;
  const expenseDelta = compareToPrev
    ? pctDelta(kpis.avgExpense, prevKpis.avgExpense)
    : null;
  const netDelta = compareToPrev ? pctDelta(kpis.avgNet, prevKpis.avgNet) : null;
  const savingsDelta = compareToPrev
    ? pctDelta(kpis.savingsRatePct, prevKpis.savingsRatePct)
    : null;

  // Income source vs spending category breakdown for the most recent month.
  const flowMonth = useMemo(() => {
    if (series.length === 0) return null;
    const last = series[series.length - 1];
    return last.date.slice(0, 7);
  }, [series]);
  const flowBars = useMemo(() => {
    if (!flowMonth) return [];
    const incomeByDesc = new Map<string, number>();
    const expenseByCat = new Map<string, number>();
    for (const t of txns) {
      if (!t.occurredOn.startsWith(flowMonth)) continue;
      const a = Number(t.amount) || 0;
      if (a > 0) {
        const k = t.description?.split(" ")[0] ?? "Income";
        incomeByDesc.set(k, (incomeByDesc.get(k) ?? 0) + a);
      } else if (a < 0) {
        const k = t.categoryId
          ? catNameById.get(t.categoryId) ?? "Uncategorized"
          : "Uncategorized";
        expenseByCat.set(k, (expenseByCat.get(k) ?? 0) + -a);
      }
    }
    const incomeTotal = Array.from(incomeByDesc.values()).reduce((s, v) => s + v, 0);
    const expenseTotal = Array.from(expenseByCat.values()).reduce((s, v) => s + v, 0);
    const savings = Math.max(0, incomeTotal - expenseTotal);
    const topExpense = Array.from(expenseByCat.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    return [
      { stage: "Income", ...Object.fromEntries(incomeByDesc) },
      {
        stage: "Spending",
        ...Object.fromEntries(topExpense),
      },
      { stage: "Outcome", Savings: savings, Spent: expenseTotal },
    ];
  }, [flowMonth, txns, catNameById]);

  const flowKeys = useMemo(() => {
    const set = new Set<string>();
    for (const row of flowBars) {
      for (const k of Object.keys(row)) if (k !== "stage") set.add(k);
    }
    return Array.from(set);
  }, [flowBars]);

  return (
    <div className="space-y-4">
      {/* The period's averages. Deltas ride in the hint as words, not as a
          coloured arrow the reader has to decode. */}
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          index={0}
          label="Savings rate"
          value={`${kpis.savingsRatePct.toFixed(0)}%`}
          hint={deltaHint(savingsDelta) ?? "of income kept"}
          tone={kpis.savingsRatePct < 0 ? "bad" : "navy"}
          data-testid="cashflow-savings-rate"
        />
        <Stat
          index={1}
          label="Income · monthly avg"
          value={formatCurrency(kpis.avgIncome)}
          hint={deltaHint(incomeDelta) ?? "average per month"}
          data-testid="cashflow-avg-income"
        />
        <Stat
          index={2}
          label="Expense · monthly avg"
          value={formatCurrency(kpis.avgExpense)}
          hint={deltaHint(expenseDelta) ?? "average per month"}
          data-testid="cashflow-avg-expense"
        />
        <Stat
          index={3}
          label="Net · monthly avg"
          value={formatCurrency(kpis.avgNet)}
          hint={deltaHint(netDelta) ?? "income less expense"}
          tone={kpis.avgNet < 0 ? "bad" : "navy"}
          data-testid="cashflow-avg-net"
        />
      </div>

      <ChartCard
        title="Income vs expense"
        help={
          compareToPrev
            ? "Solid is the current period, dashed is the previous one. The two periods use different colours, so they never rely on the dash alone."
            : "Money in against money out, per period in this window."
        }
        empty={series.length === 0 ? "No transactions in this window" : null}
        hideWhenEmpty
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={seriesWithPrev} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="date" tick={AXIS_TICK} angle={-25} textAnchor="end" height={50} />
            <YAxis tick={AXIS_TICK} tickFormatter={axisMoney} width={62} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={LEGEND_STYLE} />
            <Line {...ANIM_LINE} animationBegin={animBegin(0)} type="monotone" dataKey="income" stroke={SERIES.income} strokeWidth={2.5} dot={false} name="Income" />
            <Line {...ANIM_LINE} animationBegin={animBegin(1)} type="monotone" dataKey="expense" stroke={SERIES.expense} strokeWidth={2.5} dot={false} name="Expense" />
            {compareToPrev && (
              <Line {...ANIM_LINE} animationBegin={animBegin(2)} type="monotone"
                dataKey="prevIncome"
                stroke={SERIES.prevIncome}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                name="Income (prev)"
                connectNulls
              />
            )}
            {compareToPrev && (
              <Line {...ANIM_LINE} animationBegin={animBegin(3)} type="monotone"
                dataKey="prevExpense"
                stroke={SERIES.prevExpense}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                name="Expense (prev)"
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Net cash flow"
        help="Bars are the net for each period — navy above the line, deep orange below. The line is the running cumulative net."
        empty={series.length === 0 ? "No transactions in this window" : null}
        hideWhenEmpty
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={seriesWithPrev} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="date" tick={AXIS_TICK} angle={-25} textAnchor="end" height={50} />
            <YAxis tick={AXIS_TICK} tickFormatter={axisMoney} width={62} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={LEGEND_STYLE} />
            <ReferenceLine y={0} stroke={GRID_STROKE} />
            {/* `fill` is what the LEGEND swatch reads; the per-point `Cell`s
                below still colour each bar by sign. Without it recharts draws
                a black swatch for this series. */}
            <Bar
              {...ANIM_BAR}
              animationBegin={animBegin(0)}
              dataKey="net"
              name="Net"
              fill={SERIES.positive}
              radius={[4, 4, 0, 0]}
            >
              {series.map((row, i) => (
                <Cell key={i} fill={barColorForSign(row.net)} />
              ))}
            </Bar>
            <Line {...ANIM_LINE} animationBegin={animBegin(1)} type="monotone" dataKey="running" stroke={SERIES.running} strokeWidth={2} dot={false} name="Running net" />
            {compareToPrev && (
              <Line {...ANIM_LINE} animationBegin={animBegin(2)} type="monotone"
                dataKey="prevNet"
                stroke={SERIES.prevNet}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                name="Net (prev)"
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <PanelCard
          title="Locked-in monthly burn"
          help="The monthly-equivalent total of every active recurring item, before any discretionary spending."
        >
          <div className="px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-display font-semibold tabular-nums text-brand-navy">
                {formatCurrency(recurringMonthly.expense)}
              </span>
              <span className="text-micro text-neutral-400">/mo of bills</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <dt className={fieldLabel}>Recurring income</dt>
                <dd className="font-mono text-label tabular-nums text-neutral-700">
                  {formatCurrency(recurringMonthly.income)}
                </dd>
              </div>
              <div>
                <dt className={fieldLabel}>Net per month</dt>
                <dd className="font-mono text-label tabular-nums text-neutral-700">
                  {formatCurrency(recurringMonthly.income - recurringMonthly.expense)}
                </dd>
              </div>
            </dl>
          </div>
          <Foot>
            From {recurringItems.length} recurring item
            {recurringItems.length === 1 ? "" : "s"}.
          </Foot>
        </PanelCard>

        <ChartCard
          title="Forecast balance · next 90 days"
          help="Projected checking balance from the forecast's starting balance and its scheduled events."
          empty={forecastSeries.length === 0 ? "No forecast data yet" : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={forecastSeries} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <defs>
                <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SERIES.forecast} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={SERIES.forecast} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={AXIS_TICK} angle={-25} textAnchor="end" height={50} />
              <YAxis tick={AXIS_TICK} tickFormatter={axisMoney} width={62} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <ReferenceLine y={0} stroke={GRID_STROKE} />
              <Area {...ANIM_AREA} animationBegin={animBegin(0)} type="monotone"
                dataKey="balance"
                stroke={SERIES.forecast}
                strokeWidth={2}
                fill="url(#forecastGrad)"
                name="Projected balance"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Money flow this month"
          help="Income sources, then where it went, then what survived. Each segment is named on hover — there are more segments than the eight-colour set, so colour separates them but never identifies them on its own."
          empty={flowBars.length === 0 ? "No transactions yet" : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={flowBars} margin={{ top: 10, right: 16, bottom: 24, left: 0 }} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
              <XAxis type="number" tick={AXIS_TICK} tickFormatter={axisMoney} />
              <YAxis dataKey="stage" type="category" tick={AXIS_TICK} width={80} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              {flowKeys.map((k, i) => (
                <Bar {...ANIM_BAR} key={k}
                  animationBegin={animBegin(i)}
                  dataKey={k}
                  stackId="flow"
                  fill={catColor(i)}
                  name={k}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Rolling 30-day burn rate"
          help="Average daily spending over a trailing 30-day window — the smoothed signal under the day-to-day noise."
          empty={burn.length === 0 ? "No spending data yet" : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={burn} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <defs>
                <linearGradient id="burn-gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SERIES.burn} stopOpacity={0.7} />
                  <stop offset="100%" stopColor={SERIES.burn} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={AXIS_TICK} interval="preserveStartEnd" angle={-25} textAnchor="end" height={50} />
              <YAxis tick={AXIS_TICK} tickFormatter={axisMoney} width={62} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Area {...ANIM_AREA} animationBegin={animBegin(0)} type="monotone" dataKey="avg" stroke={SERIES.burn} strokeWidth={2} fill="url(#burn-gradient)" name="Avg daily spend" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
