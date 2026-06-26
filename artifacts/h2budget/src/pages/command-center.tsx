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
import { Link } from "wouter";
import {
  Flame,
  Trophy,
  PiggyBank,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Wallet,
  Receipt,
  CreditCard,
  BarChart3,
} from "lucide-react";
import { SyncButton } from "@/components/sync-button";
import {
  useGetForecast,
  useGetDashboard,
  useGetAdvisorNudge,
  useGetSettings,
  useListTransactions,
  useGetAmexWeeklyPayoff,
} from "@workspace/api-client-react";
import {
  weeklyBudgetStreak,
  isoDaysAgo,
  todayISO,
  currentWeekBounds,
} from "@/lib/weeklyStreak";
import { CategoryDonut } from "@/components/category-donut";
import { HealthScore } from "@/components/health-score";
import { SavingsGoal } from "@/components/savings-goal";
import { DrillCard } from "@/components/drill-card";
import { KillStack } from "@/components/kill-stack";
import { Sparkline, StackBar, RingStat, HeatStrip, MiniBars, MoneyText } from "@/components/viz";
import { useUser } from "@clerk/react";
import { useCountUp } from "@/hooks/useCountUp";
import { cn, formatCurrency } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { MonthlyWrapped } from "@/components/monthly-wrapped";
import { Confetti } from "@/components/confetti";
import { PaceGauge } from "@/components/pace-gauge";
import { SpendScoreboard } from "@/components/spend-scoreboard";
import { FreedomMeter } from "@/components/freedom-meter";

const MIX_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-5))",
];

// A playful "money type" for the month, from the top spend category.
function moneyPersona(cat: string | undefined): { label: string; emoji: string } {
  const c = (cat || "").toLowerCase();
  if (/dining|restaurant|coffee|doordash|takeout|food/.test(c))
    return { label: "The Foodies", emoji: "🍔" };
  if (/subscription|stream|netflix|spotify|hulu/.test(c))
    return { label: "The Subscription Hoarders", emoji: "📺" };
  if (/grocer/.test(c)) return { label: "The Home Chefs", emoji: "🥦" };
  if (/amazon|shop|retail|clothing|target/.test(c))
    return { label: "The Add-to-Cart Crew", emoji: "📦" };
  if (/alcohol|bar|liquor|wine|beer/.test(c))
    return { label: "The Happy Hour Heroes", emoji: "🍷" };
  if (/travel|flight|hotel|airbnb|vacation/.test(c))
    return { label: "The Jet Setters", emoji: "✈️" };
  if (/gas|fuel|auto|car|uber|lyft/.test(c))
    return { label: "The Road Warriors", emoji: "🚗" };
  if (/pet|dog|cat|vet/.test(c)) return { label: "The Pet Parents", emoji: "🐾" };
  if (/kid|child|daycare|school/.test(c))
    return { label: "The Parents on Duty", emoji: "🍼" };
  if (!c) return { label: "The Mystery Spenders", emoji: "🕵️" };
  return { label: `The ${cat} Devotees`, emoji: "💸" };
}

function greetingFor(hour: number): string {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Burning the midnight oil";
}

export default function CommandCenterPage() {
  const { data: forecast } = useGetForecast({ days: 90 });
  const { data: dash, isLoading: dLoading } = useGetDashboard();
  const { data: nudge } = useGetAdvisorNudge();
  const { data: settings } = useGetSettings();
  // Deduped with <KillStack/> below (same query key) — one fetch, used for the
  // Amex command box's combined-owed + brand dots.
  const { data: payoff } = useGetAmexWeeklyPayoff();
  const nowRef = new Date();
  const { data: weeklyTxns } = useListTransactions({
    from: isoDaysAgo(nowRef, 90),
    to: todayISO(nowRef),
    limit: 3000,
  });
  const [wrappedOpen, setWrappedOpen] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const [openStreak, setOpenStreak] = useState(0);

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

  const netMonth = dash ? Number(dash.netCashflow) : null;
  const income = dash ? Number(dash.monthlyIncome) : 0;
  const spend = dash ? Number(dash.monthlySpend) : 0;
  const totalDebt = dash ? Number(dash.totalDebt) : null;
  const paidThisMonth = dash ? Number(dash.paidThisMonth) : 0;
  const paidLifetime = dash ? Number(dash.paidLifetime) : 0;
  const persona = moneyPersona(dash?.topCategories?.[0]?.categoryName);
  const debtCountUp = useCountUp(dLoading ? null : (totalDebt ?? 0));

  // Debt-free projection at THIS month's paydown pace — honest, from existing
  // dashboard numbers only (no new fetch, no new money model).
  const debtFree = useMemo(() => {
    if (totalDebt == null || totalDebt <= 0 || paidThisMonth <= 0) return null;
    const months = Math.max(1, Math.ceil(totalDebt / paidThisMonth));
    const d = new Date(now.getFullYear(), now.getMonth() + months, 1);
    return {
      months,
      label: d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalDebt, paidThisMonth]);

  // Projected checking balance walk — the runway sparkline + forecast area.
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
      const ms = new Date(firstNegISO).getTime() - new Date(startISO).getTime();
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

  // --- Command-box mini-visuals (derived from data already on the page) ----
  const spendMix = useMemo(
    () =>
      (dash?.topCategories ?? []).slice(0, 5).map((c, i) => ({
        label: c.categoryName,
        value: Number(c.total) || 0,
        color: MIX_COLORS[i % MIX_COLORS.length],
      })),
    [dash],
  );

  // Cumulative cash movement over the last 30 days — a "recent trend" shape.
  const chaseSpark = useMemo(() => {
    const fromISO = isoDaysAgo(now, 30);
    const byDay = new Map<string, number>();
    for (const t of weeklyTxns ?? []) {
      if (!t.occurredOn || t.occurredOn < fromISO) continue;
      byDay.set(t.occurredOn, (byDay.get(t.occurredOn) ?? 0) + (Number(t.amount) || 0));
    }
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let run = 0;
    return days.map(([, v]) => (run += v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeklyTxns]);

  const runwaySpark = useMemo(() => series.map((p) => p.balance), [series]);

  // Daily spend heat — last 14 days.
  const dailyHeat = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const vals: number[] = [];
    const labels: string[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      let s = 0;
      for (const t of weeklyTxns ?? []) {
        if (t.occurredOn !== iso) continue;
        const a = Number(t.amount) || 0;
        if (a < 0 && !t.reimbursable) s += -a;
      }
      vals.push(s);
      labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
    return { vals, labels };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeklyTxns]);

  // This-month spend grouped by household member → the scoreboard.
  const memberSpend = useMemo(() => {
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const map = new Map<string, number>();
    for (const t of weeklyTxns ?? []) {
      if (!t.occurredOn || !t.occurredOn.startsWith(ym)) continue;
      const a = Number(t.amount) || 0;
      if (a >= 0) continue;
      if (t.reimbursable) continue;
      const w = (t.member ?? "").trim() || "Unassigned";
      map.set(w, (map.get(w) ?? 0) + -a);
    }
    return [...map.entries()]
      .map(([name, s]) => ({ name, spend: s }))
      .sort((a, b) => b.spend - a.spend);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeklyTxns]);

  // This week's weekly-allowance pace (spend vs planned, this Sun–Sat).
  const thisWeek = useMemo(() => {
    const { startISO, endISO } = currentWeekBounds(now);
    let s = 0;
    for (const t of weeklyTxns ?? []) {
      if (!t.weeklyAllowance) continue;
      if (t.occurredOn >= startISO && t.occurredOn <= endISO) {
        const a = Number(t.amount) || 0;
        if (a < 0) s += -a;
      }
    }
    const override = settings?.preferences?.weeklyAllowanceOverrides?.[startISO];
    const planned =
      override != null
        ? Number(override)
        : Number(settings?.weeklyAllowanceAmount) || 0;
    return { spend: s, planned };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeklyTxns, settings]);
  const allowanceRatio =
    thisWeek.planned > 0 ? thisWeek.spend / thisWeek.planned : 0;

  // This month vs last month at the SAME point in the month.
  const momCompare = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const ymThis = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const ymPrev = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`;
    let cur = 0;
    let last = 0;
    for (const t of weeklyTxns ?? []) {
      const a = Number(t.amount) || 0;
      if (a >= 0 || t.reimbursable || !t.occurredOn) continue;
      const day = Number(t.occurredOn.slice(8, 10));
      if (t.occurredOn.startsWith(ymThis)) cur += -a;
      else if (t.occurredOn.startsWith(ymPrev) && day <= dayOfMonth) last += -a;
    }
    const pctChange = last > 0 ? ((cur - last) / last) * 100 : null;
    return { cur, last, pctChange };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeklyTxns, dayOfMonth]);

  // Biggest single expense this month — named and shamed.
  const biggestSplurge = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const ym = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    let worst: { desc: string; amt: number; member: string | null; date: string } | null =
      null;
    for (const t of weeklyTxns ?? []) {
      const a = Number(t.amount) || 0;
      if (a >= 0 || t.reimbursable || !t.occurredOn?.startsWith(ym)) continue;
      if (!worst || a < worst.amt) {
        worst = {
          desc: t.description || "Something",
          amt: a,
          member: t.member ?? null,
          date: t.occurredOn,
        };
      }
    }
    return worst;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeklyTxns]);

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

  const healthScore = useMemo(() => {
    let s = 50;
    if (netMonth != null && income > 0) {
      const r = netMonth / income;
      s += r >= 0.2 ? 20 : r > 0 ? 10 : r > -0.1 ? -8 : -18;
    } else if (netMonth != null) {
      s += netMonth > 0 ? 10 : -12;
    }
    if (lowPoint != null) s += lowPoint > 0 ? 15 : -12;
    if (runwayDays != null && runwayDays < 14) s -= 10;
    if (paidThisMonth > 0) s += 6;
    if (streak.direction === "under") s += Math.min(15, streak.weeks * 5);
    else if (streak.direction === "over") s -= Math.min(15, streak.weeks * 5);
    if (thisWeek.planned > 0) s += thisWeek.spend <= thisWeek.planned ? 8 : -8;
    return Math.max(2, Math.min(100, Math.round(s)));
  }, [netMonth, income, lowPoint, runwayDays, paidThisMonth, streak, thisWeek]);

  const health = useMemo(() => {
    const s = healthScore;
    if (s >= 80)
      return {
        color: "hsl(150 60% 45%)",
        label: "Thriving",
        blurb: "You two are running this like pros. Don't get cocky.",
      };
    if (s >= 60)
      return {
        color: "hsl(214 82% 62%)",
        label: "Solid",
        blurb: "Good shape — a couple tweaks and you're untouchable.",
      };
    if (s >= 40)
      return {
        color: "hsl(40 95% 55%)",
        label: "Shaky",
        blurb: "Wobbling. Tighten the spend before it bites, you muppets.",
      };
    return {
      color: "hsl(0 75% 60%)",
      label: "Critical",
      blurb: "Flashing red light. Sort it out before it sorts you.",
    };
  }, [healthScore]);

  const projectedNet = useMemo(() => {
    const elapsed = daysInMonth > 0 ? dayOfMonth / daysInMonth : 0;
    if (elapsed <= 0.05 || income <= 0) return null;
    const projectedSpend = spend / elapsed;
    return income - projectedSpend;
  }, [spend, income, dayOfMonth, daysInMonth]);
  const monthName = now.toLocaleDateString("en-US", { month: "long" });

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

  const nudgeMsg = nudge?.enabled && nudge.message ? nudge.message : null;
  const sevColor =
    nudge?.severity === "alert"
      ? "text-[hsl(var(--negative))]"
      : nudge?.severity === "warn"
        ? "text-amber-500"
        : "text-primary";

  // Daily check-in streak — consecutive days the app was opened.
  useEffect(() => {
    const KEY = "h2:open-streak:v1";
    const iso = (dd: Date) =>
      `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}-${String(
        dd.getDate(),
      ).padStart(2, "0")}`;
    try {
      const t = new Date();
      const tISO = iso(t);
      const yISO = iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1));
      const raw = localStorage.getItem(KEY);
      const prev = raw ? (JSON.parse(raw) as { last: string; count: number }) : null;
      let count: number;
      if (prev?.last === tISO) {
        count = prev.count;
      } else {
        count = prev?.last === yISO ? prev.count + 1 : 1;
        localStorage.setItem(KEY, JSON.stringify({ last: tISO, count }));
      }
      setOpenStreak(count);
    } catch {
      setOpenStreak(1);
    }
  }, []);

  // Celebrate a net-positive month — confetti once per session per month.
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

  const amexOwed = payoff?.combinedStatementBalance ?? null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <Confetti fire={celebrate} />

      {/* ── Hero: the debt thesis ──────────────────────────────────────── */}
      <Card className="focus-glow">
        <CardContent className="p-5 md:p-6">
          <div className="grid gap-5 md:grid-cols-2 md:items-center">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                {greeting}, {who} · total debt remaining
              </div>
              <div className="mt-1 text-[2.6rem] md:text-[3.1rem] font-bold tracking-[-0.02em] tabular-nums leading-none text-foreground">
                {dLoading || totalDebt == null ? "—" : formatCurrency(debtCountUp)}
              </div>
              <div className="mt-2 text-sm text-muted-foreground">
                {debtFree
                  ? `Debt-free around ${debtFree.label} at this month's pace · ${formatCurrency(paidThisMonth)} paid so far`
                  : totalDebt != null && totalDebt <= 0
                    ? "Debt-free. Absolute legends."
                    : "Throw something at the avalanche this month to set a free-by date."}
              </div>
              <div className="mt-3 flex items-start gap-2">
                <Sparkles className={cn("w-4 h-4 mt-0.5 shrink-0", sevColor)} />
                <p className={cn("text-sm font-medium leading-snug", sevColor)}>
                  {nudgeMsg ?? "Pull a sync and I'll tell you how you're really doing."}
                </p>
              </div>
              <div className="mt-4">
                <SyncButton />
              </div>
            </div>
            <div>
              {dash ? (
                <FreedomMeter
                  totalDebt={Number(dash.totalDebt) || 0}
                  paidLifetime={paidLifetime}
                  paidThisMonth={paidThisMonth}
                />
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── The five command boxes ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-5 gap-4 stagger-children">
        <DrillCard
          href="/reports"
          eyebrow={<span className="inline-flex items-center gap-1.5"><BarChart3 className="w-3.5 h-3.5" />Overview</span>}
          value="Reports"
          visual={spendMix.length ? <StackBar segments={spendMix} showLegend={false} /> : undefined}
          sub={!spendMix.length ? "No spend yet" : undefined}
        />
        <DrillCard
          href="/transactions"
          eyebrow={<span className="inline-flex items-center gap-1.5"><Receipt className="w-3.5 h-3.5" />Chase</span>}
          value="Bank"
          visual={
            chaseSpark.length > 1 ? (
              <Sparkline data={chaseSpark} variant="area" color="hsl(var(--chart-1))" height={32} />
            ) : undefined
          }
          sub={!chaseSpark.length ? "No recent flow" : undefined}
        />
        <DrillCard
          href="/amex"
          eyebrow={<span className="inline-flex items-center gap-1.5"><CreditCard className="w-3.5 h-3.5" />Amex</span>}
          value={amexOwed != null ? <MoneyText amount={amexOwed} /> : "Cards"}
          sub="combined owed"
          visual={
            <div className="flex items-center gap-1.5">
              {["blue", "silver", "gold"].map((b) => (
                <span
                  key={b}
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: `hsl(var(--card-${b}))` }}
                />
              ))}
            </div>
          }
        />
        <DrillCard
          href="/allowances"
          eyebrow={<span className="inline-flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5" />Allowance</span>}
          value="This week"
          visual={
            thisWeek.planned > 0 ? (
              <RingStat
                value={allowanceRatio}
                size={52}
                color={allowanceRatio > 1 ? "hsl(var(--negative))" : "hsl(var(--positive))"}
                centerSub="used"
              />
            ) : undefined
          }
          sub={
            thisWeek.planned > 0
              ? `${formatCurrency(thisWeek.spend)} / ${formatCurrency(thisWeek.planned)}`
              : "Set an allowance"
          }
        />
        <DrillCard
          href="/forecast"
          eyebrow={<span className="inline-flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5" />Forecast</span>}
          value="Runway"
          visual={
            runwaySpark.length > 1 ? (
              <Sparkline
                data={runwaySpark}
                variant="area"
                color={lowPoint != null && lowPoint < 0 ? "hsl(var(--negative))" : "hsl(var(--chart-3))"}
                height={32}
              />
            ) : undefined
          }
          sub={
            runwayDays != null
              ? `Dips below $0 in ~${runwayDays}d`
              : lowPoint != null
                ? `Low ${formatCurrency(lowPoint)}`
                : "next 90 days"
          }
        />
      </div>

      {/* ── The Kill Stack — the signature element ─────────────────────── */}
      <KillStack />

      {/* ── Health score ───────────────────────────────────────────────── */}
      <HealthScore
        score={healthScore}
        label={health.label}
        color={health.color}
        blurb={health.blurb}
      />

      {/* ── Supporting grid ────────────────────────────────────────────── */}
      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {/* Spend-pace gauge */}
        <Card>
          <CardContent className="p-5">
            <PaceGauge
              spend={spend}
              income={income}
              dayOfMonth={dayOfMonth}
              daysInMonth={daysInMonth}
            />
            {projectedNet != null ? (
              <div className="mt-4 pt-3 border-t border-border text-sm">
                <span className="text-muted-foreground">
                  At this rate you finish {monthName} at{" "}
                </span>
                <MoneyText
                  amount={projectedNet}
                  colored
                  signed
                  className="font-bold"
                />
                <span className="text-muted-foreground">
                  {projectedNet >= 0 ? " — keep it up. 😏" : " — pump the brakes. 🛑"}
                </span>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Daily spend heat */}
        <Card>
          <CardContent className="p-5">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium mb-3">
              Daily spend · last 14 days
            </div>
            <HeatStrip data={dailyHeat.vals} labels={dailyHeat.labels} height={28} />
            <div className="mt-2 text-xs text-muted-foreground">
              Darker = heavier day. Hover for the damage.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Forecast area — where the cash is headed */}
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
                <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="ccFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
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

      {/* Savings goal */}
      <SavingsGoal />

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {/* Spending personality */}
        {dash?.topCategories?.[0] ? (
          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="text-4xl leading-none shrink-0" aria-hidden>
                {persona.emoji}
              </div>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                  Your money type this month
                </div>
                <div className="text-lg font-bold tracking-tight">{persona.label}</div>
                <div className="text-sm text-muted-foreground">
                  Most of it went to{" "}
                  <span className="text-foreground font-medium">
                    {dash.topCategories[0].categoryName}
                  </span>{" "}
                  · {formatCurrency(Number(dash.topCategories[0].total) || 0)}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Biggest splurge this month */}
        {biggestSplurge ? (
          <Card>
            <CardContent className="p-5">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                Biggest splurge this month
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-bold truncate">{biggestSplurge.desc}</div>
                  <div className="text-xs text-muted-foreground">
                    {biggestSplurge.date}
                    {biggestSplurge.member ? ` · ${biggestSplurge.member}` : ""}
                  </div>
                </div>
                <MoneyText
                  amount={biggestSplurge.amt}
                  abs
                  className="text-2xl font-extrabold text-[hsl(var(--negative))] shrink-0"
                />
              </div>
              <div className="mt-1.5 text-sm text-muted-foreground">
                {-biggestSplurge.amt > 500
                  ? "Absolutely unhinged. 😳"
                  : -biggestSplurge.amt > 200
                    ? "Bold move. 😬"
                    : -biggestSplurge.amt > 100
                      ? "Noted. 👀"
                      : "Eh — we've seen worse from you two."}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* This vs last month */}
        {momCompare.pctChange != null ? (
          <Card>
            <CardContent className="p-5">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                Vs last month · same point
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                {momCompare.pctChange > 0 ? (
                  <TrendingUp className="w-5 h-5 text-[hsl(var(--negative))]" />
                ) : (
                  <TrendingDown className="w-5 h-5 text-emerald-500" />
                )}
                <span
                  className={cn(
                    "text-2xl font-bold tabular-nums",
                    momCompare.pctChange > 0
                      ? "text-[hsl(var(--negative))]"
                      : "text-emerald-500",
                  )}
                >
                  {momCompare.pctChange > 0 ? "+" : ""}
                  {Math.round(momCompare.pctChange)}%
                </span>
              </div>
              <div className="text-sm text-muted-foreground mt-0.5">
                {formatCurrency(momCompare.cur)} so far vs {formatCurrency(momCompare.last)} by
                this day last month —{" "}
                {momCompare.pctChange > 0
                  ? "spending faster, watch it. 👀"
                  : "spending less. Nice. 🟢"}
              </div>
              <div className="mt-3">
                <MiniBars
                  height={36}
                  data={[
                    { value: momCompare.last, label: `Last month: ${formatCurrency(momCompare.last)}`, color: "hsl(var(--muted-foreground))" },
                    {
                      value: momCompare.cur,
                      label: `This month: ${formatCurrency(momCompare.cur)}`,
                      color: momCompare.pctChange > 0 ? "hsl(var(--negative))" : "hsl(var(--positive))",
                    },
                  ]}
                />
                <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                  <span>Last</span>
                  <span>This</span>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Latest activity */}
        {(dash?.recentTransactions?.length ?? 0) > 0 ? (
          <Card>
            <CardContent className="p-5">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium mb-2">
                Latest activity
              </div>
              <div className="divide-y divide-border">
                {dash!.recentTransactions.slice(0, 5).map((t) => {
                  const a = Number(t.amount) || 0;
                  return (
                    <div key={t.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {t.description || "Transaction"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t.occurredOn}
                          {t.member ? ` · ${t.member}` : ""}
                        </div>
                      </div>
                      <MoneyText
                        amount={a}
                        signed
                        className={cn(
                          "text-sm font-semibold shrink-0",
                          a >= 0 ? "text-emerald-500" : "text-foreground",
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Category donut */}
        <CategoryDonut categories={dash?.topCategories ?? []} />

        {/* Him-vs-her scoreboard */}
        <SpendScoreboard entries={memberSpend} />

        {/* What's coming — next bills at a glance */}
        {(dash?.upcomingBills?.length ?? 0) > 0 ? (
          <Card>
            <CardContent className="p-5">
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium mb-2">
                What&apos;s coming
              </div>
              <div className="divide-y divide-border">
                {dash!.upcomingBills.slice(0, 5).map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{b.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {b.dayOfMonth ? `Around day ${b.dayOfMonth}` : b.frequency}
                      </div>
                    </div>
                    <MoneyText
                      amount={-Math.abs(Number(b.amount) || 0)}
                      className="text-sm font-semibold text-[hsl(var(--negative))]"
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {/* Badges + Wrapped */}
      <div className="flex flex-wrap items-center gap-2">
        {openStreak >= 2 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs font-bold text-amber-500">
            <Flame className="w-3.5 h-3.5" />
            {openStreak}-day check-in streak
          </span>
        ) : null}
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
            {streak.weeks} weeks {streak.direction === "under" ? "under budget" : "over budget"}
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

      <MonthlyWrapped open={wrappedOpen} onOpenChange={setWrappedOpen} dashboard={dash ?? null} />
    </div>
  );
}
