import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import {
  useListTransactions,
  useListCategories,
  useListDebts,
  useListDebtBalanceHistory,
  useGetForecast,
} from "@workspace/api-client-react";
import { Sparkline, StackBar, MiniBars, RingStat, MoneyText } from "@/components/viz";
import { fmtISO } from "@/lib/reportsAnalytics";
import { effectiveDebtBalance } from "@/lib/debtBalance";
// Tokens only — no recharts on the hub. `viz` is plain SVG/CSS, so this whole
// route stays chart-library-free.
import { CHART, catColor } from "@/lib/chartTokens";
import { cardButton, fieldLabel } from "@/ui";
import { ReportsBalanceTiles } from "./reports/reportsShared";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One drill destination. Label above, the figure, then the shape of it. */
function ReportTile({
  label,
  value,
  sub,
  href,
  visual,
  index,
}: {
  label: string;
  value: ReactNode;
  sub: string;
  href: string;
  visual: ReactNode;
  index: number;
}) {
  return (
    <Link
      href={href}
      className={`${cardButton} p-4`}
      style={{ animationDelay: `calc(${index} * var(--stagger))` }}
      data-testid={`report-tile-${href.split("/").pop()}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={fieldLabel}>{label}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-orange" />
      </div>
      <div className="mt-1 font-mono text-title font-semibold tabular-nums text-brand-navy">
        {value}
      </div>
      <div className="mt-0.5 text-micro text-neutral-400">{sub}</div>
      <div className="mt-3">{visual}</div>
    </Link>
  );
}

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

  // Spend mix — top categories by outflow this range. A colour marks an ITEM,
  // so these come off CAT8 in rank order rather than a sequential navy ramp.
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
      .map(([label, value], i) => ({ label, value, color: catColor(i) }));
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

  // Spend by weekday — the spending cadence.
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

  const noteClass = "text-micro text-neutral-400";

  return (
    <div className="space-y-4">
      <h1 className="text-display font-semibold text-brand-navy">Reports</h1>

      {/* At-a-glance balance tiles — the household's live vitals */}
      <ReportsBalanceTiles forecast={forecast} />

      {/* The five drill destinations */}
      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ReportTile
          index={0}
          label="Debt payoff"
          href="/reports/debt"
          value="Balance trend"
          sub="Momentum, next target, payoff date"
          visual={
            debtSeries.length > 1 ? (
              // Total debt is the thing being attacked, so it takes the one
              // deep orange rather than the resting navy.
              <Sparkline
                data={debtSeries}
                variant="area"
                color={CHART.orangeDeep}
                height={36}
              />
            ) : (
              <div className={noteClass}>No history yet</div>
            )
          }
        />
        <ReportTile
          index={1}
          label="Cash flow"
          href="/reports/cashflow"
          value="Daily net"
          sub="What came in against what went out"
          visual={
            cashSeries.length > 1 ? (
              <Sparkline
                data={cashSeries}
                variant="line"
                color={CHART.navy}
                height={36}
              />
            ) : (
              <div className={noteClass}>No activity in range</div>
            )
          }
        />
        <ReportTile
          index={2}
          label="Spending"
          href="/reports/spending"
          value={<MoneyText countUp amount={spent} />}
          sub="Last 30 days, by category"
          visual={
            spendMix.length ? (
              <StackBar segments={spendMix} legendMax={3} />
            ) : (
              <div className={noteClass}>No spend in range</div>
            )
          }
        />
        <ReportTile
          index={3}
          label="Budget"
          href="/reports/budget"
          value={`${Math.round(spendRatio * 100)}%`}
          sub="Of income spent, last 30 days"
          visual={
            <div className="flex items-center gap-3">
              <RingStat
                value={spendRatio}
                size={48}
                color={spendRatio > 1 ? CHART.orangeDeep : CHART.navy}
                centerSub="spent"
              />
              <div className="flex flex-col gap-0.5 text-micro text-neutral-400">
                <span>
                  In{" "}
                  <MoneyText
                    amount={income}
                    className="font-mono tabular-nums text-neutral-700"
                  />
                </span>
                <span>
                  Out{" "}
                  <MoneyText
                    amount={spent}
                    className="font-mono tabular-nums text-neutral-700"
                  />
                </span>
              </div>
            </div>
          }
        />
        <ReportTile
          index={4}
          label="Habits"
          href="/reports/behavior"
          value="Weekday rhythm"
          sub="When you spend, and how often"
          visual={
            <div>
              <MiniBars data={dowSpend} height={36} accent={CHART.navy} />
              <div className="mt-1 flex justify-between text-micro uppercase tracking-wide text-neutral-400">
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
