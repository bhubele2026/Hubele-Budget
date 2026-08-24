import { useMemo } from "react";
import {
  useListTransactions,
  useListCategories,
  useListDebts,
  useListDebtBalanceHistory,
  useGetForecast,
} from "@workspace/api-client-react";
import { DrillCard } from "@/components/drill-card";
import { Sparkline, StackBar, MiniBars, RingStat, MoneyText } from "@/components/viz";
import { fmtISO } from "@/lib/reportsAnalytics";
import { effectiveDebtBalance } from "@/lib/debtBalance";
import { ReportsBalanceTiles } from "./reports/reportsShared";

// Summer chart palette for the spend-mix stack on the index.
const MIX_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-5))",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ReportsPage() {
  // (#a8 per-page fetch) The hub mounts only what its tiles render: a 30-day
  // txn slice for the mini-visuals plus debts/history/forecast. Date-window
  // derivation lifted verbatim from the old shared reports data hook.
  const today = useMemo(() => new Date(), []);
  const fromDate = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 30);
    return d;
  }, [today]);
  const { data: txns } = useListTransactions({
    from: fmtISO(fromDate),
    to: fmtISO(today),
    limit: 2000,
  });
  const { data: categories } = useListCategories();
  const { data: debts } = useListDebts();
  const { data: debtBalanceHistory } = useListDebtBalanceHistory();
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

  // Debt momentum — total debt over time, carrying each debt's last-known
  // balance forward so the curve reads as one declining line.
  const debtSeries = useMemo(() => {
    const hist = debtBalanceHistory ?? [];
    if (hist.length < 2) {
      // (C10) Netted: this flat fallback line stands in for "what you owe
      // now", and it sits directly under the Total Debt tile, which is netted
      // server-side. The recorded-history branch below stays as recorded —
      // past snapshots are creditor-reported and we hold no pending history
      // for past days.
      const total = (debts ?? []).reduce(
        (s, x) => s + effectiveDebtBalance(x),
        0,
      );
      return total > 0 ? [total, total] : [];
    }
    const sorted = [...hist].sort((a, b) => a.recordedOn.localeCompare(b.recordedOn));
    const dates = Array.from(new Set(sorted.map((h) => h.recordedOn)));
    const last = new Map<string, number>();
    const byDate = new Map<string, typeof sorted>();
    for (const h of sorted) {
      const arr = byDate.get(h.recordedOn) ?? [];
      arr.push(h);
      byDate.set(h.recordedOn, arr);
    }
    return dates.map((date) => {
      for (const h of byDate.get(date) ?? []) last.set(h.debtId, Number(h.balance) || 0);
      let sum = 0;
      for (const v of last.values()) sum += v;
      return sum;
    });
  }, [debtBalanceHistory, debts]);

  // Daily net over the range — a quick cash-flow shape.
  const cashSeries = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const t of rangeTxns) {
      byDay.set(t.occurredOn, (byDay.get(t.occurredOn) ?? 0) + (Number(t.amount) || 0));
    }
    return Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v);
  }, [rangeTxns]);

  // Spend mix — top categories by outflow this range.
  const spendMix = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of rangeTxns) {
      const amt = Number(t.amount) || 0;
      if (amt >= 0) continue;
      if (t.categoryId && excludedCategoryIds.has(t.categoryId)) continue;
      const name = (t.categoryId && catNameById.get(t.categoryId)) || "Uncategorized";
      totals.set(name, (totals.get(name) ?? 0) + Math.abs(amt));
    }
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value], i) => ({ label, value, color: MIX_COLORS[i % MIX_COLORS.length] }));
  }, [rangeTxns, catNameById, excludedCategoryIds]);

  // Income vs spend — the budget glance ring.
  const { spent, income } = useMemo(() => {
    let s = 0;
    let inc = 0;
    for (const t of rangeTxns) {
      const amt = Number(t.amount) || 0;
      if (t.categoryId && excludedCategoryIds.has(t.categoryId)) continue;
      if (amt < 0) s += Math.abs(amt);
      else inc += amt;
    }
    return { spent: s, income: inc };
  }, [rangeTxns, excludedCategoryIds]);
  const spendRatio = income > 0 ? spent / income : spent > 0 ? 1 : 0;

  // Spend by weekday — the behavior cadence.
  const dowSpend = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0, 0, 0];
    for (const t of rangeTxns) {
      const amt = Number(t.amount) || 0;
      if (amt >= 0) continue;
      if (t.categoryId && excludedCategoryIds.has(t.categoryId)) continue;
      const dow = new Date(`${t.occurredOn}T00:00:00`).getDay();
      buckets[dow] += Math.abs(amt);
    }
    return buckets.map((value, i) => ({ value, label: DOW[i] }));
  }, [rangeTxns, excludedCategoryIds]);

  return (
    <div className="space-y-6">
      {/* Editorial header */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Insights
        </div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground mt-0.5 leading-tight">
          Reports
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your money, told as a story. Pick a thread and drill in.
        </p>
        <div className="border-t border-border mt-5" />
      </div>

      {/* At-a-glance balance tiles — the household's live vitals */}
      <ReportsBalanceTiles forecast={forecast} />

      {/* The five threads — each drills to its own page */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
        <DrillCard
          eyebrow="Debt Payoff"
          href="/reports/debt"
          value="The avalanche"
          sub="Momentum, next target, freedom date"
          visual={
            debtSeries.length > 1 ? (
              <Sparkline data={debtSeries} variant="area" color="hsl(var(--negative))" height={36} />
            ) : (
              <div className="text-xs text-muted-foreground">No history yet</div>
            )
          }
        />
        <DrillCard
          eyebrow="Cash Flow"
          href="/reports/cashflow"
          value="In vs out"
          sub="The gap, day by day"
          visual={
            cashSeries.length > 1 ? (
              <Sparkline data={cashSeries} variant="line" color="hsl(var(--chart-1))" height={36} />
            ) : (
              <div className="text-xs text-muted-foreground">No activity in range</div>
            )
          }
        />
        <DrillCard
          eyebrow="Spending"
          href="/reports/spending"
          value={<MoneyText countUp amount={spent} />}
          sub="Where it all went"
          visual={
            spendMix.length ? (
              <StackBar segments={spendMix} legendMax={3} />
            ) : (
              <div className="text-xs text-muted-foreground">No spend in range</div>
            )
          }
        />
        <DrillCard
          eyebrow="Budget"
          href="/reports/budget"
          value="Plan vs actual"
          sub={`${Math.round(spendRatio * 100)}% of income spent`}
          visual={
            <div className="flex items-center gap-3">
              <RingStat
                value={spendRatio}
                size={56}
                color={spendRatio > 1 ? "hsl(var(--negative))" : "hsl(var(--primary))"}
                centerSub="spent"
              />
              <div className="text-xs text-muted-foreground leading-snug">
                <div>
                  In <MoneyText amount={income} className="font-medium text-foreground" />
                </div>
                <div>
                  Out <MoneyText amount={spent} className="font-medium text-foreground" />
                </div>
              </div>
            </div>
          }
        />
        <DrillCard
          eyebrow="Behavior & Fun"
          href="/reports/behavior"
          value="The patterns"
          sub="When you spend, and how often"
          visual={
            <div>
              <MiniBars data={dowSpend} height={36} accent="hsl(var(--chart-5))" />
              <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                {DOW.map((day) => (
                  <span key={day}>{day[0]}</span>
                ))}
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}
