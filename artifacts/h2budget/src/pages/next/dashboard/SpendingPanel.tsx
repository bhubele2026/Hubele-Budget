import { Link } from "wouter";
import { Panel } from "@/components/next";
import { CssFillMeter } from "@/lib/cssBars";
import { useSpine } from "@/hooks/useSpine";
import { householdToday, monthBounds } from "@/lib/householdDay";
import { cn, formatCurrency } from "@/lib/utils";
import { useMoneyPositionQ, usePlaidItemsQ } from "./queries";
import { hasLinkedBank } from "./bankState";
import { useBudgetMonthQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { useFoldMinH } from "./foldDensity";
import { Gate, LABEL, LINK, money, rise, weekdayLabel } from "./shared";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function MeterRow({
  title, scope, spent, cap, status, over, marker, testid,
}: {
  title: string;
  scope: string;
  spent: number | null;
  cap: number | null;
  /** The words under the bar ("$120.00 left", "$40.00 over", "No plan set"). */
  status: string;
  over: boolean;
  /** Where spending would be at an even pace by today, as a fraction of the plan. */
  marker: number | null;
  testid: string;
}) {
  const hasCap = cap != null && cap > 0;
  return (
    <div data-testid={testid}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-label font-semibold text-brand-ink">{title}</span>
        <span className="font-mono text-label tabular-nums text-neutral-700">
          {spent == null ? "—" : formatCurrency(spent)} <span className="text-neutral-500">of {hasCap ? formatCurrency(cap!) : "—"}</span>
        </span>
      </div>
      <div className="text-micro text-neutral-500" data-testid={`${testid}-scope`}>{scope}</div>
      <CssFillMeter value={spent ?? 0} ceiling={hasCap ? cap! : 0} marker={marker} className="mt-1.5" />
      <div className={cn("mt-1 text-micro", over ? "font-semibold text-bad-ink" : "text-neutral-600")} data-testid={`${testid}-status`}>
        {status}
      </div>
    </div>
  );
}

/**
 * "Can we control spending?" Two bars, each saying its period and scope:
 * this week's discretionary spending against the weekly plan (the money
 * position — the same `remainingWeek` the summary quotes), and this month's
 * budgeted expenses against the budget, each with an even-pace tick. The
 * allowance breakdown and the biggest one-off charges live on their own pages,
 * one click away.
 */
export default function SpendingPanel() {
  const minH = useFoldMinH("spending");
  const today = householdToday(new Date());
  const mb = monthBounds(today);
  const spine = useSpine().data;
  const pos = useMoneyPositionQ();
  const budget = useBudgetMonthQ(mb.start);
  const items = usePlaidItemsQ();
  const noBank = items.data !== undefined && !hasLinkedBank(items.data);

  const p = pos.data;
  const bud = budget.data?.summary.expenses;
  const monthName = MONTHS[Number(mb.start.slice(5, 7)) - 1] ?? "This month";
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = Number(mb.end.slice(8, 10));

  return (
    <Panel title="Spending pace" span={6} variant="static"
      className={cn(rise(BELOW_FOLD.spending.rise), minH)} data-testid="dash-spending">
      <Gate q={pos} what="Spending" rows={5}>
        {() => noBank ? (
          <div className="space-y-3" data-testid="dash-spending-empty">
            <p className="text-body text-neutral-600">
              Spending is measured from your bank and card rows, and no bank is linked yet.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-label">
              <Link href="/settings" className={LINK}>Link a bank</Link>
              <Link href="/allowances" className={LINK}>Set a weekly plan</Link>
              <Link href="/budget" className={LINK}>Budget</Link>
            </div>
          </div>
        ) : (() => {
          const spent = Number(p!.spentWeekDiscretionary);
          const cap = p!.weekCap == null ? null : Number(p!.weekCap);
          const rem = p!.remainingWeek == null ? null : Number(p!.remainingWeek);
          const pace = p!.paceAllowedToday != null && cap ? Number(p!.paceAllowedToday) / cap : null;
          const bActual = bud ? Number(bud.actual) : null;
          const bBudget = bud ? Number(bud.budget) : null;
          const bLeft = bActual != null && bBudget != null && bBudget > 0 ? bBudget - bActual : null;
          return (
            <div className="space-y-5">
              <MeterRow
                testid="dash-week-meter"
                title="This week vs plan"
                scope={`${weekdayLabel(p!.weekStart)} – ${weekdayLabel(p!.weekEnd)} · discretionary spending`}
                spent={Number.isFinite(spent) ? spent : null}
                cap={cap}
                over={rem != null && rem < 0}
                status={rem == null ? "No weekly plan set" : rem < 0 ? `${money(-rem)} over the plan` : `${money(rem)} left in the plan`}
                marker={pace}
              />
              {budget.data === undefined ? (
                <div data-testid="dash-month-meter" className="text-micro text-neutral-500">
                  {budget.isError ? "This month's budget did not load." : <span className="skeleton block h-10 w-full rounded-control" aria-busy="true" />}
                </div>
              ) : (
                <MeterRow
                  testid="dash-month-meter"
                  title="This month vs budget"
                  scope={`${monthName} 1–${daysInMonth} · budgeted expense categories`}
                  spent={bActual}
                  cap={bBudget}
                  over={bLeft != null && bLeft < 0}
                  status={bLeft == null ? "No budget set" : bLeft < 0 ? `${formatCurrency(-bLeft)} over` : `${formatCurrency(bLeft)} left`}
                  marker={daysInMonth > 0 ? dayOfMonth / daysInMonth : null}
                />
              )}
              {spine ? (
                <p className="text-micro text-neutral-500" data-testid="dash-household-spent">
                  <span className={LABEL}>All household spending</span>{" "}
                  <span className="font-mono tabular-nums text-neutral-700" data-testid="dash-spent-week">{money(spine.spentWeek)}</span> this week
                  {" · "}
                  <span className="font-mono tabular-nums text-neutral-700" data-testid="dash-spent-month">{money(spine.spentMonth)}</span> this month
                </p>
              ) : null}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-label">
                <Link href="/allowances" className={LINK} data-testid="dash-link-allowances">Allowances used</Link>
                <Link href="/banking" className={LINK} data-testid="dash-link-biggest">Biggest charges</Link>
                <Link href="/budget" className={LINK}>Budget</Link>
              </div>
            </div>
          );
        })()}
      </Gate>
    </Panel>
  );
}
