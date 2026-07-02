import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  CalendarRange,
  Zap,
} from "lucide-react";
import { SyncButton } from "@/components/sync-button";
import {
  useGetForecast,
  useGetDashboard,
  useGetAdvisorNudge,
  useGetSettings,
  useListTransactions,
  useListRecurringItems,
  useListCategories,
  useGetBudgetMonth,
  useUpdateTransaction,
  getGetBudgetMonthQueryKey,
  getListTransactionsQueryKey,
  getGetDashboardQueryKey,
  TransactionWeeklyBucket,
  type Transaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  weeklyBudgetStreak,
  isoDaysAgo,
  todayISO,
  currentWeekBounds,
} from "@/lib/weeklyStreak";
import {
  isSplurge,
  makeRecurringMatcher,
  merchantKey,
  recurringMerchantsFrom,
} from "@/lib/discretionarySpend";
import { CategoryDonut } from "@/components/category-donut";
import { HealthScore } from "@/components/health-score";
import { SavingsGoal } from "@/components/savings-goal";
import { DrillCard } from "@/components/drill-card";
import { StatTile, StatTileRow } from "@/components/stat-tile";
import { SpenderSpotlight } from "@/components/spender-spotlight";
import { WallOfShame } from "@/components/wall-of-shame";
import { SubscriptionInsightsSection } from "@/components/subscription-insights";
import { BankingInsights } from "@/components/banking-insights";
import { PillBadge } from "@/components/pill-badge";
import { Sparkline, StackBar, RingStat, HeatStrip, MiniBars, MoneyText } from "@/components/viz";
import { useUser } from "@clerk/react";
import { cn, formatCurrency } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { MonthlyWrapped } from "@/components/monthly-wrapped";
import { Confetti } from "@/components/confetti";
import { PaceGauge } from "@/components/pace-gauge";
import { SpendScoreboard } from "@/components/spend-scoreboard";

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

// The Banking area's sub-destinations. The global top nav is hidden on the
// landing, so this ribbon is how Chase / Amex / Budget / Allowance stay one
// tap away from Banking. Pill style matches the app's badge/pill language —
// no new card styles.
function greetingFor(hour: number): string {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Burning the midnight oil";
}

// ── Drill-panel plumbing ────────────────────────────────────────────────────
// The three mutually-exclusive allowance buckets a spend can live in. Mirrors
// /amex's setRowBucket: picking one sets its flag true and clears the other
// two in the SAME PATCH, so a txn can never sit in two buckets at once.
type BucketKey = "weekly" | "monthly" | "unplanned";
const BUCKET_OPTIONS: { key: BucketKey; label: string }[] = [
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "unplanned", label: "Unplanned" },
];

function currentBucket(
  t: Pick<Transaction, "weeklyAllowance" | "monthlyAllowance" | "unplannedAllowance">,
): "" | BucketKey {
  if (t.weeklyAllowance) return "weekly";
  if (t.monthlyAllowance) return "monthly";
  if (t.unplannedAllowance) return "unplanned";
  return "";
}

// Same category→weekly-sub-bucket default the Amex review flow uses, so a
// spend moved INTO Weekly from here lands in a sensible sub-bucket instead of
// always "misc".
function defaultWeeklyBucketFor(
  categoryName: string,
): (typeof TransactionWeeklyBucket)[keyof typeof TransactionWeeklyBucket] {
  const n = categoryName.toLowerCase();
  if (n.includes("grocer")) return TransactionWeeklyBucket.groceries;
  if (n.includes("dining") || n.includes("restaurant") || n.includes("food"))
    return TransactionWeeklyBucket.dining;
  if (n.includes("entertain")) return TransactionWeeklyBucket.entertainment;
  return TransactionWeeklyBucket.misc;
}

function formatTxnDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** One transaction inside the Week / Month / Unplanned drill panel:
 *  date · merchant · amount, plus the two re-file controls (category picker +
 *  bucket mover). Reuses the exact Select pattern from /allowances' TxnRow —
 *  no new control styles. */
function DrillTxnRow({
  t,
  categories,
  pending,
  onMoveBucket,
  onChangeCategory,
}: {
  t: Transaction;
  categories: { id: string; name: string }[];
  pending: boolean;
  onMoveBucket: (t: Transaction, bucket: BucketKey) => void;
  onChangeCategory: (t: Transaction, categoryId: string) => void;
}) {
  const bucket = currentBucket(t);
  return (
    <div
      className={cn("py-2.5", pending && "opacity-50 pointer-events-none")}
      data-testid={`cc-drill-txn-${t.id}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="w-12 shrink-0 text-[10px] uppercase tracking-widest text-muted-foreground tabular-nums">
            {formatTxnDate(t.occurredOn)}
          </span>
          <span className="truncate text-sm font-medium">
            {t.description || "Mystery charge"}
          </span>
        </div>
        <MoneyText
          amount={Number(t.amount) || 0}
          abs
          className="shrink-0 text-sm font-semibold tabular-nums"
        />
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-[3.75rem]">
        <Select
          value={bucket || undefined}
          onValueChange={(v) => onMoveBucket(t, v as BucketKey)}
        >
          <SelectTrigger
            className="h-7 w-[118px] text-xs"
            aria-label="Allowance bucket"
            data-testid={`cc-drill-bucket-${t.id}`}
          >
            <SelectValue placeholder="No bucket" />
          </SelectTrigger>
          <SelectContent>
            {BUCKET_OPTIONS.map((b) => (
              <SelectItem key={b.key} value={b.key} className="text-xs">
                {b.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={t.categoryId ?? undefined}
          onValueChange={(v) => onChangeCategory(t, v)}
        >
          <SelectTrigger
            className="h-7 min-w-[140px] flex-1 text-xs"
            aria-label="Category"
            data-testid={`cc-drill-category-${t.id}`}
          >
            <SelectValue placeholder="Uncategorized" />
          </SelectTrigger>
          <SelectContent>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/** Small ◀ ▶ pager chip used inside a StatTile label — matches the tile's
 *  on-gradient white styling; no new card style. */
function PeriodPager({
  icon,
  title,
  period,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: {
  icon: ReactNode;
  title: string;
  period: string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const btn =
    "flex h-6 w-6 items-center justify-center rounded-md bg-white/20 text-white transition hover:bg-white/30 disabled:opacity-30 disabled:cursor-not-allowed";
  return (
    <span className="flex items-center gap-2 normal-case tracking-normal">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-white/80">
        {icon}
        {title}
      </span>
      <span className="ml-auto flex items-center gap-1">
        {/* The tile around this pager is itself clickable (opens the drill),
            so the steppers stop propagation — ◀ ▶ only move the period. */}
        <button
          type="button"
          className={btn}
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          disabled={!canPrev}
          aria-label={`Previous ${title.toLowerCase()}`}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-[4.5rem] text-center text-[11px] font-semibold text-white/95">
          {period}
        </span>
        <button
          type="button"
          className={btn}
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          disabled={!canNext}
          aria-label={`Next ${title.toLowerCase()}`}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </span>
    </span>
  );
}

export default function CommandCenterPage() {
  const { data: forecast } = useGetForecast({ days: 90 });
  const { data: dash } = useGetDashboard();
  const { data: nudge } = useGetAdvisorNudge();
  const { data: settings } = useGetSettings();
  const { data: categories } = useListCategories();
  const nowRef = new Date();
  const { data: weeklyTxns } = useListTransactions({
    from: isoDaysAgo(nowRef, 90),
    to: todayISO(nowRef),
    // (#perf-3) Scoped to 90 days already; bound the cap (90 days won't reach
    // it for any realistic household).
    limit: 1000,
  });
  // Recurring item names feed the Spotlight / Wall of Shame so bills &
  // subscriptions are excluded — those roast surfaces want random splurges,
  // not the mortgage.
  const { data: recurringItemsData } = useListRecurringItems();
  // Current month's budget plan-vs-actual — feeds the four insight buckets
  // (under/over budget + spend-with-no-line). Same generated hook the Budget
  // page uses; slow-changing, so a generous staleTime.
  const currentMonthStart = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }, []);
  const { data: budgetMonth } = useGetBudgetMonth(currentMonthStart, {
    query: {
      queryKey: getGetBudgetMonthQueryKey(currentMonthStart),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    },
  });
  const recurringNames = useMemo(
    () => (recurringItemsData ?? []).map((r) => r.name),
    [recurringItemsData],
  );
  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);
  const [wrappedOpen, setWrappedOpen] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const [openStreak, setOpenStreak] = useState(0);
  // Period pickers for the two focal spend readouts. 0 = current period;
  // negative = back in time. Forward is capped at 0 (can't spend the future).
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  // Which drill panel is open (click a tile / the Unplanned strip), and which
  // row currently has a PATCH in flight (dimmed while saving).
  const [drill, setDrill] = useState<null | "week" | "month" | "unplanned">(null);
  const [pendingTxnId, setPendingTxnId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateTx = useUpdateTransaction();

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
  const paidThisMonth = dash ? Number(dash.paidThisMonth) : 0;
  const persona = moneyPersona(dash?.topCategories?.[0]?.categoryName);

  // The one, shared discretionary-spend definition for the focal readouts:
  // isSplurge() from lib/discretionarySpend — the SAME filter SpenderSpotlight /
  // WallOfShame use. It drops income, reimbursables, transfers, external card
  // payments, debt payments, bill/payment bank-noise, and any known recurring
  // merchant (so no double-counting of transfers/card payments). Returns the
  // absolute dollars spent for whichever txns pass the filter in a window.
  const isRecurring = useMemo(
    () => makeRecurringMatcher(recurringNames),
    [recurringNames],
  );
  const recurringMerchants = useMemo(
    () => recurringMerchantsFrom(weeklyTxns ?? []),
    [weeklyTxns],
  );
  // The txns behind the number: the drill panel lists EXACTLY this set, so
  // its rows always sum to what the tile shows (same filter, same window).
  const discretionaryTxnsInWindow = useMemo(() => {
    return (startISO: string, endISO: string): Transaction[] => {
      const out: Transaction[] = [];
      for (const t of weeklyTxns ?? []) {
        if (!t.occurredOn || t.occurredOn < startISO || t.occurredOn > endISO)
          continue;
        if (!isSplurge(t, isRecurring)) continue;
        if (recurringMerchants.has(merchantKey(t.description ?? ""))) continue;
        out.push(t);
      }
      return out;
    };
  }, [weeklyTxns, isRecurring, recurringMerchants]);
  const discretionaryInWindow = useMemo(() => {
    return (startISO: string, endISO: string) =>
      discretionaryTxnsInWindow(startISO, endISO).reduce(
        (s, t) => s + -(Number(t.amount) || 0),
        0,
      );
  }, [discretionaryTxnsInWindow]);

  // Earliest ISO date we actually have transactions for (query fetched 90 days).
  // Used to disable the ◀ button once a period would fall outside the window.
  const earliestFetchedISO = isoDaysAgo(now, 90);

  // ── A) Selected WEEK (Sun–Sat) discretionary spend ─────────────────────────
  const weekView = useMemo(() => {
    const base = currentWeekBounds(now);
    const baseSun = new Date(`${base.startISO}T00:00:00`);
    const sun = new Date(baseSun);
    sun.setDate(sun.getDate() + weekOffset * 7);
    const sat = new Date(sun);
    sat.setDate(sat.getDate() + 6);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startISO = iso(sun);
    const endISO = iso(sat);
    const spend = discretionaryInWindow(startISO, endISO);
    // Weekly cap: per-week override, else the standing weekly allowance.
    const override = settings?.preferences?.weeklyAllowanceOverrides?.[startISO];
    const cap =
      override != null
        ? Number(override)
        : Number(settings?.weeklyAllowanceAmount) || 0;
    // Full "Jul 6–12" range (month repeated across a month boundary) — used
    // for the drill-panel title even when the short label says "This week".
    const range = `${sun.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${sat.toLocaleDateString(
      "en-US",
      {
        month: sun.getMonth() === sat.getMonth() ? undefined : "short",
        day: "numeric",
      },
    )}`;
    const label = weekOffset === 0 ? "This week" : range;
    // ◀ disabled once the window starts before what we fetched.
    const canPrev = startISO >= earliestFetchedISO;
    return { spend, cap, label, range, canPrev, startISO, endISO };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOffset, discretionaryInWindow, settings]);

  // ── B) Selected calendar MONTH discretionary spend ─────────────────────────
  const monthView = useMemo(() => {
    const m = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startISO = iso(m);
    const end = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    const endISO = iso(end);
    const spend = discretionaryInWindow(startISO, endISO);
    const name = m.toLocaleDateString("en-US", {
      month: "long",
      year: m.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
    const label = monthOffset === 0 ? "This month" : name;
    const canPrev = endISO >= earliestFetchedISO;
    return { spend, label, name, canPrev, startISO, endISO };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthOffset, discretionaryInWindow]);

  // ── C) Unplanned-allowance spend, CURRENT month — the bucket that was
  //      invisible from Banking. Sums the txns flagged `unplannedAllowance`
  //      (the same flag /allowances uses) against the unplanned cap. ───────
  const unplannedView = useMemo(() => {
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const txns: Transaction[] = [];
    let spendSum = 0;
    for (const t of weeklyTxns ?? []) {
      if (!t.unplannedAllowance) continue;
      if (!t.occurredOn?.startsWith(ym)) continue;
      const a = Number(t.amount) || 0;
      if (a >= 0) continue;
      txns.push(t);
      spendSum += -a;
    }
    const cap = Number(settings?.unplannedAllowanceAmount) || 0;
    return { txns, spend: spendSum, cap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeklyTxns, settings]);

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
        color: "hsl(var(--positive))",
        label: "Thriving",
        blurb: "You two are running this like pros. Don't get cocky.",
      };
    if (s >= 60)
      return {
        color: "hsl(var(--primary))",
        label: "Solid",
        blurb: "Good shape — a couple tweaks and you're untouchable.",
      };
    if (s >= 40)
      return {
        color: "hsl(var(--warning))",
        label: "Shaky",
        blurb: "Wobbling. Tighten the spend before it bites — small cuts, big payoff.",
      };
    return {
      color: "hsl(var(--negative))",
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

  // ── Drill-panel edits — one PATCH via the generated useUpdateTransaction,
  //    then invalidate every reader of this data so tiles, list, insights and
  //    the budget buckets all repaint from the server's truth. ─────────────
  const invalidateAfterTxnEdit = () => {
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetBudgetMonthQueryKey(currentMonthStart),
    });
  };

  // Move a spend between the Weekly / Monthly / Unplanned buckets. Mirrors
  // /amex's setRowBucket: the chosen flag goes true and the other two go
  // false in the SAME PATCH (mutual exclusivity is enforced by the payload),
  // weeklyBucket is kept/derived when entering Weekly and cleared otherwise,
  // and picking a bucket counts as reviewing the row (#615).
  const moveBucket = async (t: Transaction, bucket: BucketKey) => {
    if (currentBucket(t) === bucket) return;
    const wb =
      bucket === "weekly"
        ? (t.weeklyBucket ??
          defaultWeeklyBucketFor(catNameById.get(t.categoryId ?? "") ?? ""))
        : null;
    setPendingTxnId(t.id);
    try {
      await updateTx.mutateAsync({
        id: t.id,
        data: {
          weeklyAllowance: bucket === "weekly",
          monthlyAllowance: bucket === "monthly",
          unplannedAllowance: bucket === "unplanned",
          weeklyBucket: wb,
          reviewed: true,
        },
      });
      invalidateAfterTxnEdit();
      toast({
        title: `Filed under ${BUCKET_OPTIONS.find((b) => b.key === bucket)?.label ?? bucket}`,
      });
    } catch (e) {
      toast({
        title: "Couldn't move it",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setPendingTxnId(null);
    }
  };

  // Recategorize straight from the drill — same PATCH shape as /allowances.
  const changeCategory = async (t: Transaction, categoryId: string) => {
    if ((t.categoryId ?? "") === categoryId) return;
    setPendingTxnId(t.id);
    try {
      await updateTx.mutateAsync({ id: t.id, data: { categoryId } });
      invalidateAfterTxnEdit();
      toast({ title: "Recategorized" });
    } catch (e) {
      toast({
        title: "Couldn't recategorize",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setPendingTxnId(null);
    }
  };

  // What the open drill shows. Week/Month list the EXACT set the tile summed
  // (discretionaryTxnsInWindow over the same window), so rows always tie to
  // the tile's number. Unplanned lists the flagged-unplanned txns behind the
  // strip. Newest first.
  const drillData = useMemo(() => {
    if (!drill) return null;
    const newestFirst = (a: Transaction, b: Transaction) =>
      b.occurredOn.localeCompare(a.occurredOn);
    if (drill === "week" || drill === "month") {
      const v = drill === "week" ? weekView : monthView;
      const txns = discretionaryTxnsInWindow(v.startISO, v.endISO).sort(newestFirst);
      const total = txns.reduce((s, t) => s + -(Number(t.amount) || 0), 0);
      const title =
        drill === "week"
          ? weekOffset === 0
            ? `This week · ${weekView.range}`
            : `Week of ${weekView.range}`
          : monthOffset === 0
            ? `This month · ${monthView.name}`
            : monthView.name;
      return {
        title,
        txns,
        total,
        blurb:
          "the exact list behind that tile. Re-file the liars — don't just admire them.",
      };
    }
    return {
      title: `Unplanned · ${monthName}`,
      txns: [...unplannedView.txns].sort(newestFirst),
      total: unplannedView.spend,
      blurb: "the “it's just this once” pile. It's never just once.",
    };
  }, [
    drill,
    weekView,
    monthView,
    unplannedView,
    discretionaryTxnsInWindow,
    weekOffset,
    monthOffset,
    monthName,
  ]);

  const badges = useMemo(() => {
    const out: { icon: typeof Trophy; label: string }[] = [];
    if (netMonth != null && netMonth > 0)
      out.push({ icon: TrendingUp, label: "In the black" });
    if (weekView.cap > 0 && weekView.spend <= weekView.cap)
      out.push({ icon: Trophy, label: "Under the weekly cap" });
    if (income > 0 && spend > 0 && spend < income * 0.8)
      out.push({ icon: PiggyBank, label: "Under 80% spend" });
    if (lowPoint != null && lowPoint > 0)
      out.push({ icon: Flame, label: "Stays in the green" });
    return out;
  }, [netMonth, income, spend, lowPoint, weekView]);

  const nudgeMsg = nudge?.enabled && nudge.message ? nudge.message : null;
  const sevColor =
    nudge?.severity === "alert"
      ? "text-[hsl(var(--negative))]"
      : nudge?.severity === "warn"
        ? "text-warning"
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

  const cashNow =
    forecast?.bankSnapshot?.balance != null ? Number(forecast.bankSnapshot.balance) : null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <Confetti fire={celebrate} />

      {/* ── At-a-glance StatTile row — the "how are we spending, right now"
             focal readouts (week + month, navigable) plus cash & net. ─────── */}
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
        {greeting}, {who} — here&rsquo;s the damage
      </div>
      <StatTileRow>
        {/* A) This week (Sun–Sat) discretionary spend, ◀ ▶ to cycle weeks.
            The whole tile is a drill target (opens the txn list behind the
            number) — a div[role=button] wrapper so the pager's real <button>s
            stay valid HTML inside it. Tones are set explicitly because the
            wrapper hides these from StatTileRow's auto-rotation. */}
        <div
          role="button"
          tabIndex={0}
          aria-label="See every transaction behind this week's spend"
          className="h-full cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setDrill("week")}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setDrill("week");
            }
          }}
          data-testid="cc-week-tile"
        >
          <StatTile
            active
            tone={0}
            label={
              <PeriodPager
                icon={<CalendarDays className="w-3.5 h-3.5" />}
                title="Week"
                period={weekView.label}
                onPrev={() => setWeekOffset((o) => o - 1)}
                onNext={() => setWeekOffset((o) => Math.min(0, o + 1))}
                canPrev={weekView.canPrev}
                canNext={weekOffset < 0}
              />
            }
            value={<MoneyText amount={weekView.spend} />}
            sub={
              weekView.cap > 0 ? (
                <span
                  className={
                    weekView.spend > weekView.cap
                      ? "text-[hsl(var(--negative))]"
                      : "text-[hsl(var(--positive))]"
                  }
                >
                  {weekView.spend > weekView.cap
                    ? `${formatCurrency(weekView.spend - weekView.cap)} over the ${formatCurrency(weekView.cap)} cap`
                    : `${formatCurrency(weekView.cap - weekView.spend)} left of ${formatCurrency(weekView.cap)}`}
                </span>
              ) : (
                "spent, no cap set"
              )
            }
          />
        </div>
        {/* B) Selected calendar month discretionary spend, ◀ ▶ to cycle months.
            Same click-to-drill treatment as the week tile. */}
        <div
          role="button"
          tabIndex={0}
          aria-label="See every transaction behind this month's spend"
          className="h-full cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setDrill("month")}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setDrill("month");
            }
          }}
          data-testid="cc-month-tile"
        >
          <StatTile
            tone={1}
            label={
              <PeriodPager
                icon={<CalendarRange className="w-3.5 h-3.5" />}
                title="Month"
                period={monthView.label}
                onPrev={() => setMonthOffset((o) => o - 1)}
                onNext={() => setMonthOffset((o) => Math.min(0, o + 1))}
                canPrev={monthView.canPrev}
                canNext={monthOffset < 0}
              />
            }
            value={<MoneyText amount={monthView.spend} />}
            sub="discretionary spend · tap to drill"
          />
        </div>
        <StatTile
          tone={2}
          icon={<PiggyBank className="w-4 h-4" />}
          label="Cash on hand"
          value={cashNow != null ? <MoneyText amount={cashNow} /> : "—"}
          sub={forecast?.bankSnapshot?.name ?? "Checking"}
          href="/transactions"
        />
        <StatTile
          tone={3}
          icon={netMonth != null && netMonth < 0 ? <TrendingDown className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}
          label="Net this month"
          value={netMonth != null ? <MoneyText amount={netMonth} colored signed /> : "—"}
          sub={dash ? `${formatCurrency(income)} in · ${formatCurrency(spend)} out` : undefined}
          href="/reports"
        />
      </StatTileRow>

      {/* ── Unplanned, this month — the bucket that used to be invisible from
             Banking. Slim strip (a 5th tile would crowd the row); same
             over/under cap styling as the Week tile; click to drill. ─────── */}
      <button
        type="button"
        onClick={() => setDrill("unplanned")}
        className="block w-full text-left"
        data-testid="cc-unplanned-strip"
      >
        <Card className="transition-colors hover:border-primary/40">
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              <Zap className="h-3.5 w-3.5 text-warning" />
              Unplanned · {monthName}
            </span>
            <MoneyText
              amount={unplannedView.spend}
              className="text-base font-bold tabular-nums"
            />
            <span className="text-xs">
              {unplannedView.cap > 0 ? (
                <span
                  className={
                    unplannedView.spend > unplannedView.cap
                      ? "text-[hsl(var(--negative))]"
                      : "text-[hsl(var(--positive))]"
                  }
                >
                  {unplannedView.spend > unplannedView.cap
                    ? `${formatCurrency(unplannedView.spend - unplannedView.cap)} over the ${formatCurrency(unplannedView.cap)} cap`
                    : `${formatCurrency(unplannedView.cap - unplannedView.spend)} left of ${formatCurrency(unplannedView.cap)}`}
                </span>
              ) : (
                <span className="text-muted-foreground">spent, no cap set</span>
              )}
            </span>
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
              the &ldquo;just this once&rdquo; pile
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </CardContent>
        </Card>
      </button>

      {/* ── Advisor nudge + sync (kept, debt copy stripped) ─────────────── */}
      <Card className="focus-glow">
        <CardContent className="p-5 md:p-6 flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex items-start gap-2 min-w-0 flex-1">
            <Sparkles className={cn("w-4 h-4 mt-0.5 shrink-0", sevColor)} />
            <p className={cn("text-sm font-medium leading-snug", sevColor)}>
              {nudgeMsg ?? "Pull a sync and I'll tell you how you're really doing."}
            </p>
          </div>
          <div className="shrink-0">
            <SyncButton />
          </div>
        </CardContent>
      </Card>

      {/* ── The four insight buckets — going well / could improve / cancel /
             paying-for-but-not-budgeted. Numbers computed here from data the
             page already loads; AI writes only the captions. ─────────────── */}
      <BankingInsights
        budgetMonth={budgetMonth}
        topCategories={dash?.topCategories}
        txns={weeklyTxns}
        recurringNames={recurringNames}
        catNameById={catNameById}
        momCompare={momCompare}
        streak={streak}
      />

      {/* ── What to CANCEL — auto-detected recurring subscriptions ───────── */}
      <SubscriptionInsightsSection
        recurringItems={recurringItemsData}
        txns={weeklyTxns}
        catNameById={catNameById}
      />

      {/* ── What to STOP BUYING — the roasts ─────────────────────────────── */}
      <SpenderSpotlight transactions={weeklyTxns ?? []} recurringNames={recurringNames} />
      <WallOfShame transactions={weeklyTxns ?? []} recurringNames={recurringNames} />

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
          value="Cards"
          sub="statements & spend"
          visual={
            <div className="flex items-center gap-1.5">
              {["blue", "silver"].map((b) => (
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
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                  Vs last month · same point
                </div>
                <PillBadge tone={momCompare.pctChange > 0 ? "danger" : "good"}>
                  {momCompare.pctChange > 0 ? "Spending faster" : "On track"}
                </PillBadge>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                {momCompare.pctChange > 0 ? (
                  <TrendingUp className="w-5 h-5 text-[hsl(var(--negative))]" />
                ) : (
                  <TrendingDown className="w-5 h-5 text-positive" />
                )}
                <span
                  className={cn(
                    "text-2xl font-bold tabular-nums",
                    momCompare.pctChange > 0
                      ? "text-[hsl(var(--negative))]"
                      : "text-positive",
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
                          a >= 0 ? "text-positive" : "text-foreground",
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
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--chart-3))]/30 bg-[hsl(var(--chart-3))]/10 px-3 py-1.5 text-xs font-bold text-[hsl(var(--chart-3))]">
            <Flame className="w-3.5 h-3.5" />
            {openStreak}-day check-in streak
          </span>
        ) : null}
        {streak.weeks >= 2 ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold border",
              streak.direction === "under"
                ? "bg-positive/15 text-positive border-positive/30"
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

      {/* ── The drill panel — every txn behind the clicked tile/strip, with
             per-row recategorize + bucket-move. The list is the SAME set the
             tile summed, so the header total always matches the tile. ────── */}
      <Dialog
        open={drill != null}
        onOpenChange={(o) => {
          if (!o) setDrill(null);
        }}
      >
        <DialogContent className="max-w-2xl" data-testid="cc-drill-dialog">
          {drillData ? (
            <>
              <DialogHeader>
                <DialogTitle>{drillData.title}</DialogTitle>
                <DialogDescription>
                  {drillData.txns.length === 0 ? (
                    "Nothing in here. Suspiciously well-behaved."
                  ) : (
                    <>
                      <span className="font-semibold text-foreground">
                        {drillData.txns.length}
                      </span>{" "}
                      hit{drillData.txns.length === 1 ? "" : "s"} ·{" "}
                      <span className="font-semibold text-foreground tabular-nums">
                        {formatCurrency(drillData.total)}
                      </span>{" "}
                      — {drillData.blurb}
                    </>
                  )}
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[60vh] divide-y divide-border overflow-y-auto pr-1">
                {drillData.txns.map((t) => (
                  <DrillTxnRow
                    key={t.id}
                    t={t}
                    categories={categories ?? []}
                    pending={pendingTxnId === t.id}
                    onMoveBucket={moveBucket}
                    onChangeCategory={changeCategory}
                  />
                ))}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
