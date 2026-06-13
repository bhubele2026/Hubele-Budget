import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Flame, Trophy, PiggyBank, Sparkles, TrendingUp } from "lucide-react";
import {
  useGetForecast,
  useGetDashboard,
  useGetAdvisorNudge,
  useGetSettings,
  useListTransactions,
} from "@workspace/api-client-react";
import {
  weeklyBudgetStreak,
  isoDaysAgo,
  todayISO,
} from "@/lib/weeklyStreak";
import { useUser } from "@clerk/react";
import { useCountUp } from "@/hooks/useCountUp";
import { cn, formatCurrency } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { MonthlyWrapped } from "@/components/monthly-wrapped";
import { Confetti } from "@/components/confetti";
import { PaceGauge } from "@/components/pace-gauge";

function greetingFor(hour: number): string {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Burning the midnight oil";
}

/** Big count-up money stat. */
function StatNumber({
  label,
  value,
  loading,
  tone = "neutral",
  sub,
}: {
  label: string;
  value: number | null;
  loading?: boolean;
  tone?: "neutral" | "good" | "bad";
  sub?: string;
}) {
  const shown = useCountUp(loading ? null : value);
  const toneClass =
    tone === "good"
      ? "text-emerald-500"
      : tone === "bad"
        ? "text-[hsl(var(--negative))]"
        : "text-foreground";
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
          {label}
        </div>
        <div
          className={cn(
            "mt-1.5 text-[2.1rem] md:text-[2.4rem] font-bold tracking-[-0.02em] tabular-nums leading-none",
            toneClass,
          )}
        >
          {loading || value == null ? "—" : formatCurrency(shown)}
        </div>
        {sub ? (
          <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function CommandCenterPage() {
  const { data: forecast, isLoading: fLoading } = useGetForecast({ days: 90 });
  const { data: dash, isLoading: dLoading } = useGetDashboard();
  const { data: nudge } = useGetAdvisorNudge();
  const { data: settings } = useGetSettings();
  const nowRef = new Date();
  const { data: weeklyTxns } = useListTransactions({
    from: isoDaysAgo(nowRef, 90),
    to: todayISO(nowRef),
    limit: 3000,
  });
  const [wrappedOpen, setWrappedOpen] = useState(false);
  const [celebrate, setCelebrate] = useState(false);

  const { user } = useUser();
  const who = user?.firstName?.trim() || "Hubeles";
  const now = new Date();
  const greeting = greetingFor(now.getHours());
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();

  const cashNow = forecast?.bankSnapshot?.balance
    ? Number(forecast.bankSnapshot.balance)
    : null;
  const netMonth = dash ? Number(dash.netCashflow) : null;
  const income = dash ? Number(dash.monthlyIncome) : 0;
  const spend = dash ? Number(dash.monthlySpend) : 0;
  const totalDebt = dash ? Number(dash.totalDebt) : null;
  const paidThisMonth = dash ? Number(dash.paidThisMonth) : 0;

  // Projected checking balance: start at the bank snapshot and walk the
  // forward forecast events (already signed: income +, outflow −). Gives the
  // line that draws itself in.
  const { series, runwayDays } = useMemo(() => {
    if (!forecast) return { series: [], runwayDays: null as number | null };
    const start =
      Number(forecast.bankSnapshot?.balance) ||
      Number(forecast.settings?.startingBalance) ||
      0;
    const startISO = forecast.bankSnapshot?.at
      ? forecast.bankSnapshot.at.slice(0, 10)
      : forecast.fromDate;
    const evs = [...(forecast.events ?? [])]
      .filter((e) => e.date >= startISO)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let bal = start;
    const pts: { date: string; balance: number }[] = [
      { date: startISO, balance: Math.round(bal) },
    ];
    let firstNegISO: string | null = null;
    for (const e of evs) {
      bal += Number(e.amount) || 0;
      const r = Math.round(bal);
      pts.push({ date: e.date, balance: r });
      if (firstNegISO == null && r < 0) firstNegISO = e.date;
    }
    let runway: number | null = null;
    if (firstNegISO) {
      const ms =
        new Date(firstNegISO).getTime() - new Date(startISO).getTime();
      runway = Math.max(0, Math.round(ms / 86_400_000));
    }
    return { series: pts, runwayDays: runway };
  }, [forecast]);

  const lowPoint = useMemo(
    () =>
      series.length
        ? series.reduce((m, p) => (p.balance < m ? p.balance : m), Infinity)
        : null,
    [series],
  );

  // Earned badges — purely from the live numbers, no fake data.
  const badges = useMemo(() => {
    const out: { icon: typeof Trophy; label: string }[] = [];
    if (netMonth != null && netMonth > 0)
      out.push({ icon: TrendingUp, label: "In the black" });
    if (paidThisMonth > 0) out.push({ icon: Trophy, label: "Debt slayer" });
    if (income > 0 && spend > 0 && spend < income * 0.8)
      out.push({ icon: PiggyBank, label: "Under 80% spend" });
    if (lowPoint != null && lowPoint > 0)
      out.push({ icon: Flame, label: "Stays in the green" });
    return out;
  }, [netMonth, paidThisMonth, income, spend, lowPoint]);

  const streak = useMemo(
    () =>
      weeklyBudgetStreak(
        weeklyTxns ?? [],
        Number(settings?.weeklyAllowanceAmount) || 0,
        settings?.preferences?.weeklyAllowanceOverrides ?? undefined,
        now,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weeklyTxns, settings],
  );

  const nudgeMsg =
    nudge?.enabled && nudge.message ? nudge.message : null;
  const sevColor =
    nudge?.severity === "alert"
      ? "text-[hsl(var(--negative))]"
      : nudge?.severity === "warn"
        ? "text-amber-500"
        : "text-primary";

  // Celebrate a net-positive month — confetti once per session per month so it
  // feels like a reward, not a nag.
  useEffect(() => {
    if (netMonth == null || netMonth <= 0) return;
    const key = `h2:cc-celebrated:${new Date().toISOString().slice(0, 7)}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      /* ignore */
    }
    setCelebrate(true);
    const t = window.setTimeout(() => setCelebrate(false), 4200);
    return () => window.clearTimeout(t);
  }, [netMonth]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <Confetti fire={celebrate} />
      {/* Greeting + savage AI line */}
      <div>
        <h1 className="text-[1.9rem] md:text-[2.2rem] font-bold tracking-tight text-foreground leading-tight">
          {greeting}, {who}.
        </h1>
        <div className="mt-1.5 flex items-start gap-2">
          <Sparkles className="w-4 h-4 mt-1 shrink-0 text-primary" />
          <p className={cn("text-base font-medium leading-snug", sevColor)}>
            {nudgeMsg ??
              "Pull a sync and I'll tell you how you're really doing."}
          </p>
        </div>
      </div>

      {/* Big count-up numbers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
        <StatNumber
          label="Cash on hand"
          value={cashNow}
          loading={fLoading}
          tone={cashNow != null && cashNow < 0 ? "bad" : "neutral"}
          sub={
            forecast?.bankSnapshot?.name
              ? `${forecast.bankSnapshot.name}`
              : "Checking"
          }
        />
        <StatNumber
          label="Net this month"
          value={netMonth}
          loading={dLoading}
          tone={netMonth == null ? "neutral" : netMonth >= 0 ? "good" : "bad"}
          sub={
            dash
              ? `${formatCurrency(income)} in · ${formatCurrency(spend)} out`
              : undefined
          }
        />
        <StatNumber
          label="Total debt"
          value={totalDebt}
          loading={dLoading}
          tone={totalDebt && totalDebt > 0 ? "bad" : "good"}
          sub={paidThisMonth > 0 ? `${formatCurrency(paidThisMonth)} paid this month` : undefined}
        />
        <StatNumber
          label="Paid to debt"
          value={dash ? paidThisMonth : null}
          loading={dLoading}
          tone={paidThisMonth > 0 ? "good" : "neutral"}
          sub="this month"
        />
      </div>

      {/* Spend-pace gauge */}
      <Card>
        <CardContent className="p-5">
          <PaceGauge
            spend={spend}
            income={income}
            dayOfMonth={dayOfMonth}
            daysInMonth={daysInMonth}
          />
        </CardContent>
      </Card>

      {/* Forecast line that draws itself in */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              Where your cash is headed
            </span>
            <span className="text-[11px] text-muted-foreground">
              {runwayDays != null
                ? `Dips below $0 in ~${runwayDays} days`
                : lowPoint != null
                  ? `Low point ${formatCurrency(lowPoint)}`
                  : "next 90 days"}
            </span>
          </div>
          <div className="h-[170px] w-full">
            {series.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={series}
                  margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id="ccFill" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor="hsl(var(--primary))"
                        stopOpacity={0.28}
                      />
                      <stop
                        offset="100%"
                        stopColor="hsl(var(--primary))"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                    minTickGap={40}
                    tickFormatter={(v: string) => {
                      const [, m, d] = v.split("-");
                      return `${Number(m)}/${Number(d)}`;
                    }}
                  />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    width={44}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
                  />
                  <RechartsTooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--card-border))",
                      color: "hsl(var(--card-foreground))",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    formatter={(v: number) => [formatCurrency(v), "Projected"]}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--negative))" strokeDasharray="3 3" strokeOpacity={0.5} />
                  <Area
                    type="monotone"
                    dataKey="balance"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2.5}
                    fill="url(#ccFill)"
                    isAnimationActive
                    animationDuration={1200}
                    animationEasing="ease-out"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full grid place-items-center text-sm text-muted-foreground">
                Sync your bank to see your cash trajectory.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Badges + Wrapped */}
      <div className="flex flex-wrap items-center gap-2">
        {streak.weeks >= 2 ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold border",
              streak.direction === "under"
                ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
                : "bg-[hsl(var(--negative)/0.15)] text-[hsl(var(--negative))] border-[hsl(var(--negative)/0.3)]",
            )}
            data-testid="weekly-streak-chip"
          >
            <Flame className="w-3.5 h-3.5" />
            {streak.weeks} weeks{" "}
            {streak.direction === "under" ? "under budget" : "over budget"}
          </span>
        ) : null}
        {badges.map((b) => (
          <span
            key={b.label}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium"
          >
            <b.icon className="w-3.5 h-3.5 text-primary" />
            {b.label}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setWrappedOpen(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-xs font-bold hover:opacity-90 transition-opacity"
          data-testid="open-wrapped"
        >
          <Sparkles className="w-3.5 h-3.5" /> View this month, Wrapped
        </button>
      </div>

      <MonthlyWrapped
        open={wrappedOpen}
        onOpenChange={setWrappedOpen}
        dashboard={dash ?? null}
      />
    </div>
  );
}
