import { useMemo } from "react";
import { AiInsightBar } from "@/components/ai-insight-bar";
import { DrillCard } from "@/components/drill-card";
import { Sparkline, StackBar, MiniBars, RingStat, MoneyText } from "@/components/viz";
import { useReportsData, ReportsBalanceTiles } from "./reports/reportsShared";

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
  // The index pulls a 30-day slice for its mini-visuals; React Query dedupes
  // these with the sub-pages so drilling in costs no extra fetch.
  const d = useReportsData(30, 0);

  // Debt momentum — total debt over time, carrying each debt's last-known
  // balance forward so the curve reads as one declining line.
  const debtSeries = useMemo(() => {
    const hist = d.debtBalanceHistory ?? [];
    if (hist.length < 2) {
      const total = (d.debts ?? []).reduce((s, x) => s + (Number(x.balance) || 0), 0);
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
  }, [d.debtBalanceHistory, d.debts]);

  // Daily net over the range — a quick cash-flow shape.
  const cashSeries = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const t of d.rangeTxns) {
      byDay.set(t.occurredOn, (byDay.get(t.occurredOn) ?? 0) + (Number(t.amount) || 0));
    }
    return Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v);
  }, [d.rangeTxns]);

  // Spend mix — top categories by outflow this range.
  const spendMix = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of d.rangeTxns) {
      const amt = Number(t.amount) || 0;
      if (amt >= 0) continue;
      if (t.categoryId && d.excludedCategoryIds.has(t.categoryId)) continue;
      const name = (t.categoryId && d.catNameById.get(t.categoryId)) || "Uncategorized";
      totals.set(name, (totals.get(name) ?? 0) + Math.abs(amt));
    }
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value], i) => ({ label, value, color: MIX_COLORS[i % MIX_COLORS.length] }));
  }, [d.rangeTxns, d.catNameById, d.excludedCategoryIds]);

  // Income vs spend — the budget glance ring.
  const { spent, income } = useMemo(() => {
    let s = 0;
    let inc = 0;
    for (const t of d.rangeTxns) {
      const amt = Number(t.amount) || 0;
      if (t.categoryId && d.excludedCategoryIds.has(t.categoryId)) continue;
      if (amt < 0) s += Math.abs(amt);
      else inc += amt;
    }
    return { spent: s, income: inc };
  }, [d.rangeTxns, d.excludedCategoryIds]);
  const spendRatio = income > 0 ? spent / income : spent > 0 ? 1 : 0;

  // Spend by weekday — the behavior cadence.
  const dowSpend = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0, 0, 0];
    for (const t of d.rangeTxns) {
      const amt = Number(t.amount) || 0;
      if (amt >= 0) continue;
      if (t.categoryId && d.excludedCategoryIds.has(t.categoryId)) continue;
      const dow = new Date(`${t.occurredOn}T00:00:00`).getDay();
      buckets[dow] += Math.abs(amt);
    }
    return buckets.map((value, i) => ({ value, label: DOW[i] }));
  }, [d.rangeTxns, d.excludedCategoryIds]);

  return (
    <div className="space-y-6">
      {/* Editorial header */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Section V
        </div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground mt-0.5 leading-tight">
          Reports
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your money, told as a story. Pick a thread and drill in.
        </p>
        <div className="border-t border-border mt-5" />
      </div>

      <AiInsightBar />

      {/* At-a-glance balance tiles — the household's live vitals */}
      <ReportsBalanceTiles forecast={d.forecast} />

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
          value={<MoneyText amount={spent} />}
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
