import { useMemo, useState } from "react";
import { useGetReportsBehaviorFacts } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";
import { fmtISO } from "@/lib/reportsAnalytics";
import { type RangeMode } from "@/lib/timeRange";
import { ANIM_BAR, CHART, animBegin, niceAxis } from "@/lib/chartTokens";
import { card, cardHead, emptyNote, fieldLabel, Foot, Stat } from "@/ui";
import {
  ResponsiveContainer,
  BarChart,
  CartesianGrid,
  Cell,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  AXIS_TICK,
  GRID_STROKE,
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
 * Renamed from "Behavior & Fun" → **Habits**.
 *
 * "Fun" was the app telling the reader how to feel about their own spending,
 * and "Behavior" is the clinical half of a name that never said what the page
 * shows. What it actually shows is cadence: how long since the last dining
 * charge, which weekday costs the most, how many subscriptions run, how long
 * the current no-dining run is. That is a habits page. It also reads as a
 * sibling of Budget / Spending / Cash Flow — one plain noun, no adjective.
 * The ROUTE stays `/reports/behavior` so bookmarks, `routePrefetch.ts` and
 * `App.tsx` stay in lockstep; only the words change.
 */
export default function BehaviorPage() {
  // Weekly-first: opens on the current week; Mo/Yr are opt-in.
  const [mode, setMode] = useState<RangeMode>("wk");
  const rangeDays = daysForMode(mode);
  // Date-window derivation lifted verbatim from the old shared reports data hook.
  // This page fetches nothing itself — HabitsSection reads server-computed
  // behavior facts for [from, to], so no transaction pull happens here.
  const today = useMemo(() => new Date(), []);
  const fromDate = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - rangeDays);
    return d;
  }, [today, rangeDays]);
  return (
    <ReportShell
      crumb="Habits"
      title="Habits"
      controls={
        <ReportsRangeControls mode={mode} setMode={setMode} showCompare={false} />
      }
    >
      <HabitsSection from={fmtISO(fromDate)} to={fmtISO(today)} />
    </ReportShell>
  );
}

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function HabitsSection({ from, to }: { from: string; to: string }) {
  const { data: facts, isLoading, isError } = useGetReportsBehaviorFacts({ from, to });

  const dow = useMemo(
    () =>
      (facts?.dayOfWeekSpend ?? []).map((d) => ({
        label: DOW_SHORT[d.dow] ?? d.label.slice(0, 3),
        avgPerDay: d.avgPerDay,
      })),
    [facts],
  );
  const dowMaxIdx = useMemo(() => {
    if (dow.length === 0) return -1;
    let idx = 0;
    for (let i = 1; i < dow.length; i += 1) {
      if (dow[i].avgPerDay > dow[idx].avgPerDay) idx = i;
    }
    return dow[idx].avgPerDay > 0 ? idx : -1;
  }, [dow]);
  // Stable across renders so recharts does not restart its draw.
  const dowScale = useMemo(
    () => niceAxis(0, Math.max(0, ...dow.map((d) => d.avgPerDay))),
    [dow],
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-card" />
        ))}
      </div>
    );
  }

  if (isError || !facts) {
    return (
      <div className={card}>
        <div className={emptyNote}>Behavior facts unavailable</div>
      </div>
    );
  }

  const { daysSinceLast: dsl, funFacts: ff, streaks, hallOfFame } = facts;
  const daysValue = (e: typeof dsl.dining): string => (e ? `${e.days}` : "—");

  const sinceRows = [
    { key: "Dining", entry: dsl.dining },
    { key: "Amazon", entry: dsl.amazon },
    { key: "Coffee", entry: dsl.coffee },
  ] as const;
  const sinceMax = Math.max(1, ...sinceRows.map((r) => r.entry?.days ?? 0));

  return (
    <div className="space-y-4">
      {facts.range.floorApplied && (
        <p className="text-micro text-neutral-400">
          Window clamped to the tracking start, {facts.range.trackingStart}.
        </p>
      )}

      {/* Days since last — one meter per habit, each against the longest gap
          in the set so the three are comparable at a glance. */}
      <PanelCard
        title="Days since last"
        help="Days since the most recent charge in each group, within this window. Bars are scaled to the longest of the three."
      >
        <div className="grid grid-cols-1 gap-4 px-4 py-3 sm:grid-cols-3">
          {sinceRows.map((r, i) => (
            <div key={r.key}>
              <div className="flex items-baseline justify-between gap-2">
                <span className={fieldLabel}>{r.key}</span>
                <span className="font-mono text-title font-semibold tabular-nums text-brand-navy">
                  {daysValue(r.entry)}
                </span>
              </div>
              {/* ⚠️ NOT `catColor(i)`. These three are the same quantity
                  measured three ways, not three categories — and CAT8's third
                  slot is the bright orange, which on this palette means "the
                  thing going wrong". A long gap since the last charge is the
                  GOOD outcome, so orange would have inverted the meaning of
                  the best row on the card. All three rest in navy; the label
                  and the number tell them apart. */}
              <div
                aria-hidden
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-brand-line"
              >
                <span
                  className="bar-sweep grow-x block h-full rounded-full"
                  style={{
                    width: `${((r.entry?.days ?? 0) / sinceMax) * 100}%`,
                    background: CHART.navy,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </PanelCard>

      {/* The facts, as tiles. Every sentence these used to carry now lives in
          the tile's own hint line. */}
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat
          index={0}
          label="Biggest charge"
          value={ff.biggestSplurge ? formatCurrency(ff.biggestSplurge.amount) : "—"}
          hint={
            ff.biggestSplurge
              ? `${ff.biggestSplurge.merchant} · ${ff.biggestSplurge.date}${ff.biggestSplurge.categoryName ? ` · ${ff.biggestSplurge.categoryName}` : ""}`
              : "No spending in this window"
          }
          data-testid="habits-biggest-charge"
        />
        <Stat
          index={1}
          label="Most-visited merchant"
          value={ff.mostVisitedMerchant ? ff.mostVisitedMerchant.name : "—"}
          hint={
            ff.mostVisitedMerchant
              ? `${ff.mostVisitedMerchant.count} visit${ff.mostVisitedMerchant.count === 1 ? "" : "s"} · ${formatCurrency(ff.mostVisitedMerchant.total)}${ff.mostVisitedMerchant.sampleCategoryName ? ` · ${ff.mostVisitedMerchant.sampleCategoryName}` : ""}`
              : "No spending in this window"
          }
          data-testid="habits-top-merchant"
        />
        <Stat
          index={2}
          label="Next paycheck"
          value={ff.nextPaycheckCountdown ? `${ff.nextPaycheckCountdown.days} days` : "—"}
          hint={
            ff.nextPaycheckCountdown
              ? `${ff.nextPaycheckCountdown.paycheckLabel} · ${formatCurrency(ff.nextPaycheckCountdown.expectedAmount)} on ${ff.nextPaycheckCountdown.expectedDate}`
              : "No upcoming paycheck on file"
          }
          data-testid="habits-next-paycheck"
        />
        <Stat
          index={3}
          label="Quietest day"
          value={ff.quietestDay ? formatCurrency(ff.quietestDay.total) : "—"}
          hint={
            ff.quietestDay
              ? `${ff.quietestDay.dayOfWeek} · ${ff.quietestDay.date}`
              : "No spending days in this window"
          }
        />
        <Stat
          index={4}
          label="Impulse buys"
          value={ff.impulseBuyCount.count}
          hint={
            ff.impulseBuyCount.count > 0
              ? `${formatCurrency(ff.impulseBuyCount.total)}${ff.impulseBuyCount.exampleMerchants.length ? ` · ${ff.impulseBuyCount.exampleMerchants.slice(0, 3).join(", ")}` : ""}`
              : "None in this window"
          }
        />
        <Stat
          index={5}
          label="Subscriptions"
          value={ff.subscriptionsCount.count}
          hint={
            ff.subscriptionsCount.count > 0
              ? `${formatCurrency(ff.subscriptionsCount.monthlyTotal)}/mo${ff.subscriptionsCount.topThree.length ? ` · ${ff.subscriptionsCount.topThree.map((s) => s.name).join(", ")}` : ""}`
              : "None on file"
          }
        />
      </div>

      {/* Streaks — current run against the record, so the meter has a ceiling
          that means something. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StreakCard
          label="No-dining run"
          current={streaks.noDining.currentDays}
          longest={streaks.noDining.longestDays}
        />
        <StreakCard
          label="Coffee-free run"
          current={streaks.coffeeFree.currentDays}
          longest={streaks.coffeeFree.longestDays}
        />
      </div>

      <ChartCard
        title="Spend by day of week"
        help="Average dollars per day, for each weekday in this window. The heaviest day takes the orange."
        empty={dow.every((d) => d.avgPerDay === 0) ? "No spending in this window" : null}
        hideWhenEmpty
        height={260}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dow} margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis
              tick={AXIS_TICK}
              tickFormatter={axisMoney}
              domain={dowScale.domain}
              ticks={dowScale.ticks}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => tooltipMoney(v)}
              labelFormatter={(l: string) => `${l} · avg/day`}
              cursor={{ fill: CHART.grid, opacity: 0.45 }}
            />
            <Bar
              {...ANIM_BAR}
              animationBegin={animBegin(0)}
              dataKey="avgPerDay"
              radius={[4, 4, 0, 0]}
            >
              {dow.map((_, i) => (
                <Cell key={i} fill={i === dowMaxIdx ? CHART.orange : CHART.navy} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Biggest expense + biggest income, side by side. */}
      <PanelCard title="Largest movements">
        <div className="grid grid-cols-1 divide-y divide-brand-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="px-4 py-3">
            <div className={fieldLabel}>Biggest expense</div>
            <div className="mt-0.5 font-mono text-title font-semibold tabular-nums text-bad">
              {hallOfFame.biggestExpense
                ? formatCurrency(hallOfFame.biggestExpense.amount)
                : "—"}
            </div>
            <div className="mt-0.5 truncate text-micro text-neutral-400">
              {hallOfFame.biggestExpense
                ? `${hallOfFame.biggestExpense.merchant}${hallOfFame.biggestExpense.categoryName ? ` · ${hallOfFame.biggestExpense.categoryName}` : ""} · ${hallOfFame.biggestExpense.date}`
                : "No data this window"}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className={fieldLabel}>Biggest income</div>
            <div className="mt-0.5 font-mono text-title font-semibold tabular-nums text-brand-navy">
              {hallOfFame.biggestIncome
                ? formatCurrency(hallOfFame.biggestIncome.amount)
                : "—"}
            </div>
            <div className="mt-0.5 truncate text-micro text-neutral-400">
              {hallOfFame.biggestIncome
                ? `${hallOfFame.biggestIncome.merchant}${hallOfFame.biggestIncome.categoryName ? ` · ${hallOfFame.biggestIncome.categoryName}` : ""} · ${hallOfFame.biggestIncome.date}`
                : "No data this window"}
            </div>
          </div>
        </div>
        <Foot>
          Expense is deep orange and income is navy because on this palette only
          the outflow takes a colour; the label says which either way.
        </Foot>
      </PanelCard>
    </div>
  );
}

function StreakCard({
  label,
  current,
  longest,
}: {
  label: string;
  current: number;
  longest: number;
}) {
  const atRecord = longest > 0 && current >= longest;
  return (
    <div className={card}>
      <div className={cardHead}>
        <span className={`${fieldLabel} flex-1`}>{label}</span>
        <span className={`chip ${atRecord ? "ok" : "gray"}`}>
          {atRecord ? "At record" : `Record ${longest}`}
        </span>
      </div>
      <div className="px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-display font-semibold tabular-nums text-brand-navy">
            {current}
          </span>
          <span className="text-micro text-neutral-400">days</span>
        </div>
        {/* Current run against the record — NOT `CssFillMeter`, deliberately.
            That primitive paints an overshoot deep orange because it exists
            for budget caps, where over is bad. Here beating the record is the
            good outcome, so the bar clamps at full and stays navy; the chip
            says "At record". */}
        <div
          aria-hidden
          className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-brand-line"
          title={`${current} of a ${longest}-day record`}
        >
          <span
            className="bar-sweep grow-x block h-full rounded-full"
            style={{
              width: `${longest > 0 ? Math.min(100, (current / longest) * 100) : 0}%`,
              background: CHART.navy,
            }}
          />
        </div>
      </div>
    </div>
  );
}
