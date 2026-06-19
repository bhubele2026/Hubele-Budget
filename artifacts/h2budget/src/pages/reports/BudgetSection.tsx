import {
  useGetReportsBudgetFacts,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import { TrendingUp, TrendingDown, Flame, Check, Clock } from "lucide-react";
import { H2_PALETTE } from "@/lib/reportsAnalytics";
import {
  ResponsiveContainer,
  LineChart,
  CartesianGrid,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  SectionHeader,
  ChartCard,
  HeroTile,
  tooltipMoney,
  tooltipStyle,
} from "./shared";

// (#854 Phase 2) Status → color, on each class's own terms. good = on plan,
// watch = creeping, miss = over (flex) / unpaid (bills) / not-yet-landed.
function budgetStatusColor(status: "good" | "watch" | "miss"): string {
  return status === "good"
    ? H2_PALETTE.primary
    : status === "watch"
      ? H2_PALETTE.amber
      : H2_PALETTE.red;
}

function BudgetStatusChip({
  status,
}: {
  status: "good" | "watch" | "miss";
}) {
  const label =
    status === "good" ? "on track" : status === "watch" ? "watch" : "over";
  const color = budgetStatusColor(status);
  return (
    <span
      className="text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full shrink-0"
      style={{ color, background: `${color}1f` }}
    >
      {label}
    </span>
  );
}

export function BudgetSection({
  monthStart,
  monthOffset,
  setMonthOffset,
}: {
  monthStart: string;
  monthOffset: string;
  setMonthOffset: (s: string) => void;
}) {
  const { data: facts, isLoading, isError } = useGetReportsBudgetFacts({
    monthStart,
    monthsBack: 6,
  });

  const header = (
    <>
      <SectionHeader
        eyebrow="Section · Budget"
        title="Plan vs. reality"
        blurb="The plan said one thing. Real life always says another."
      />
      <div className="flex items-center gap-3">
        <Label className="text-xs uppercase tracking-widest text-muted-foreground">
          Month
        </Label>
        <Select value={monthOffset} onValueChange={setMonthOffset}>
          <SelectTrigger className="w-44 h-9" aria-label="Budget month">
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
    </>
  );

  if (!facts) {
    const message = isLoading
      ? "Reading your budget…"
      : isError
        ? "We couldn't load your budget just now — give it a moment and try again."
        : "All clear — no budget set for this month.";
    return (
      <div className="space-y-6">
        {header}
        <Card className="rounded-lg">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {message}
          </CardContent>
        </Card>
      </div>
    );
  }

  const { range, income, bills, debts, flex, streak } = facts;

  // Class-aware roll-ups (BudgetClassSection carries no totals — derive here).
  const sumActual = (ls: { actual: number }[]) =>
    ls.reduce((s, l) => s + l.actual, 0);
  const sumPlanned = (ls: { planned: number }[]) =>
    ls.reduce((s, l) => s + l.planned, 0);

  const incomeActual = sumActual(income.lines);
  const incomePlanned = sumPlanned(income.lines);
  const incomeProgressPct =
    incomePlanned > 0 ? Math.round((incomeActual / incomePlanned) * 100) : 0;
  const paychecksLanded = income.paidCount;
  const paychecksExpected = income.lines.filter((l) => l.planned > 0).length;

  const fixedLines = [...bills.lines, ...debts.lines];
  const billsPaid = bills.paidCount + debts.paidCount;
  const billsTotal = bills.totalCount + debts.totalCount;
  const fixedActual = sumActual(fixedLines);
  const fixedPlanned = sumPlanned(fixedLines);
  const anyFixedMiss = fixedLines.some((l) => l.status === "miss");

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
      <div className="space-y-6">
        {header}
        <Card className="rounded-lg">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            All clear — no budget set for this month.
          </CardContent>
        </Card>
      </div>
    );
  }

  // Pace bar geometry (plannedTotal = 100% of the track).
  const paceFillPct =
    flex.plannedTotal > 0
      ? Math.min(100, (flex.actualTotal / flex.plannedTotal) * 100)
      : flex.actualTotal > 0
        ? 100
        : 0;
  const paceMarkerPct =
    flex.plannedTotal > 0
      ? Math.min(100, (flex.pacePlanToDate / flex.plannedTotal) * 100)
      : 0;
  const paceColor =
    flex.paceStatus === "over" ? H2_PALETTE.red : H2_PALETTE.primary;
  const projectedUnder = flex.projectedVsPlan < 0;

  const burndownData = flex.burndown.map((b) => ({
    day: b.day,
    planned: b.plannedCumulative,
    actual: b.actualCumulative,
  }));

  return (
    <div className="space-y-6">
      {header}

      {/* Top tiles — three separate stories */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <HeroTile
          label="Money in"
          value={formatCurrency(incomeActual)}
          sub={`${paychecksLanded} of ${paychecksExpected} paychecks landed · ~${formatCurrency(incomePlanned)} expected`}
          tone={incomeProgressPct >= 95 ? "good" : "amber"}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <HeroTile
          label="Bills & loans"
          value={`${billsPaid} of ${billsTotal}`}
          sub={`${formatCurrency(fixedActual)} of ${formatCurrency(fixedPlanned)}`}
          tone={anyFixedMiss ? "amber" : "good"}
          icon={<Check className="h-4 w-4" />}
        />
        <HeroTile
          label="Flex spending"
          value={formatCurrency(flex.actualTotal)}
          sub={`of ${formatCurrency(flex.plannedTotal)} planned · ${daysLeft} days left`}
          tone={flex.paceStatus === "over" ? "bad" : "good"}
          icon={
            flex.paceStatus === "over" ? (
              <TrendingUp className="h-4 w-4" />
            ) : (
              <TrendingDown className="h-4 w-4" />
            )
          }
        />
      </div>

      {/* Flex — how it's going (centerpiece) */}
      {flex.lines.length > 0 && (
        <Card className="rounded-lg">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-serif">Day-to-day spending</CardTitle>
            <p className="text-xs text-muted-foreground">
              Flex categories only — the part you actually steer week to week.
            </p>
          </CardHeader>
          <CardContent>
            <div className="space-y-5">
            {/* Pace bar */}
            <div>
              <div className="relative h-4 rounded-full bg-muted/50 overflow-visible">
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${paceFillPct}%`, background: paceColor }}
                />
                <div
                  className="absolute -top-1 -bottom-1 w-0.5 bg-foreground/70"
                  style={{ left: `${paceMarkerPct}%` }}
                  title="Today's pace"
                />
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground mt-1 tabular-nums">
                <span>{formatCurrency(flex.actualTotal)} spent</span>
                <span>{formatCurrency(flex.plannedTotal)} planned</span>
              </div>
            </div>

            {/* Narrative */}
            <div
              className="flex items-center gap-2 text-sm font-medium"
              style={{ color: projectedUnder ? H2_PALETTE.primary : H2_PALETTE.red }}
            >
              {projectedUnder ? (
                <TrendingDown className="h-4 w-4 shrink-0" />
              ) : (
                <TrendingUp className="h-4 w-4 shrink-0" />
              )}
              <span>
                At today's pace, {range.monthLabel} lands near {formatCurrency(flex.projectedMonthEnd)} — about {formatCurrency(Math.abs(flex.projectedVsPlan))} {projectedUnder ? "under" : "over"} plan.
              </span>
            </div>

            {/* Per-category list (already sorted by pct desc) */}
            <div className="space-y-2">
              {flex.lines.map((l) => {
                const barPct = l.unbudgeted
                  ? 130
                  : Math.min(130, l.pct);
                return (
                  <div key={l.categoryId} className="flex items-center gap-3">
                    <div className="w-32 sm:w-40 truncate text-sm">{l.name}</div>
                    <div className="flex-1 min-w-0">
                      <div className="h-2 rounded-full bg-muted/50 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${barPct}%`,
                            background: budgetStatusColor(l.status),
                          }}
                        />
                      </div>
                    </div>
                    <div className="w-40 text-right text-xs tabular-nums text-muted-foreground shrink-0">
                      {l.unbudgeted ? (
                        <span style={{ color: H2_PALETTE.amber }}>
                          no budget — {formatCurrency(l.actual)} spent
                        </span>
                      ) : (
                        `${formatCurrency(l.actual)} / ${formatCurrency(l.planned)}`
                      )}
                    </div>
                    <BudgetStatusChip status={l.status} />
                  </div>
                );
              })}
            </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bills & loans — checklist */}
      {fixedLines.length > 0 && (
        <Card className="rounded-lg">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-serif">Bills & loans</CardTitle>
            <p className="text-xs text-muted-foreground">
              Fixed obligations. A loan at 100% is paid — a green check, not a red bar.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {paidFixed.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  Paid this month
                </div>
                <div className="space-y-1.5">
                  {paidFixed.map((l) => (
                    <div key={l.categoryId} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 truncate">
                        <Check className="h-4 w-4 shrink-0" style={{ color: H2_PALETTE.emerald }} />
                        <span className="truncate">{l.name}</span>
                      </span>
                      <span className="tabular-nums shrink-0">{formatCurrency(l.actual)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {expectedFixed.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  Still expected
                </div>
                <div className="space-y-1.5">
                  {expectedFixed.map((l) => (
                    <div key={l.categoryId} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 truncate">
                        <Clock className="h-4 w-4 shrink-0" style={{ color: H2_PALETTE.amber }} />
                        <span className="truncate">{l.name}</span>
                      </span>
                      <span className="tabular-nums shrink-0 text-muted-foreground">
                        {formatCurrency(l.actual)} / {formatCurrency(l.planned)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Paychecks */}
      {income.lines.length > 0 && (
        <Card className="rounded-lg">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-serif">Paychecks</CardTitle>
            <p className="text-xs text-muted-foreground">
              Money landing this month. Coming in over estimate is good, never flagged.
            </p>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {income.lines.map((l) => {
              const isGood = l.status === "good";
              const label = isGood
                ? l.actual > l.planned
                  ? "ahead"
                  : "on track"
                : "still expected this month";
              return (
                <div key={l.categoryId} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 truncate">
                    {isGood ? (
                      <Check className="h-4 w-4 shrink-0" style={{ color: H2_PALETTE.emerald }} />
                    ) : (
                      <Clock className="h-4 w-4 shrink-0" style={{ color: H2_PALETTE.amber }} />
                    )}
                    <span className="truncate">{l.name}</span>
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    <span className="tabular-nums text-muted-foreground">
                      {formatCurrency(l.actual)} in · ~{formatCurrency(l.planned)} expected
                    </span>
                    <span
                      className="text-[10px] uppercase tracking-wider font-medium"
                      style={{ color: isGood ? H2_PALETTE.primary : H2_PALETTE.amber }}
                    >
                      {label}
                    </span>
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Pace of the month — flex burndown */}
      {flex.lines.length > 0 && burndownData.length > 0 && (
        <ChartCard
          title="Pace of the month"
          caption="Are we on track to make it through the month on day-to-day spending?"
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={burndownData} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} labelFormatter={(l: number) => `Day ${l}`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="planned" stroke={H2_PALETTE.primarySoft} strokeWidth={2} strokeDasharray="6 4" dot={false} name="Planned (paced)" />
              <Line type="monotone" dataKey="actual" stroke={H2_PALETTE.primary} strokeWidth={2.5} dot={false} name="Actual" connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Six-month streak board */}
      {streak.rows.length > 0 && (
        <ChartCard
          title="Six-month streak board"
          caption="Each row graded on its own terms — bills want 100%, spending wants less, paychecks want more."
          height={Math.max(220, 60 + streak.rows.length * 28)}
        >
          <div className="overflow-y-auto pr-1 h-full">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left font-normal pb-1">Category</th>
                  {streak.monthKeys.map((mk) => (
                    <th key={mk} className="text-center font-normal pb-1">
                      {mk.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {streak.rows.map((row) => (
                  <tr key={row.categoryId}>
                    <td className="py-1 pr-2 max-w-[160px]">
                      <span className="flex items-center gap-1 truncate">
                        {row.currentStreakGood >= 3 && (
                          <Flame className="h-3.5 w-3.5 shrink-0" style={{ color: H2_PALETTE.amber }} />
                        )}
                        <span className="truncate">{row.name}</span>
                      </span>
                    </td>
                    {row.cells.map((c, i) => {
                      if (!c)
                        return (
                          <td key={i} className="py-1 px-1">
                            <div className="h-6 rounded bg-muted/40" />
                          </td>
                        );
                      return (
                        <td key={i} className="py-1 px-1">
                          <div
                            className="h-6 rounded flex items-center justify-center text-[10px] font-mono text-white tabular-nums"
                            style={{ background: budgetStatusColor(c.status) }}
                            title={`${row.name} · ${c.status}`}
                          >
                            {c.pct >= 999 ? "—" : `${Math.round(c.pct)}%`}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      )}
    </div>
  );
}
