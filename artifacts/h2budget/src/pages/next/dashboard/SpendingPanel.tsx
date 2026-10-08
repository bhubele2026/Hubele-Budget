import { useMemo } from "react";
import { Link } from "wouter";
import { Panel } from "@/components/next";
import { CssBars, CssFillMeter, type CssBarRow } from "@/lib/cssBars";
import { bucketSpendInWindow } from "@/lib/bucketSpend";
import { isSplurge, makeRecurringMatcher, merchantKey, recurringMerchantsFrom } from "@/lib/discretionarySpend";
import { householdToday, monthBounds, weekBounds } from "@/lib/householdDay";
import { formatCurrency } from "@/lib/utils";
import { useBudgetMonthQ, useMoneyPositionQ, useRecurringQ, useSettingsQ, useTxnsQ } from "./queries";
import { dayLabel, Empty, Gate, LinkRow, money, rise } from "./shared";

export const SPEND_WINDOW_LIMIT = 100;
const barMoney = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

function MeterRow({ label, spent, cap, testid }: { label: string; spent: number | null; cap: number | null; testid: string }) {
  const hasCap = cap != null && cap > 0;
  const over = hasCap && spent != null && spent > cap!;
  return (
    <div data-testid={testid}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label font-medium text-brand-ink">{label}</span>
        <span className="font-mono text-label tabular-nums text-neutral-700">
          {spent == null ? "—" : formatCurrency(spent)} <span className="text-neutral-500">of {hasCap ? formatCurrency(cap!) : "—"}</span>
        </span>
      </div>
      <CssFillMeter value={spent ?? 0} ceiling={hasCap ? cap! : 0} className="mt-1" />
      <div className="mt-0.5 text-micro text-neutral-500" data-testid={`${testid}-status`}>
        {!hasCap ? "No limit set" : spent == null ? "—" : over ? `${formatCurrency(spent - cap!)} over` : `${formatCurrency(cap! - spent)} left`}
      </div>
    </div>
  );
}

export default function SpendingPanel() {
  const today = householdToday(new Date());
  const month = monthBounds(today).start;
  const week = weekBounds(today).start;
  const pos = useMoneyPositionQ();
  const budget = useBudgetMonthQ(month);
  const settings = useSettingsQ();
  const recurring = useRecurringQ();
  const txns = useTxnsQ({ from: week < month ? week : month, to: today, limit: SPEND_WINDOW_LIMIT });

  const calc = useMemo(() => {
    const list = txns.data ?? [];
    const names = (recurring.data ?? []).map((r) => r.name);
    const isRecurring = makeRecurringMatcher(names);
    const merchants = recurringMerchantsFrom(list);
    const ym = month.slice(0, 7);
    const bars: CssBarRow[] = list
      .filter((t) => t.occurredOn?.startsWith(ym) && isSplurge(t, isRecurring) && !merchants.has(merchantKey(t.description ?? "")))
      .map((t) => ({ id: t.id, label: t.description || "Uncategorized charge", value: Math.abs(Number(t.amount) || 0), hint: dayLabel(t.occurredOn) ?? undefined }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const monthEnd = today;
    return {
      bars,
      weekly: bucketSpendInWindow(list, "weekly", week, weekBounds(today).end),
      monthly: bucketSpendInWindow(list, "monthly", month, monthEnd),
      unplanned: bucketSpendInWindow(list, "unplanned", month, monthEnd),
      capped: list.length >= SPEND_WINDOW_LIMIT,
    };
  }, [txns.data, recurring.data, month, week, today]);

  const st = settings.data;
  const weeklyCap = st ? Number(st.preferences?.weeklyAllowanceOverrides?.[week] ?? st.weeklyAllowanceAmount) || 0 : null;
  const p = pos.data;
  const wk = p ? { spent: Number(p.spentWeekDiscretionary), cap: p.weekCap == null ? null : Number(p.weekCap) } : null;
  const bud = budget.data?.summary.expenses;

  return (
    <Panel title="Spending" span={4} className={rise(2)} data-testid="dash-spending">
      <Gate q={pos} what="Spending" rows={6}>
        {() => (
          <div className="space-y-4">
            <MeterRow testid="dash-week-meter" label="This week vs limit" spent={wk && Number.isFinite(wk.spent) ? wk.spent : null} cap={wk?.cap ?? null} />
            <MeterRow testid="dash-month-meter" label="This month vs budget"
              spent={bud ? Number(bud.actual) : null} cap={bud ? Number(bud.budget) : null} />
            <div data-testid="dash-allowances">
              <h3 className="text-label font-semibold text-brand-navy">Allowances used</h3>
              {txns.data === undefined ? <p className="text-micro text-neutral-500">Loading allowances…</p> : (
                <dl className="mt-1 grid grid-cols-3 gap-2">
                  {([
                    ["Weekly", calc.weekly, weeklyCap],
                    ["Monthly", calc.monthly, st ? Number(st.monthlyAllowanceAmount) || 0 : null],
                    ["Unplanned", calc.unplanned, st ? Number(st.unplannedAllowanceAmount) || 0 : null],
                  ] as const).map(([name, spent, cap]) => (
                    <div key={name} data-testid={`dash-allow-${name.toLowerCase()}`}>
                      <dt className="text-micro uppercase tracking-wide text-neutral-500">{name}</dt>
                      <dd className="font-mono text-label tabular-nums">{money(spent)}</dd>
                      <dd className="font-mono text-micro tabular-nums text-neutral-500">of {cap ? formatCurrency(cap) : "—"}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            <div data-testid="dash-biggest">
              <h3 className="text-label font-semibold text-brand-navy">Biggest charges this month</h3>
              {calc.bars.length ? (
                <CssBars rows={calc.bars} topN={5} ramp format={barMoney} labelWidth={120} valueWidth={70}
                  ariaLabel="Biggest charges this month, largest first" />
              ) : <Empty>No one-off charges this month.</Empty>}
              {calc.capped ? (
                <p className="mt-1 text-micro text-neutral-500" data-testid="dash-spend-cap">
                  Showing the most recent {SPEND_WINDOW_LIMIT} transactions.
                </p>
              ) : null}
            </div>
            <LinkRow>
              <Link href="/budget" className="text-brand-navy underline">Budget</Link>
              <Link href="/allowances" className="text-brand-navy underline">Allowances</Link>
            </LinkRow>
          </div>
        )}
      </Gate>
    </Panel>
  );
}
