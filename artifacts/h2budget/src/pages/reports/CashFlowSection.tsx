import { useMemo } from "react";
import type {
  Transaction,
  RecurringItem,
  ForecastBundle,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { TrendingUp, TrendingDown, PiggyBank } from "lucide-react";
import {
  H2_PALETTE,
  CHART_SERIES,
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
  HeroTile,
  SectionHeader,
  ChartCard,
  tooltipMoney,
  tooltipStyle,
} from "./shared";

export function CashFlowSection({
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
    ? { pct: pctDelta(kpis.avgIncome, prevKpis.avgIncome), goodIfUp: true }
    : null;
  const expenseDelta = compareToPrev
    ? { pct: pctDelta(kpis.avgExpense, prevKpis.avgExpense), goodIfUp: false }
    : null;
  const netDelta = compareToPrev
    ? { pct: pctDelta(kpis.avgNet, prevKpis.avgNet), goodIfUp: true }
    : null;
  const savingsDelta = compareToPrev
    ? { pct: pctDelta(kpis.savingsRatePct, prevKpis.savingsRatePct), goodIfUp: true }
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
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Section · Cash Flow"
        title="Money in, money out"
        blurb="The pulse of your accounts — what came in, what left, and what stuck around."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HeroTile
          label="Avg monthly income"
          value={formatCurrency(kpis.avgIncome)}
          tone="good"
          icon={<TrendingUp className="w-4 h-4" />}
          delta={incomeDelta}
        />
        <HeroTile
          label="Avg monthly expense"
          value={formatCurrency(kpis.avgExpense)}
          tone="bad"
          icon={<TrendingDown className="w-4 h-4" />}
          delta={expenseDelta}
        />
        <HeroTile
          label="Avg monthly net"
          value={formatCurrency(kpis.avgNet)}
          tone={kpis.avgNet >= 0 ? "good" : "bad"}
          icon={<PiggyBank className="w-4 h-4" />}
          delta={netDelta}
        />
        <HeroTile
          label="Savings rate"
          value={`${kpis.savingsRatePct.toFixed(1)}%`}
          tone="amber"
          delta={savingsDelta}
        />
      </div>

      <ChartCard
        title="Income vs expense"
        caption={
          compareToPrev
            ? "Solid = current period. Dashed = previous period."
            : "The classic line — income up top, expense below."
        }
        empty={series.length === 0 ? "All clear — no transactions in this window." : null}
        hideWhenEmpty
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={seriesWithPrev} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="income" stroke={H2_PALETTE.primary} strokeWidth={2.5} dot={false} name="Income" />
            <Line type="monotone" dataKey="expense" stroke={H2_PALETTE.red} strokeWidth={2.5} dot={false} name="Expense" />
            {compareToPrev && (
              <Line
                type="monotone"
                dataKey="prevIncome"
                stroke={H2_PALETTE.primary}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.6}
                dot={false}
                name="Income (prev)"
                connectNulls
              />
            )}
            {compareToPrev && (
              <Line
                type="monotone"
                dataKey="prevExpense"
                stroke={H2_PALETTE.red}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.6}
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
        caption={
          compareToPrev
            ? "Bars = current net. Solid line = running net. Dashed = previous-period net."
            : "Bars = net per period. The line = running cumulative net."
        }
        empty={series.length === 0 ? "All clear — no transactions in this window." : null}
        hideWhenEmpty
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={seriesWithPrev} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Bar dataKey="net" name="Net" radius={[4, 4, 0, 0]}>
              {series.map((row, i) => (
                <Cell
                  key={i}
                  fill={row.net >= 0 ? H2_PALETTE.emerald : H2_PALETTE.red}
                />
              ))}
            </Bar>
            <Line type="monotone" dataKey="running" stroke={H2_PALETTE.violet} strokeWidth={2} dot={false} name="Running net" />
            {compareToPrev && (
              <Line
                type="monotone"
                dataKey="prevNet"
                stroke={H2_PALETTE.slate}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.7}
                dot={false}
                name="Net (prev)"
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="rounded-lg">
          <CardContent className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Locked-in monthly burn
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <div className="text-4xl font-serif font-bold tabular-nums">
                {formatCurrency(recurringMonthly.expense)}
              </div>
              <div className="text-xs text-muted-foreground">/mo from recurring bills</div>
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              Recurring income: {formatCurrency(recurringMonthly.income)} · net{" "}
              {formatCurrency(recurringMonthly.income - recurringMonthly.expense)}/mo
            </div>
            <div className="text-[10px] text-muted-foreground italic mt-1">
              From {recurringItems.length} recurring item{recurringItems.length === 1 ? "" : "s"}.
            </div>
          </CardContent>
        </Card>

        <ChartCard
          title="Forecast balance (next 90 days)"
          caption="Projected cash balance from your forecast settings."
          empty={forecastSeries.length === 0 ? "All clear — no forecast data yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={forecastSeries} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <defs>
                <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={H2_PALETTE.violet} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={H2_PALETTE.violet} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Area
                type="monotone"
                dataKey="balance"
                stroke={H2_PALETTE.violet}
                strokeWidth={2}
                fill="url(#forecastGrad)"
                name="Projected balance"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard
          title="Money flow this month"
          caption="Income sources → spending categories → savings/spent."
          empty={flowBars.length === 0 ? "All clear — no transactions yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={flowBars} margin={{ top: 10, right: 16, bottom: 24, left: 0 }} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <YAxis dataKey="stage" type="category" tick={{ fontSize: 11 }} width={80} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              {flowKeys.map((k, i) => (
                <Bar
                  key={k}
                  dataKey={k}
                  stackId="flow"
                  fill={CHART_SERIES[i % CHART_SERIES.length]}
                  name={k}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Rolling 30-day burn rate"
          caption="Average daily spending — the smoothed signal under the noise."
          empty={burn.length === 0 ? "All clear — no spending data yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={burn} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <defs>
                <linearGradient id="burn-gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={H2_PALETTE.amber} stopOpacity={0.7} />
                  <stop offset="100%" stopColor={H2_PALETTE.amber} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" angle={-25} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Area type="monotone" dataKey="avg" stroke={H2_PALETTE.amber} strokeWidth={2} fill="url(#burn-gradient)" name="Avg daily spend" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
