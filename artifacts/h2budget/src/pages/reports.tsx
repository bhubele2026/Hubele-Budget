import { useMemo, type ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import {
  useGetReportsSpendingFacts,
  useListDebts,
  useListDebtBalanceHistory,
  useGetForecast,
} from "@workspace/api-client-react";
import { Sparkline, StackBar, MiniBars, RingStat, MoneyText } from "@/components/viz";
import { dataState } from "@/lib/queryState";
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
  // (#a8 per-page fetch) The hub mounts only what its tiles render: the 30-day
  // spending facts for the mini-visuals plus debts/history/forecast.
  //
  // ⚠️ THE HUB DOES NOT READ TRANSACTIONS. It used to pull up to 2,000 rows and
  // add them up in the browser, which cost a heavy payload on a page that draws
  // five thumbnails — and, worse, produced its OWN definition of "spent": every
  // outflow except the excluded categories, transfers and card payments
  // included. The Spending page one click away answers the same question with
  // `realSpend`, so the two disagreed by whatever moved between accounts that
  // month. `/reports/spending-facts` is that same server-side basis, over the
  // same window, in one aggregate response.
  const today = useMemo(() => new Date(), []);
  const fromDate = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 30);
    return d;
  }, [today]);
  const factsQuery = useGetReportsSpendingFacts({
    from: fmtISO(fromDate),
    to: fmtISO(today),
  });
  const facts = factsQuery.data;
  // ⚠️ NO FACTS, NO CLAIMS. Until the aggregate arrives (or after it failed) a
  // tile says so, rather than "$0.00", "No spend in range" or "No income
  // recorded" standing in for figures it never received.
  const factsFailed = dataState(factsQuery) === "failed";
  const factsNote = factsFailed ? "Couldn't load" : "Loading…";
  const { data: debts } = useListDebts();
  const { data: debtBalanceHistory } = useListDebtBalanceHistory();
  const { data: forecast, isError: forecastError } = useGetForecast({ days: 90 });

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

  // Daily net over the range — a quick cash-flow shape. Every day the window
  // covers is present, quiet days included, so the line is not squeezed.
  const cashSeries = useMemo(
    () => (facts?.dailyNet ?? []).map((d) => d.net),
    [facts],
  );

  // Spend mix — top categories by real spend this range. A colour marks an
  // ITEM, so these come off CAT8 in rank order rather than a sequential ramp.
  const spendMix = useMemo(
    () =>
      (facts?.byCategory ?? []).slice(0, 5).map((c, i) => ({
        label: c.name,
        value: c.total,
        color: catColor(i),
      })),
    [facts],
  );

  // Income vs spend — the budget glance ring. Both sides are the server's
  // filtered figures: money earned against money spent at a merchant, with
  // transfers and debt payments out of both.
  const spent = facts?.realSpend.total ?? 0;
  // (PR7) Real spend is categorized only; say what sits outside it so the tile
  // and the household figure on Command Center reconcile on sight.
  const uncategorizedSpent = facts?.uncategorized?.total ?? 0;
  const income = facts?.realIncome.total ?? 0;
  const hasIncome = income > 0;
  const spendRatio = hasIncome ? spent / income : 0;

  // Spend by weekday — the spending cadence. Seven buckets always, so the
  // Su–Sa labels underneath keep their columns before the data lands.
  const dowSpend = useMemo(() => {
    const byDow = facts?.dayOfWeek ?? [];
    return DOW.map((label, i) => ({
      value: byDow.find((d) => d.dow === i)?.total ?? 0,
      label,
    }));
  }, [facts]);

  const noteClass = "text-micro text-neutral-400";

  return (
    <div className="space-y-4">
      <h1 className="text-display font-semibold text-brand-navy">Reports</h1>

      {/* At-a-glance balance tiles — the household's live vitals */}
      <ReportsBalanceTiles forecast={forecast} forecastError={forecastError} />

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
              <div className={noteClass}>{facts ? "No activity in range" : factsNote}</div>
            )
          }
        />
        <ReportTile
          index={2}
          label="Spending"
          href="/reports/spending"
          value={facts ? <MoneyText countUp amount={spent} /> : "—"}
          sub={
            uncategorizedSpent > 0
              ? `Last 30 days, by category · + ${formatCurrency(uncategorizedSpent)} uncategorized`
              : "Last 30 days, by category"
          }
          visual={
            spendMix.length ? (
              <StackBar segments={spendMix} legendMax={3} />
            ) : (
              <div className={noteClass}>{facts ? "No spend in range" : factsNote}</div>
            )
          }
        />
        <ReportTile
          index={3}
          label="Budget"
          href="/reports/budget"
          value={hasIncome ? `${Math.round(spendRatio * 100)}%` : "—"}
          sub={
            hasIncome
              ? "Of income spent, last 30 days"
              : facts
                ? "No income recorded, last 30 days"
                : factsNote
          }
          visual={
            <div className="flex items-center gap-3">
              <RingStat
                value={spendRatio}
                // Without income there is no ratio: a dash, never "0%".
                centerText={hasIncome ? undefined : "—"}
                size={48}
                color={spendRatio > 1 ? CHART.orangeDeep : CHART.navy}
                centerSub="spent"
              />
              <div className="flex flex-col gap-0.5 text-micro text-neutral-400">
                <span>
                  In{" "}
                  {facts ? (
                    <MoneyText
                      amount={income}
                      className="font-mono tabular-nums text-neutral-700"
                    />
                  ) : (
                    "—"
                  )}
                </span>
                <span>
                  Out{" "}
                  {facts ? (
                    <MoneyText
                      amount={spent}
                      className="font-mono tabular-nums text-neutral-700"
                    />
                  ) : (
                    "—"
                  )}
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
            // While loading, the empty bars keep their seven columns; after a
            // failure they would stay flat for good, so the tile says so.
            factsFailed ? (
              <div className={noteClass}>Couldn't load</div>
            ) : (
              <div>
                <MiniBars data={dowSpend} height={36} accent={CHART.navy} />
                <div className="mt-1 flex justify-between text-micro uppercase tracking-wide text-neutral-400">
                  {DOW.map((day) => (
                    <span key={day}>{day[0]}</span>
                  ))}
                </div>
              </div>
            )
          }
        />
      </div>
    </div>
  );
}
