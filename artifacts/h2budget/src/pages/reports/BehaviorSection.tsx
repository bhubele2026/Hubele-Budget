import { useMemo } from "react";
import {
  useGetReportsBehaviorFacts,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, cn } from "@/lib/utils";
import { Trophy, Calendar, Sparkles, Flame } from "lucide-react";
import { H2_PALETTE } from "@/lib/reportsAnalytics";
import {
  ResponsiveContainer,
  BarChart,
  CartesianGrid,
  Cell,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  SectionHeader,
  ChartCard,
  HeroTile,
  tooltipMoney,
  tooltipStyle,
} from "./shared";

// (#851 Phase 2) Tone for a "days since last" tile. The dining/coffee tiles
// read recent activity as normal (green) and a long gap as notable; the Amazon
// tile is inverted — a long gap means resisting the impulse, so it greens out.
function daysSinceTone(
  bucket: "dining" | "coffee" | "amazon",
  days: number | null,
): "default" | "good" | "amber" | "bad" {
  if (days === null) return "default";
  if (bucket === "amazon") {
    if (days >= 14) return "good";
    if (days >= 7) return "amber";
    return "bad";
  }
  // dining + coffee
  if (days <= 7) return "good";
  if (days <= 14) return "amber";
  return "bad";
}

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function hourClockLabel(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

export function BehaviorSection({ from, to }: { from: string; to: string }) {
  const { data: facts, isLoading, isError } = useGetReportsBehaviorFacts({ from, to });

  const hourly = useMemo(
    () =>
      (facts?.hourlySpendingClock ?? []).map((h) => ({
        label: hourClockLabel(h.hour),
        amount: h.total,
      })),
    [facts],
  );

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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <SectionHeader
          eyebrow="Section · Behavior &amp; Fun"
          title="Money personality, decoded"
          blurb="The streaks, the spikes, and the spending-shaped fingerprint of your month."
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !facts) {
    return (
      <div className="space-y-6">
        <SectionHeader
          eyebrow="Section · Behavior &amp; Fun"
          title="Money personality, decoded"
          blurb="The streaks, the spikes, and the spending-shaped fingerprint of your month."
        />
        <Card className="rounded-lg border-dashed">
          <CardContent className="p-5 text-center text-sm text-muted-foreground">
            We couldn't load your behavior insights just now. Try refreshing in a
            moment.
          </CardContent>
        </Card>
      </div>
    );
  }

  const { daysSinceLast: dsl, funFacts: ff, streaks, hallOfFame } = facts;

  const daysValue = (e: typeof dsl.dining): string =>
    e ? `${e.days}` : "—";
  const lastSub = (e: typeof dsl.dining, emptyMsg: string): string => {
    if (!e) return emptyMsg;
    // Omit the dollar figure when there's no real amount behind the entry
    // (e.g. the manual Amazon anchor, which has no matching transaction).
    const amountPart = e.lastAmount > 0 ? ` · ${formatCurrency(e.lastAmount)}` : "";
    return `last: ${e.lastMerchant} · ${e.lastDate}${amountPart}`;
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Section · Behavior &amp; Fun"
        title="Money personality, decoded"
        blurb="The streaks, the spikes, and the spending-shaped fingerprint of your month."
      />

      {facts.range.floorApplied && (
        <p className="text-xs text-muted-foreground italic">
          Scoped to the data we have — your tracking started{" "}
          {facts.range.trackingStart}, so this window can't reach back further.
        </p>
      )}

      {/* Six-tile grid — three "days since last", three fun facts. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <HeroTile
          label="Days since last dining out"
          value={daysValue(dsl.dining)}
          sub={lastSub(dsl.dining, "No dining out in this window.")}
          tone={daysSinceTone("dining", dsl.dining?.days ?? null)}
        />
        <HeroTile
          label="Days since last Amazon order"
          value={daysValue(dsl.amazon)}
          sub={lastSub(dsl.amazon, "No Amazon orders in this window.")}
          tone={daysSinceTone("amazon", dsl.amazon?.days ?? null)}
        />
        <HeroTile
          label="Days since last coffee shop"
          value={daysValue(dsl.coffee)}
          sub={lastSub(dsl.coffee, "No coffee runs in this window.")}
          tone={daysSinceTone("coffee", dsl.coffee?.days ?? null)}
        />

        <HeroTile
          label="Biggest splurge"
          value={ff.biggestSplurge ? formatCurrency(ff.biggestSplurge.amount) : "—"}
          sub={
            ff.biggestSplurge
              ? `${ff.biggestSplurge.merchant} · ${ff.biggestSplurge.date}${ff.biggestSplurge.categoryName ? ` · ${ff.biggestSplurge.categoryName}` : ""}`
              : "No spending in this window."
          }
          icon={<Sparkles className="w-4 h-4" />}
        />
        <HeroTile
          label="Most-visited merchant"
          value={ff.mostVisitedMerchant ? ff.mostVisitedMerchant.name : "—"}
          badge={
            ff.mostVisitedMerchant
              ? `${ff.mostVisitedMerchant.count} visit${ff.mostVisitedMerchant.count === 1 ? "" : "s"}`
              : undefined
          }
          sub={
            ff.mostVisitedMerchant
              ? `${formatCurrency(ff.mostVisitedMerchant.total)}${ff.mostVisitedMerchant.sampleCategoryName ? ` · ${ff.mostVisitedMerchant.sampleCategoryName}` : ""}`
              : "No spending in this window."
          }
        />
        <HeroTile
          label="Next paycheck countdown"
          value={ff.nextPaycheckCountdown ? `${ff.nextPaycheckCountdown.days} days` : "—"}
          sub={
            ff.nextPaycheckCountdown
              ? `${ff.nextPaycheckCountdown.paycheckLabel} · ${formatCurrency(ff.nextPaycheckCountdown.expectedAmount)} on ${ff.nextPaycheckCountdown.expectedDate}`
              : "No upcoming paycheck on file."
          }
          icon={<Calendar className="w-4 h-4" />}
        />
      </div>

      {/* Three extra fun-fact tiles. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <HeroTile
          label="Quietest day"
          value={ff.quietestDay ? formatCurrency(ff.quietestDay.total) : "—"}
          sub={
            ff.quietestDay
              ? `${ff.quietestDay.dayOfWeek} · ${ff.quietestDay.date}`
              : "No spending days in this window."
          }
        />
        <HeroTile
          label="Impulse buys"
          value={`${ff.impulseBuyCount.count}`}
          sub={
            ff.impulseBuyCount.count > 0
              ? `${formatCurrency(ff.impulseBuyCount.total)}${ff.impulseBuyCount.exampleMerchants.length ? ` · ${ff.impulseBuyCount.exampleMerchants.slice(0, 3).join(", ")}` : ""}`
              : "No small impulse buys in this window."
          }
        />
        <HeroTile
          label="Subscriptions running"
          value={`${ff.subscriptionsCount.count}`}
          sub={
            ff.subscriptionsCount.count > 0
              ? `${formatCurrency(ff.subscriptionsCount.monthlyTotal)}/mo${ff.subscriptionsCount.topThree.length ? ` · Top 3: ${ff.subscriptionsCount.topThree.map((s) => s.name).join(", ")}` : ""}`
              : "No active subscriptions on file."
          }
        />
      </div>

      {/* Two streaks only — no-dining + coffee-free. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StreakCard
          label="No-dining streak"
          current={streaks.noDining.currentDays}
          longest={streaks.noDining.longestDays}
          unit="days"
        />
        <StreakCard
          label="Coffee-free streak"
          current={streaks.coffeeFree.currentDays}
          longest={streaks.coffeeFree.longestDays}
          unit="days"
        />
      </div>

      <ChartCard
        title="Spend by day of week"
        caption="Your weekly rhythm in dollars per day."
        empty={dow.every((d) => d.avgPerDay === 0) ? "All clear — no spending in this window." : null}
        hideWhenEmpty
        height={280}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dow} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => tooltipMoney(v)}
              labelFormatter={(l: string) => `${l} · avg/day`}
            />
            <Bar dataKey="avgPerDay" radius={[4, 4, 0, 0]}>
              {dow.map((_, i) => (
                <Cell
                  key={i}
                  fill={i === dowMaxIdx ? H2_PALETTE.warning : H2_PALETTE.primary}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Hall of fame — biggest expense + biggest income, split card. */}
      <Card className="rounded-lg">
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Hall of fame
            </div>
            <Trophy className="w-4 h-4 text-muted-foreground/70" />
          </div>
          <div className="mt-3 grid sm:grid-cols-2 gap-4 sm:divide-x sm:divide-[hsl(var(--card-border))]">
            <div className="sm:pr-4">
              <div className="text-xs text-muted-foreground">
                Biggest expense this window
              </div>
              <div className="text-2xl font-serif font-semibold tabular-nums text-[hsl(var(--negative))] mt-1">
                {hallOfFame.biggestExpense
                  ? formatCurrency(hallOfFame.biggestExpense.amount)
                  : "—"}
              </div>
              <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                {hallOfFame.biggestExpense
                  ? `${hallOfFame.biggestExpense.merchant}${hallOfFame.biggestExpense.categoryName ? ` · ${hallOfFame.biggestExpense.categoryName}` : ""} · ${hallOfFame.biggestExpense.date}`
                  : "No data this window."}
              </div>
            </div>
            <div className="sm:pl-4">
              <div className="text-xs text-muted-foreground">
                Biggest income this window
              </div>
              <div className="text-2xl font-serif font-semibold tabular-nums text-[hsl(var(--positive))] mt-1">
                {hallOfFame.biggestIncome
                  ? formatCurrency(hallOfFame.biggestIncome.amount)
                  : "—"}
              </div>
              <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                {hallOfFame.biggestIncome
                  ? `${hallOfFame.biggestIncome.merchant}${hallOfFame.biggestIncome.categoryName ? ` · ${hallOfFame.biggestIncome.categoryName}` : ""} · ${hallOfFame.biggestIncome.date}`
                  : "No data this window."}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StreakCard({
  label,
  current,
  longest,
  unit,
  help,
}: {
  label: string;
  current: number;
  longest: number;
  unit: string;
  help?: string;
}) {
  const hot = current >= 5;
  return (
    <Card className="rounded-lg">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </div>
          <Flame
            className={cn(
              "w-4 h-4",
              hot ? "text-[hsl(var(--warning))]" : "text-muted-foreground/50",
            )}
          />
        </div>
        <div className="mt-3 flex items-baseline gap-3">
          <div className="text-4xl font-serif font-bold tabular-nums">
            {current}
          </div>
          <div className="text-xs text-muted-foreground">current {unit}</div>
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          longest:{" "}
          <span className="tabular-nums text-foreground">
            {longest} {unit}
          </span>
        </div>
        {help && (
          <div className="text-[10px] text-muted-foreground italic mt-1">
            {help}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
