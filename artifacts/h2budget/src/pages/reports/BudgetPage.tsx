import { useMemo, useState } from "react";
import { useGetReportsBudgetFacts } from "@workspace/api-client-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency, cn } from "@/lib/utils";
import { fmtISO } from "@/lib/reportsAnalytics";
import { CHART } from "@/lib/chartTokens";
import { LineTrend } from "@/lib/charts";
import { CssFillMeter } from "@/lib/cssBars";
import {
  card,
  emptyNote,
  fieldLabel,
  th,
  td,
  tdNum,
  Foot,
  Stat,
} from "@/ui";
import { ChartCard, PanelCard, ReportShell } from "./reportsShared";

export default function BudgetPage() {
  const [monthOffset, setMonthOffset] = useState("0");
  // Month-start derivation lifted verbatim from the old shared reports data hook.
  // This page fetches nothing itself — BudgetSection reads server-computed
  // budget facts for the picked month, so no transaction pull happens here.
  const today = useMemo(() => new Date(), []);
  const budgetMonthStart = useMemo(() => {
    const d = new Date(today.getFullYear(), today.getMonth() - Number(monthOffset), 1);
    return fmtISO(d);
  }, [today, monthOffset]);
  return (
    <ReportShell
      crumb="Budget"
      title="Budget"
      controls={
        <div className="flex items-center gap-2">
          <span className={fieldLabel}>Month</span>
          <Select value={monthOffset} onValueChange={setMonthOffset}>
            <SelectTrigger className="h-8 w-40" aria-label="Budget month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">This month</SelectItem>
              <SelectItem value="1">Last month</SelectItem>
              <SelectItem value="2">2 months ago</SelectItem>
              <SelectItem value="3">3 months ago</SelectItem>
            </SelectContent>
          </Select>
        </div>
      }
    >
      <BudgetSection monthStart={budgetMonthStart} />
    </ReportShell>
  );
}

type BudgetStatus = "good" | "watch" | "miss";

/**
 * (#854 Phase 2) Status → colour, on each class's own terms. good = on plan,
 * watch = creeping, miss = over (flex) / unpaid (bills) / not-yet-landed.
 *
 * ⚠️ Three DISTINCT hexes, checked by `reportsPalette.test.ts`. The previous
 * version routed these through the old alias palette's `primary`/`amber`/`red`,
 * where `amber` resolved to #a9bad2 — a pale blue-grey barely separable from
 * the navy it was supposed to contrast with.
 */
export function budgetStatusColor(status: BudgetStatus): string {
  return status === "good"
    ? CHART.navy
    : status === "watch"
      ? CHART.steel
      : CHART.orangeDeep;
}

/** The chip class for a status. The LABEL carries the state; colour follows. */
export function budgetStatusChip(status: BudgetStatus): string {
  return status === "good" ? "ok" : status === "watch" ? "warn" : "bad";
}

function budgetStatusLabel(status: BudgetStatus): string {
  return status === "good" ? "On track" : status === "watch" ? "Watch" : "Over";
}

function BudgetSection({ monthStart }: { monthStart: string }) {
  const { data: facts, isLoading, isError } = useGetReportsBudgetFacts({
    monthStart,
    monthsBack: 6,
  });

  // Stable reference for the burndown so recharts does not restart its draw.
  const burndownData = useMemo(
    () =>
      (facts?.flex.burndown ?? []).map((b) => ({
        day: b.day,
        planned: b.plannedCumulative,
        actual: b.actualCumulative,
      })),
    [facts],
  );
  const burndownLines = useMemo(
    () => [
      { key: "planned", name: "Planned (paced)", color: CHART.mist, dashed: true },
      { key: "actual", name: "Actual", color: CHART.navy },
    ],
    [],
  );

  if (!facts) {
    return (
      <div className={card}>
        <div className={emptyNote}>
          {isLoading
            ? "Loading"
            : isError
              ? "Budget facts unavailable"
              : "No budget set for this month"}
        </div>
      </div>
    );
  }

  const { range, income, bills, debts, flex, streak } = facts;

  // Class-aware roll-ups (the fact payload carries no totals — derive here).
  const sumActual = (ls: { actual: number }[]) =>
    ls.reduce((s, l) => s + l.actual, 0);
  const sumPlanned = (ls: { planned: number }[]) =>
    ls.reduce((s, l) => s + l.planned, 0);

  const incomeActual = sumActual(income.lines);
  const incomePlanned = sumPlanned(income.lines);
  const paychecksLanded = income.paidCount;
  const paychecksExpected = income.lines.filter((l) => l.planned > 0).length;

  const fixedLines = [...bills.lines, ...debts.lines];
  const billsPaid = bills.paidCount + debts.paidCount;
  const billsTotal = bills.totalCount + debts.totalCount;
  const fixedActual = sumActual(fixedLines);
  const fixedPlanned = sumPlanned(fixedLines);

  const paidFixed = fixedLines
    .filter((l) => l.status === "good")
    .sort((a, b) => b.actual - a.actual);
  const expectedFixed = fixedLines
    .filter((l) => l.status !== "good")
    .sort((a, b) => b.planned - a.planned);

  const daysLeft = Math.max(0, range.daysInMonth - range.daysElapsed);

  const nothingSet =
    income.totalCount === 0 && billsTotal === 0 && flex.totalCount === 0;

  if (nothingSet) {
    return (
      <div className={card}>
        <div className={emptyNote}>No budget set for this month</div>
      </div>
    );
  }

  const projectedUnder = flex.projectedVsPlan < 0;
  const overPace = flex.paceStatus === "over";

  return (
    <div className="space-y-4">
      {/* Three separate stories, three tiles. */}
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          index={0}
          label="Money in"
          value={formatCurrency(incomeActual)}
          hint={`${paychecksLanded} of ${paychecksExpected} paychecks landed · ${formatCurrency(incomePlanned)} expected`}
          data-testid="budget-report-income"
        />
        <Stat
          index={1}
          label="Bills & loans paid"
          value={`${billsPaid} of ${billsTotal}`}
          hint={`${formatCurrency(fixedActual)} of ${formatCurrency(fixedPlanned)}`}
          data-testid="budget-report-fixed"
        />
        <Stat
          index={2}
          label="Flex spending"
          value={formatCurrency(flex.actualTotal)}
          hint={`of ${formatCurrency(flex.plannedTotal)} planned · ${daysLeft} days left`}
          tone={overPace ? "bad" : "navy"}
          data-testid="budget-report-flex"
        />
      </div>

      {/* Flex — the part you actually steer week to week. */}
      {flex.lines.length > 0 && (
        <PanelCard
          title="Day-to-day spending"
          help="Flex categories only — bills, loans and income are excluded. Pace-to-date is what the plan says should be gone by today."
          right={
            <span className={`chip ${overPace ? "bad" : "ok"}`}>
              {overPace ? "Over pace" : "On pace"}
            </span>
          }
        >
          <div className="border-b border-brand-line px-4 py-3">
            <CssFillMeter
              value={flex.actualTotal}
              ceiling={flex.plannedTotal}
              title={`${formatCurrency(flex.actualTotal)} of ${formatCurrency(flex.plannedTotal)}`}
            />
            <div className="mt-1.5 flex flex-wrap justify-between gap-2 font-mono text-micro tabular-nums text-neutral-500">
              <span>{formatCurrency(flex.actualTotal)} spent</span>
              <span>pace to date {formatCurrency(flex.pacePlanToDate)}</span>
              <span>{formatCurrency(flex.plannedTotal)} planned</span>
            </div>
          </div>

          {/* The projection sentence, as the two numbers it was carrying. */}
          <div className="grid grid-cols-2 gap-3 border-b border-brand-line px-4 py-3">
            <div>
              <div className={fieldLabel}>Projected month-end</div>
              <div
                className={cn(
                  "mt-0.5 font-mono text-title font-semibold tabular-nums",
                  projectedUnder ? "text-brand-navy" : "text-bad",
                )}
              >
                {formatCurrency(flex.projectedMonthEnd)}
              </div>
            </div>
            <div>
              <div className={fieldLabel}>
                {projectedUnder ? "Under plan" : "Over plan"}
              </div>
              <div
                className={cn(
                  "mt-0.5 font-mono text-title font-semibold tabular-nums",
                  projectedUnder ? "text-brand-navy" : "text-bad",
                )}
              >
                {formatCurrency(Math.abs(flex.projectedVsPlan))}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead>
                <tr>
                  <th className={th}>Category</th>
                  <th className={cn(th, "w-[28%]")}>Progress</th>
                  <th className={cn(th, "text-right")}>Spent</th>
                  <th className={cn(th, "text-right")}>Planned</th>
                  <th className={th}>State</th>
                </tr>
              </thead>
              <tbody>
                {flex.lines.map((l) => (
                  <tr key={l.categoryId} data-testid={`budget-flex-${l.categoryId}`}>
                    <td className={cn(td, "max-w-[220px] truncate font-medium")}>
                      {l.name}
                    </td>
                    <td className={td}>
                      <CssFillMeter value={l.actual} ceiling={l.planned} />
                    </td>
                    <td className={tdNum}>{formatCurrency(l.actual)}</td>
                    <td className={cn(tdNum, "text-neutral-500")}>
                      {l.unbudgeted ? "—" : formatCurrency(l.planned)}
                    </td>
                    <td className={td}>
                      <span className={`chip ${budgetStatusChip(l.status)}`}>
                        {l.unbudgeted ? "No budget" : budgetStatusLabel(l.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelCard>
      )}

      {/* Bills & loans — a checklist, as a table. */}
      {fixedLines.length > 0 && (
        <PanelCard
          title="Bills & loans"
          help="Fixed obligations. A loan at 100% is paid, not over — these are graded on being complete, not on being small."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px]">
              <thead>
                <tr>
                  <th className={th}>Obligation</th>
                  <th className={cn(th, "text-right")}>Paid</th>
                  <th className={cn(th, "text-right")}>Expected</th>
                  <th className={th}>State</th>
                </tr>
              </thead>
              <tbody>
                {paidFixed.map((l) => (
                  <tr key={l.categoryId}>
                    <td className={cn(td, "max-w-[260px] truncate font-medium")}>
                      {l.name}
                    </td>
                    <td className={tdNum}>{formatCurrency(l.actual)}</td>
                    <td className={cn(tdNum, "text-neutral-400")}>—</td>
                    <td className={td}>
                      <span className="chip ok">Paid</span>
                    </td>
                  </tr>
                ))}
                {expectedFixed.map((l) => (
                  <tr key={l.categoryId}>
                    <td className={cn(td, "max-w-[260px] truncate font-medium")}>
                      {l.name}
                    </td>
                    <td className={tdNum}>{formatCurrency(l.actual)}</td>
                    <td className={cn(tdNum, "text-neutral-500")}>
                      {formatCurrency(l.planned)}
                    </td>
                    <td className={td}>
                      <span className="chip warn">Expected</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelCard>
      )}

      {/* Paychecks */}
      {income.lines.length > 0 && (
        <PanelCard
          title="Paychecks"
          help="Money landing this month. Coming in over the estimate is good and is never flagged."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px]">
              <thead>
                <tr>
                  <th className={th}>Source</th>
                  <th className={cn(th, "text-right")}>Landed</th>
                  <th className={cn(th, "text-right")}>Expected</th>
                  <th className={th}>State</th>
                </tr>
              </thead>
              <tbody>
                {income.lines.map((l) => {
                  const isGood = l.status === "good";
                  const label = isGood
                    ? l.actual > l.planned
                      ? "Ahead"
                      : "On track"
                    : "Expected";
                  return (
                    <tr key={l.categoryId}>
                      <td className={cn(td, "max-w-[260px] truncate font-medium")}>
                        {l.name}
                      </td>
                      <td className={tdNum}>{formatCurrency(l.actual)}</td>
                      <td className={cn(tdNum, "text-neutral-500")}>
                        {formatCurrency(l.planned)}
                      </td>
                      <td className={td}>
                        <span className={`chip ${isGood ? "ok" : "warn"}`}>
                          {label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </PanelCard>
      )}

      {/* Pace of the month — flex burndown */}
      {flex.lines.length > 0 && burndownData.length > 0 && (
        <ChartCard
          title="Pace of the month"
          help="Cumulative flex spending against the plan paced evenly across the month. Above the dashed line is ahead of plan."
          height={300}
        >
          <LineTrend
            data={burndownData}
            xKey="day"
            lines={burndownLines}
            height={300}
            labelMode="none"
            ariaLabel="Cumulative flex spending against the paced plan"
          />
        </ChartCard>
      )}

      {/* Six-month streak board */}
      {streak.rows.length > 0 && (
        <PanelCard
          title="Six-month streak board"
          help="Each row graded on its own terms — bills want 100%, flex spending wants less, paychecks want more. Cell shows actual as a percentage of plan."
        >
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[520px]">
              <thead>
                <tr>
                  <th className={th}>Category</th>
                  {streak.monthKeys.map((mk) => (
                    <th key={mk} className={cn(th, "text-center")}>
                      {mk.slice(5)}
                    </th>
                  ))}
                  <th className={cn(th, "text-right")}>Run</th>
                </tr>
              </thead>
              <tbody>
                {streak.rows.map((row) => (
                  <tr key={row.categoryId}>
                    <td className={cn(td, "max-w-[180px] truncate font-medium")}>
                      {row.name}
                    </td>
                    {row.cells.map((c, i) => (
                      <td key={i} className={cn(td, "px-1")}>
                        {c ? (
                          <div
                            className="flex h-6 items-center justify-center rounded font-mono text-micro tabular-nums text-white"
                            style={{ background: budgetStatusColor(c.status) }}
                            title={`${row.name} · ${c.status} · ${c.pct >= 999 ? "no plan" : `${Math.round(c.pct)}%`}`}
                          >
                            {c.pct >= 999 ? "—" : `${Math.round(c.pct)}%`}
                          </div>
                        ) : (
                          <div className="h-6 rounded bg-brand-line/60" />
                        )}
                      </td>
                    ))}
                    <td className={tdNum}>{row.currentStreakGood}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Foot>
            A cell is navy on plan, grey when creeping and deep orange when
            missed; the hover text names the state so the colour is never the
            only signal. "Run" counts consecutive good months to date.
          </Foot>
        </PanelCard>
      )}
    </div>
  );
}
