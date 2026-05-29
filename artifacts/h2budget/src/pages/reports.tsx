import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListTransactions,
  useGetBudgetMonth,
  useListCategories,
  useListDebts,
  useListDebtBalanceHistory,
  useGetAvalancheSettings,
  useGetAvalancheExtra,
  useListRecurringItems,
  useGetForecast,
  useGetForecastCashSignal,
  useGetDashboard,
  useGetSettings,
  useGetReportsAdvisorSummary,
  getReportsAdvisorSummary,
  getGetReportsAdvisorSummaryQueryKey,
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
  useUpdateTransaction,
  getListTransactionsQueryKey,
  type Transaction,
  type ForecastBundle,
  type RecurringItem,
  type DebtBalanceHistoryEntry,
  type GetReportsAdvisorSummaryParams,
  type GetReportsAdvisorSummaryTab,
  type SpendingFacts,
  type SpendingFactsUncategorizedSampleMerchantsItem,
} from "@workspace/api-client-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CategoryPicker } from "@/components/category-picker";
import { useToast } from "@/hooks/use-toast";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import {
  resolveAmexRevolvingBalance,
  cashBufferStatusMeta,
  type CashSignalStatus,
} from "@/lib/reportsBalances";
import {
  DEFAULT_DAYS_SINCE_TRACKERS,
  compileMatcher,
  type DaysSinceTracker,
} from "@/lib/daysSinceTrackers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatCurrency, cn } from "@/lib/utils";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveContainer,
  LineChart,
  Line as LineRaw,
  AreaChart,
  Area as AreaRaw,
  BarChart,
  Bar as BarRaw,
  ComposedChart,
  XAxis as XAxisRaw,
  YAxis as YAxisRaw,
  CartesianGrid,
  Tooltip as TooltipRaw,
  Legend as LegendRaw,
  PieChart,
  Pie as PieRaw,
  Cell,
  PolarAngleAxis as PolarAngleAxisRaw,
  PolarGrid,
  PolarRadiusAxis as PolarRadiusAxisRaw,
  Radar as RadarRaw,
  RadarChart,
  ReferenceLine as ReferenceLineRaw,
  type AreaProps,
  type BarProps,
  type LegendProps,
  type LineProps,
  type PieProps,
  type PolarAngleAxisProps,
  type PolarRadiusAxisProps,
  type RadarProps,
  type ReferenceLineProps,
  type TooltipProps,
  type XAxisProps,
  type YAxisProps,
} from "recharts";

// Recharts ships these as class components, which TypeScript + React 19's
// @types/react can no longer accept as JSX element constructors. Re-bind each
// to a function-component shape that preserves the component's own prop type.
type FCFromProps<P> = (props: P) => React.ReactElement | null;
const Line = LineRaw as unknown as FCFromProps<LineProps>;
const Area = AreaRaw as unknown as FCFromProps<AreaProps>;
const Bar = BarRaw as unknown as FCFromProps<BarProps>;
const XAxis = XAxisRaw as unknown as FCFromProps<XAxisProps>;
const YAxis = YAxisRaw as unknown as FCFromProps<YAxisProps>;
const Tooltip = TooltipRaw as unknown as FCFromProps<TooltipProps<number, string>>;
const Legend = LegendRaw as unknown as FCFromProps<LegendProps>;
const Pie = PieRaw as unknown as FCFromProps<PieProps>;
const PolarAngleAxis = PolarAngleAxisRaw as unknown as FCFromProps<PolarAngleAxisProps>;
const PolarRadiusAxis = PolarRadiusAxisRaw as unknown as FCFromProps<PolarRadiusAxisProps>;
const Radar = RadarRaw as unknown as FCFromProps<RadarProps>;
const ReferenceLine = ReferenceLineRaw as unknown as FCFromProps<ReferenceLineProps>;
import confetti from "canvas-confetti";
import {
  Trophy,
  Flame,
  Calendar,
  TrendingUp,
  TrendingDown,
  PiggyBank,
  CreditCard,
  Sparkles,
  RefreshCcw,
  Loader2,
  Wand2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  H2_PALETTE,
  CHART_SERIES,
  fmtISO,
  fmtMonthLabel,
  dailyCashFlow,
  rollupByPeriod,
  withRunningNet,
  rolling30DayBurn,
  cashFlowKpis,
  categoryTotals,
  spendingHeatmap,
  dayOfWeekSpend,
  topMerchants,
  categoryMonthlyTrends,
  reimbursableSplit,
  budgetVariance,
  budgetBurndown,
  budgetConsistencyHeatmap,
  debtToSim,
  payoffStackedSeries,
  snowballWaterfall,
  interestVsPrincipal,
  perDebtProgress,
  totalPaidOffSoFar,
  totalBalanceHistory,
  daysSinceLast,
  spendByDayOfMonth,
  hourlySpendClock,
  biggest,
  noPurchaseStreak,
  personalityRadar,
  debtsKilledOrder,
  debtFreeCountdown,
  totalsForDebts,
  simulate,
  interestIfMinimumsOnly,
  perCategoryBurndown,
  onTrackMonthStreak,
  underBudgetMonthStreak,
  payoffProjectionGauge,
} from "@/lib/reportsAnalytics";

const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
];

function fireMilestoneConfetti() {
  const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };
  confetti({ ...defaults, particleCount: 80, origin: { x: 0.3, y: 0.4 } });
  confetti({ ...defaults, particleCount: 80, origin: { x: 0.7, y: 0.4 } });
}

// --- Small visual building blocks -----------------------------------------

function HeroTile({
  label,
  value,
  sub,
  tone = "default",
  icon,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "bad" | "amber";
  icon?: React.ReactNode;
  delta?: { pct: number; goodIfUp: boolean } | null;
}) {
  const toneClass =
    tone === "good"
      ? "text-[hsl(var(--positive))]"
      : tone === "bad"
        ? "text-[hsl(var(--negative))]"
        : tone === "amber"
          ? "text-[hsl(var(--warning))]"
          : "text-foreground";
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </div>
          {icon && <div className="text-muted-foreground/70">{icon}</div>}
        </div>
        <div
          className={cn(
            "text-3xl md:text-4xl font-serif font-bold tabular-nums mt-2",
            toneClass,
          )}
        >
          {value}
        </div>
        {sub && (
          <div className="text-xs text-muted-foreground mt-1">{sub}</div>
        )}
        {delta && Number.isFinite(delta.pct) && (
          <div
            className={cn(
              "text-[11px] mt-1 tabular-nums font-medium",
              (delta.pct >= 0) === delta.goodIfUp
                ? "text-[hsl(var(--positive))]"
                : "text-[hsl(var(--negative))]",
            )}
          >
            {delta.pct >= 0 ? "▲" : "▼"} {Math.abs(delta.pct).toFixed(1)}% vs prev
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SectionHeader({
  eyebrow,
  title,
  blurb,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        {eyebrow}
      </div>
      <h2 className="text-2xl md:text-3xl font-serif font-bold tracking-tight">
        {title}
      </h2>
      <p className="text-sm text-muted-foreground italic">{blurb}</p>
    </div>
  );
}

function ChartCard({
  title,
  caption,
  empty,
  hideWhenEmpty,
  children,
  height = 320,
}: {
  title: string;
  caption?: string;
  empty?: string | null;
  hideWhenEmpty?: boolean;
  children: React.ReactNode;
  height?: number;
}) {
  if (empty && hideWhenEmpty) return null;
  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-serif">{title}</CardTitle>
        {caption && (
          <p className="text-xs text-muted-foreground">{caption}</p>
        )}
      </CardHeader>
      <CardContent>
        {empty ? (
          <div
            className="flex items-center justify-center text-sm text-muted-foreground"
            style={{ height }}
          >
            {empty}
          </div>
        ) : (
          <div style={{ height }}>{children}</div>
        )}
      </CardContent>
    </Card>
  );
}

function tooltipMoney(v: number | string) {
  return formatCurrency(v);
}

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--card-border))",
  color: "hsl(var(--card-foreground))",
  borderRadius: 8,
  fontSize: 12,
  boxShadow: "var(--shadow-md)",
};

// --------------------------------------------------------------------------
// MAIN PAGE
// --------------------------------------------------------------------------

// (Play B) Per-tab Claude narrative. Reuses the deterministic facts +
// 3-layer fallback advisor pattern from the Weekly Debrief / Avalanche
// cards. Cached server-side per tab; the refresh button forces a fresh
// Anthropic regeneration.
function AdvisorSummaryCard({
  tab,
  rangeDays,
  monthOffset,
}: {
  tab: GetReportsAdvisorSummaryTab;
  rangeDays: number;
  monthOffset: number;
}) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const params: GetReportsAdvisorSummaryParams = useMemo(
    () => ({ tab, rangeDays, monthOffset }),
    [tab, rangeDays, monthOffset],
  );
  const { data, isLoading } = useGetReportsAdvisorSummary(params);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await getReportsAdvisorSummary({ ...params, refresh: "true" });
      queryClient.setQueryData(getGetReportsAdvisorSummaryQueryKey(params), fresh);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card data-testid={`card-advisor-${tab}`} className="border-primary/20 bg-primary/[0.03]">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            What this means
            {data?.summarySource === "fallback" && (
              <Badge variant="outline" className="text-[10px] font-normal">
                template
              </Badge>
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || isLoading}
            data-testid={`button-advisor-refresh-${tab}`}
            title="Regenerate"
          >
            {refreshing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !data ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Reading your numbers…
          </p>
        ) : (
          <>
            <p
              className="text-sm font-semibold leading-snug"
              data-testid={`text-advisor-headline-${tab}`}
            >
              {data.headline}
            </p>
            {data.bullets.length > 0 && (
              <ul className="text-sm space-y-1 list-disc pl-5 text-foreground/90">
                {data.bullets.map((b, i) => (
                  <li key={i} data-testid={`text-advisor-bullet-${tab}-${i}`}>
                    {b}
                  </li>
                ))}
              </ul>
            )}
            <span className="text-xs text-muted-foreground block pt-1">
              Generated {new Date(data.generatedAt).toLocaleString()}
            </span>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// (Play B) Four at-a-glance balance tiles inherited from the retired
// Dashboard, surfaced above the Reports range controls so the page
// opens with the household's live financial vitals.
function ReportsBalanceTiles({
  forecast,
  debts,
}: {
  forecast: ForecastBundle | null | undefined;
  debts: import("@workspace/api-client-react").Debt[] | undefined;
}) {
  const { data: dashboard } = useGetDashboard();
  const { data: cashSignal } = useGetForecastCashSignal();

  const bankSnapshot = forecast?.bankSnapshot ?? null;
  const accountSnapshots = forecast?.accountSnapshots ?? {};
  const plaidCheckingAccounts = forecast?.plaidCheckingAccounts ?? [];
  const effective = useMemo(
    () =>
      deriveEffectiveSnapshot({
        bankSnapshot,
        accountSnapshots,
        selectedAccountInternalId: bankSnapshot?.accountId ?? null,
        plaidCheckingAccounts,
      }),
    [bankSnapshot, accountSnapshots, plaidCheckingAccounts],
  );

  const bankValue = effective ? formatCurrency(effective.balance) : "—";
  const bankSub = effective
    ? `${effective.source === "plaid" ? "Plaid" : "Manual"} · ${effective.name ?? "Bank"}${effective.mask ? ` ··${effective.mask}` : ""}`
    : "No checking snapshot yet";

  const amex = useMemo(() => resolveAmexRevolvingBalance(debts), [debts]);
  const amexValue = amex.found ? formatCurrency(amex.total) : "—";
  const amexSub =
    amex.found && amex.availableCount === 1
      ? "Blue Cash 1006 + Platinum 1009 (1 card unavailable)"
      : "Blue Cash 1006 + Platinum 1009";

  const totalDebtValue =
    dashboard != null ? formatCurrency(dashboard.totalDebt) : "—";
  const activeDebtCount = dashboard?.activeDebtCount ?? 0;
  const totalDebtSub =
    dashboard != null
      ? `${activeDebtCount} active debt${activeDebtCount === 1 ? "" : "s"}`
      : "Across active debts";

  const status = (cashSignal?.status ?? "no_data") as CashSignalStatus;
  const statusMeta = cashBufferStatusMeta(status);
  const buffer = Number(cashSignal?.cashBuffer ?? 0) || 0;
  const lowest = Number(cashSignal?.lowestProjected ?? 0) || 0;
  const cashSub =
    status === "no_data"
      ? "Set a checking balance on Forecast"
      : `Lowest ${formatCurrency(lowest)} · buffer ${formatCurrency(buffer)}`;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <HeroTile
        label="Bank Balance"
        value={bankValue}
        sub={bankSub}
        icon={<PiggyBank className="w-4 h-4" />}
      />
      <HeroTile
        label="Amex (Blue Cash + Platinum)"
        value={amexValue}
        sub={amexSub}
        tone={amex.found && amex.total > 0 ? "bad" : "default"}
        icon={<CreditCard className="w-4 h-4" />}
      />
      <HeroTile
        label="Total Debt"
        value={totalDebtValue}
        sub={totalDebtSub}
        tone={dashboard != null && Number(dashboard.totalDebt) > 0 ? "bad" : "default"}
        icon={<TrendingDown className="w-4 h-4" />}
      />
      <HeroTile
        label="Cash Buffer Status"
        value={statusMeta.label}
        sub={cashSub}
        tone={statusMeta.tone}
        icon={<PiggyBank className="w-4 h-4" />}
      />
    </div>
  );
}

export default function ReportsPage() {
  const today = useMemo(() => new Date(), []);
  const [rangeDays, setRangeDays] = useState("30");
  const [monthOffset, setMonthOffset] = useState("0");
  const [compareToPrev, setCompareToPrev] = useState(false);

  const fromDate = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - Number(rangeDays));
    return d;
  }, [today, rangeDays]);
  const prevFromDate = useMemo(() => {
    const d = new Date(fromDate);
    d.setDate(d.getDate() - Number(rangeDays));
    return d;
  }, [fromDate, rangeDays]);

  // Pull a year of transactions so spending heatmap, sparklines, etc. work.
  const yearAgo = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 365);
    return d;
  }, [today]);

  const { data: txns, isLoading: txnsLoading } = useListTransactions({
    from: fmtISO(yearAgo),
    limit: 5000,
  });
  const { data: categories } = useListCategories();
  const { data: debts } = useListDebts();
  const { data: debtBalanceHistory } = useListDebtBalanceHistory();
  const { data: avSettings } = useGetAvalancheSettings();
  const { data: avExtra } = useGetAvalancheExtra();
  const { data: recurringItems } = useListRecurringItems();
  const { data: forecast } = useGetForecast({ days: 90 });
  const { data: settings } = useGetSettings();
  const daysSinceTrackers = useMemo<DaysSinceTracker[]>(() => {
    const stored = (settings?.preferences as { daysSinceTrackers?: DaysSinceTracker[] } | null)
      ?.daysSinceTrackers;
    return Array.isArray(stored) ? stored : [...DEFAULT_DAYS_SINCE_TRACKERS];
  }, [settings]);

  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

  // (#624) IDs of system-managed `excludeFromBudget` categories
  // (Uncategorized, Transfer, Ignore). Passed into the Reports
  // analytics helpers so transactions tagged with one of these never
  // contribute to the category breakdown or the daily cash-flow chart.
  // Picking Ignore on a row is the new way for users to drop a
  // transaction from every roll-up here while still letting it count
  // toward account balances.
  const excludedCategoryIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of categories ?? []) {
      if (c.excludeFromBudget) s.add(c.id);
    }
    return s;
  }, [categories]);

  // Range-filtered transactions for cash flow/spending tabs.
  const rangeTxns = useMemo(() => {
    if (!txns) return [];
    const fromIso = fmtISO(fromDate);
    return txns.filter((t) => t.occurredOn >= fromIso);
  }, [txns, fromDate]);
  const prevRangeTxns = useMemo(() => {
    if (!txns) return [];
    const prevFromIso = fmtISO(prevFromDate);
    const fromIso = fmtISO(fromDate);
    return txns.filter((t) => t.occurredOn >= prevFromIso && t.occurredOn < fromIso);
  }, [txns, prevFromDate, fromDate]);

  // Selected month for budget tab.
  const budgetMonthStart = useMemo(() => {
    const d = new Date(today.getFullYear(), today.getMonth() - Number(monthOffset), 1);
    return fmtISO(d);
  }, [today, monthOffset]);
  const { data: budgetCurr } = useGetBudgetMonth(budgetMonthStart);

  // Last 6 months for budget consistency heatmap + under-budget streak.
  const monthStarts = useMemo(() => {
    const arr: string[] = [];
    for (let i = 5; i >= 0; i--) {
      arr.push(fmtISO(new Date(today.getFullYear(), today.getMonth() - i, 1)));
    }
    return arr;
  }, [today]);
  const monthKeys = useMemo(() => monthStarts.map((s) => s.slice(0, 7)), [monthStarts]);
  const { data: budgetM5 } = useGetBudgetMonth(monthStarts[0]);
  const { data: budgetM4 } = useGetBudgetMonth(monthStarts[1]);
  const { data: budgetM3 } = useGetBudgetMonth(monthStarts[2]);
  const { data: budgetM2 } = useGetBudgetMonth(monthStarts[3]);
  const { data: budgetM1 } = useGetBudgetMonth(monthStarts[4]);
  const { data: budgetCurrMonth } = useGetBudgetMonth(monthStarts[5]);
  const budgetTimeline = useMemo(
    () => [budgetM5, budgetM4, budgetM3, budgetM2, budgetM1, budgetCurrMonth],
    [budgetM5, budgetM4, budgetM3, budgetM2, budgetM1, budgetCurrMonth],
  );

  if (txnsLoading) {
    return null;
  }

  return (
    <div className="space-y-8">
      {/* Editorial header */}
      <div>
        <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          Section V
        </div>
        <h1 className="text-4xl md:text-5xl font-serif font-bold text-foreground mt-1 leading-none">
          Reports
        </h1>
        <p className="text-muted-foreground mt-2 italic">
          Your money, told as a story — debt momentum, cash flow, where it all
          went, and a few surprises.
        </p>
        <div className="border-t border-border mt-5" />
      </div>

      {/* (Play B) At-a-glance balance tiles — formerly the Dashboard */}
      <ReportsBalanceTiles forecast={forecast} debts={debts} />

      {/* Global controls */}
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <Label className="text-xs uppercase tracking-widest text-muted-foreground">
            Range
          </Label>
          <Select value={rangeDays} onValueChange={setRangeDays}>
            <SelectTrigger className="w-44 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="cmp-prev"
            checked={compareToPrev}
            onCheckedChange={setCompareToPrev}
          />
          <Label
            htmlFor="cmp-prev"
            className="text-xs uppercase tracking-widest text-muted-foreground cursor-pointer"
          >
            Compare to previous period
          </Label>
        </div>
      </div>

      <Tabs defaultValue="debt" className="space-y-6">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="debt">Debt Payoff</TabsTrigger>
          <TabsTrigger value="cashflow">Cash Flow</TabsTrigger>
          <TabsTrigger value="spending">Spending</TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
          <TabsTrigger value="behavior">Behavior &amp; Fun</TabsTrigger>
        </TabsList>

        <TabsContent value="debt" className="space-y-6">
          <AdvisorSummaryCard tab="debt" rangeDays={Number(rangeDays)} monthOffset={Number(monthOffset)} />
          <DebtSection
            debts={debts ?? []}
            balanceHistory={debtBalanceHistory ?? []}
            strategy={(avSettings?.strategy as "avalanche" | "snowball") ?? "avalanche"}
            extraPerMonth={Number(avExtra?.amount ?? avSettings?.manualExtra ?? 0)}
            today={today}
          />
        </TabsContent>

        <TabsContent value="cashflow" className="space-y-6">
          <AdvisorSummaryCard tab="cashflow" rangeDays={Number(rangeDays)} monthOffset={Number(monthOffset)} />
          <CashFlowSection
            txns={rangeTxns}
            prevTxns={prevRangeTxns}
            rangeDays={Number(rangeDays)}
            compareToPrev={compareToPrev}
            catNameById={catNameById}
            excludedCategoryIds={excludedCategoryIds}
            recurringItems={recurringItems ?? []}
            forecast={forecast ?? null}
          />
        </TabsContent>

        <TabsContent value="spending" className="space-y-6">
          <AdvisorSummaryCard tab="spending" rangeDays={Number(rangeDays)} monthOffset={Number(monthOffset)} />
          <SpendingSection
            from={fmtISO(fromDate)}
            to={fmtISO(today)}
            txns={rangeTxns}
            categories={(categories ?? []).map((c) => ({
              id: c.id,
              name: c.name,
            }))}
          />
        </TabsContent>

        <TabsContent value="budget" className="space-y-6">
          <AdvisorSummaryCard tab="budget" rangeDays={Number(rangeDays)} monthOffset={Number(monthOffset)} />
          <BudgetSection
            monthStart={budgetMonthStart}
            monthOffset={monthOffset}
            setMonthOffset={setMonthOffset}
            budget={budgetCurr}
            budgetTimeline={budgetTimeline}
            monthKeys={monthKeys}
            txns={txns ?? []}
            today={today}
          />
        </TabsContent>

        <TabsContent value="behavior" className="space-y-6">
          <AdvisorSummaryCard tab="behavior" rangeDays={Number(rangeDays)} monthOffset={Number(monthOffset)} />
          <BehaviorSection
            txns={rangeTxns}
            yearTxns={txns ?? []}
            catNameById={catNameById}
            today={today}
            budgetTimeline={budgetTimeline}
            trackers={daysSinceTrackers}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --------------------------------------------------------------------------
// DEBT PAYOFF SECTION
// --------------------------------------------------------------------------

function DebtSection({
  debts,
  balanceHistory,
  strategy,
  extraPerMonth,
  today,
}: {
  debts: import("@workspace/api-client-react").Debt[];
  balanceHistory: DebtBalanceHistoryEntry[];
  strategy: "avalanche" | "snowball";
  extraPerMonth: number;
  today: Date;
}) {
  const simDebts = useMemo(() => debts.map(debtToSim), [debts]);
  const sim = useMemo(
    () => simulate({ debts: simDebts, extraPerMonth, strategy }),
    [simDebts, extraPerMonth, strategy],
  );
  const { totalBalance, totalMin } = useMemo(() => totalsForDebts(debts), [debts]);

  const countdown = useMemo(() => debtFreeCountdown(sim, today), [sim, today]);
  const stacked = useMemo(
    () => payoffStackedSeries(sim, simDebts.filter((d) => (d.status ?? "active") === "active")),
    [sim, simDebts],
  );
  const waterfall = useMemo(() => snowballWaterfall(sim), [sim]);
  const ipBars = useMemo(() => interestVsPrincipal(sim, 24), [sim]);
  const killed = useMemo(() => debtsKilledOrder(sim), [sim]);
  const progress = useMemo(
    () => perDebtProgress(debts, sim, balanceHistory),
    [debts, sim, balanceHistory],
  );
  const totalPaid = useMemo(
    () => totalPaidOffSoFar(debts, balanceHistory),
    [debts, balanceHistory],
  );
  const pastBalanceCurve = useMemo(
    () => totalBalanceHistory(debts, balanceHistory),
    [debts, balanceHistory],
  );
  const minOnlyInterest = useMemo(() => interestIfMinimumsOnly(simDebts), [simDebts]);
  const interestSaved =
    Number.isFinite(minOnlyInterest) && minOnlyInterest > sim.totalInterestPaid
      ? minOnlyInterest - sim.totalInterestPaid
      : 0;
  const gauge = useMemo(() => payoffProjectionGauge(sim, 12), [sim]);
  const [gaugeFill, setGaugeFill] = useState(0);
  useEffect(() => {
    setGaugeFill(0);
    const id = window.setTimeout(() => setGaugeFill(totalPaid.pct), 80);
    return () => window.clearTimeout(id);
  }, [totalPaid.pct]);

  // Confetti when entering this tab if we project a kill within 30 days.
  const confettiFiredRef = useRef(false);
  useEffect(() => {
    if (confettiFiredRef.current) return;
    if (!countdown.date) return;
    const next = sim.killedOrder[0];
    if (next) {
      const days = Math.floor((next.date.getTime() - today.getTime()) / 86_400_000);
      if (days >= 0 && days <= 30) {
        fireMilestoneConfetti();
        confettiFiredRef.current = true;
      }
    }
  }, [countdown.date, sim.killedOrder, today]);

  const activeDebts = simDebts.filter((d) => (d.status ?? "active") === "active");
  const maxMonthsLeft = Math.max(
    1,
    ...progress.map((p) => p.monthsLeft ?? sim.monthsToFreedom),
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Section · Debt Payoff"
        title="The road to debt-free"
        blurb="Watch each balance fall, the snowball roll, and the finish line crawl closer."
      />

      {/* Hero tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HeroTile
          label="Total debt"
          value={formatCurrency(totalBalance)}
          sub={`${activeDebts.length} active`}
          tone="bad"
          icon={<TrendingDown className="w-4 h-4" />}
        />
        <HeroTile
          label="Months to debt-free"
          value={countdown.months !== null ? String(countdown.months) : "∞"}
          sub={
            countdown.date
              ? `${(countdown.months! / 12).toFixed(1)} yrs`
              : "raise extra to escape"
          }
          tone="amber"
          icon={<Calendar className="w-4 h-4" />}
        />
        <HeroTile
          label="Debt-free date"
          value={countdown.date ? fmtMonthLabel(countdown.date) : "—"}
          sub={countdown.days !== null ? `~${countdown.days} days` : "—"}
          tone="good"
          icon={<Trophy className="w-4 h-4" />}
        />
        <HeroTile
          label="Interest avoided vs minimums"
          value={
            Number.isFinite(minOnlyInterest)
              ? formatCurrency(interestSaved)
              : "∞"
          }
          sub={`vs ${formatCurrency(sim.totalInterestPaid)} on plan`}
          tone="good"
        />
      </div>

      {/* Debt thermometer + per-debt progress rings */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="rounded-2xl lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-serif">Debt thermometer</CardTitle>
            <p className="text-xs text-muted-foreground">
              How much of your starting total balance you've paid off since you
              began tracking.
            </p>
          </CardHeader>
          <CardContent className="flex items-center justify-center pt-2">
            <div className="flex items-center gap-5">
              <div className="relative w-12 h-56 rounded-full bg-muted overflow-hidden border border-border">
                <div
                  className="absolute inset-x-0 bottom-0 transition-[height] duration-[1400ms] ease-out"
                  style={{
                    height: `${gaugeFill}%`,
                    background: `linear-gradient(to top, ${H2_PALETTE.red}, ${H2_PALETTE.amber}, ${H2_PALETTE.primary})`,
                  }}
                />
                <div className="absolute inset-x-0 bottom-2 w-3 h-3 rounded-full bg-red-500 mx-auto shadow" />
              </div>
              <div>
                <div className="text-4xl font-serif font-bold tabular-nums">
                  {totalPaid.pct.toFixed(1)}%
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {formatCurrency(totalPaid.paidOff)} of{" "}
                  {formatCurrency(totalPaid.startingBalance)} paid
                </div>
                <div className="text-[11px] text-muted-foreground mt-1 italic">
                  {totalPaid.trackingSince
                    ? `since ${totalPaid.trackingSince}`
                    : "tracking starts today"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-2">
                  Plan projects {gauge.pct.toFixed(0)}% more in the next 12 mo.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-serif">
              Per-debt progress rings
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Filled fraction = % of each debt's starting balance you've
              already paid off since tracking began.
            </p>
          </CardHeader>
          <CardContent>
            {progress.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">
                All clear — no debts to track yet.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {progress.map((p, i) => {
                  const color = CHART_SERIES[i % CHART_SERIES.length];
                  const paidPct = Math.round(p.paidPct);
                  const circ = 2 * Math.PI * 26;
                  const dash = (paidPct / 100) * circ;
                  return (
                    <div key={p.id} className="text-center">
                      <div className="relative inline-block">
                        <svg width="72" height="72" viewBox="0 0 72 72">
                          <circle
                            cx="36"
                            cy="36"
                            r="26"
                            fill="none"
                            stroke="hsl(var(--muted))"
                            strokeWidth="8"
                          />
                          <circle
                            cx="36"
                            cy="36"
                            r="26"
                            fill="none"
                            stroke={color}
                            strokeWidth="8"
                            strokeLinecap="round"
                            strokeDasharray={`${dash} ${circ}`}
                            transform="rotate(-90 36 36)"
                            style={{ transition: "stroke-dasharray 900ms ease-out" }}
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center text-xs font-mono tabular-nums">
                          {paidPct}%
                        </div>
                      </div>
                      <div className="text-[11px] font-medium truncate mt-1">
                        {p.name}
                      </div>
                      <div className="text-[10px] text-muted-foreground tabular-nums">
                        paid {formatCurrency(p.paidOff)} of{" "}
                        {formatCurrency(p.startingBalance)}
                      </div>
                      <div className="text-[10px] text-muted-foreground tabular-nums">
                        {p.monthsLeft !== null ? `${p.monthsLeft} mo left` : "∞"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Real past curve, then projected timeline */}
      <ChartCard
        title="Total balance — actual history"
        caption={
          pastBalanceCurve.length > 1
            ? "Sum of all active debt balances per recorded snapshot."
            : "We're collecting daily snapshots — the curve grows as you pay down."
        }
        empty={
          pastBalanceCurve.length === 0
            ? "All clear — no history yet. The projection below shows where you're headed."
            : null
        }
        hideWhenEmpty
        height={220}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={pastBalanceCurve}
            margin={{ top: 10, right: 16, bottom: 16, left: 0 }}
          >
            <defs>
              <linearGradient id="past-balance" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={H2_PALETTE.primary} stopOpacity={0.7} />
                <stop offset="100%" stopColor={H2_PALETTE.primary} stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => tooltipMoney(v)}
            />
            <Area
              type="monotone"
              dataKey="total"
              stroke={H2_PALETTE.primary}
              fill="url(#past-balance)"
              strokeWidth={2}
              name="Total balance"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Stacked payoff timeline */}
      <ChartCard
        title="Payoff timeline"
        caption="Stacked balance per debt over time. Each layer disappears as that debt is killed."
        empty={
          activeDebts.length === 0 ? "All clear — no active debts to project." : null
        }
        hideWhenEmpty
        height={340}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={stacked} margin={{ top: 10, right: 16, bottom: 16, left: 0 }}>
            <defs>
              {activeDebts.map((d, i) => (
                <linearGradient
                  key={d.id}
                  id={`payoff-${d.id}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={CHART_SERIES[i % CHART_SERIES.length]}
                    stopOpacity={0.85}
                  />
                  <stop
                    offset="100%"
                    stopColor={CHART_SERIES[i % CHART_SERIES.length]}
                    stopOpacity={0.25}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => tooltipMoney(v)}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {activeDebts.map((d, i) => (
              <Area
                key={d.id}
                type="monotone"
                dataKey={d.name}
                stackId="1"
                stroke={CHART_SERIES[i % CHART_SERIES.length]}
                fill={`url(#payoff-${d.id})`}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard
          title="Snowball waterfall"
          caption="Freed-up minimums roll into the next debt as each one falls."
          empty={waterfall.length === 0 ? "All clear — no projected payoffs in this window." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={waterfall} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="freed" fill={H2_PALETTE.amber} name="Freed this kill" radius={[6, 6, 0, 0]} />
              <Bar dataKey="cumulative" fill={H2_PALETTE.primary} name="Snowball total" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Interest vs principal"
          caption="Stacked monthly payment split. The interest slice should shrink as smaller debts die."
          empty={ipBars.length === 0 ? "All clear — no projection to draw yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={ipBars} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="month" tick={{ fontSize: 10 }} interval={2} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="principal" stackId="1" fill={H2_PALETTE.primary} name="Principal" />
              <Bar dataKey="interest" stackId="1" fill={H2_PALETTE.red} name="Interest" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Killed milestones */}
        <ChartCard
          title="Debts killed — milestone timeline"
          caption="Projected payoff date for every debt, in order."
          empty={killed.length === 0 ? "All clear — no projected payoffs yet." : null}
          hideWhenEmpty
          height={Math.max(220, 60 + killed.length * 40)}
        >
          <div className="relative h-full overflow-y-auto pr-1">
            <div className="absolute left-4 top-2 bottom-2 w-px bg-border" />
            <ul className="space-y-3 py-1">
              {killed.map((k) => (
                <li key={`${k.name}-${k.monthIndex}`} className="relative pl-10">
                  <div className="absolute left-2 top-1.5 w-5 h-5 rounded-full bg-amber-400 border-4 border-background flex items-center justify-center">
                    <Trophy className="w-2.5 h-2.5 text-amber-900" />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-sm">{k.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Month {k.monthIndex} · {k.label}
                      </div>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      #{k.rank}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>

        {/* Per-debt months-to-payoff bars */}
        <ChartCard
          title="Per-debt months remaining"
          caption="How long each balance has left at your current plan. Shorter = closer to done."
          empty={progress.length === 0 ? "All clear — no active debts on the books." : null}
          hideWhenEmpty
          height={Math.max(220, 40 + progress.length * 36)}
        >
          <div className="space-y-3 h-full overflow-y-auto pr-1">
            {progress.map((p, i) => {
              const fill = CHART_SERIES[i % CHART_SERIES.length];
              const widthPct =
                p.monthsLeft !== null
                  ? Math.max(4, (p.monthsLeft / maxMonthsLeft) * 100)
                  : 100;
              return (
                <div key={p.id}>
                  <div className="flex items-baseline justify-between text-xs mb-1">
                    <div className="font-medium truncate">{p.name}</div>
                    <div className="font-mono tabular-nums text-muted-foreground">
                      {p.monthsLeft !== null ? `${p.monthsLeft} mo` : "∞"}
                      {" · "}
                      {formatCurrency(p.balance)}
                    </div>
                  </div>
                  <div className="h-3 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${widthPct}%`, background: fill }}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {p.payoffDate ? `payoff: ${fmtMonthLabel(p.payoffDate)}` : "won't pay off in window"}
                    {" · "}
                    {(p.apr * 100).toFixed(2)}% APR · min {formatCurrency(p.minPayment)}
                  </div>
                </div>
              );
            })}
          </div>
        </ChartCard>
      </div>

      <p className="text-[11px] text-muted-foreground italic">
        Projection assumes total monthly payment of{" "}
        {formatCurrency(totalMin + extraPerMonth)} ({formatCurrency(totalMin)}{" "}
        minimums + {formatCurrency(extraPerMonth)} extra), strategy:{" "}
        {strategy === "avalanche" ? "avalanche (highest APR first)" : "snowball (smallest balance first)"}.
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------
// CASH FLOW SECTION
// --------------------------------------------------------------------------

function CashFlowSection({
  txns,
  prevTxns,
  rangeDays,
  compareToPrev,
  catNameById,
  excludedCategoryIds,
  recurringItems,
  forecast,
}: {
  txns: Transaction[];
  prevTxns: Transaction[];
  rangeDays: number;
  compareToPrev: boolean;
  catNameById: Map<string, string>;
  excludedCategoryIds: ReadonlySet<string>;
  recurringItems: RecurringItem[];
  forecast: ForecastBundle | null;
}) {
  const period: "day" | "week" | "month" =
    rangeDays <= 60 ? "day" : rangeDays <= 180 ? "week" : "month";

  const dailyCurr = useMemo(
    () => dailyCashFlow(txns, excludedCategoryIds),
    [txns, excludedCategoryIds],
  );
  const series = useMemo(
    () => withRunningNet(rollupByPeriod(dailyCurr, period)),
    [dailyCurr, period],
  );
  const prevSeries = useMemo(
    () => rollupByPeriod(dailyCashFlow(prevTxns, excludedCategoryIds), period),
    [prevTxns, period, excludedCategoryIds],
  );
  // Merge previous-period series alongside current so charts can show overlay.
  const seriesWithPrev = useMemo(() => {
    return series.map((row, i) => ({
      ...row,
      prevIncome: prevSeries[i]?.income ?? null,
      prevExpense: prevSeries[i]?.expense ?? null,
      prevNet: prevSeries[i]?.net ?? null,
    }));
  }, [series, prevSeries]);

  // Recurring monthly burn — sum of all recurring item monthly-equivalent amounts.
  // Uses real schema fields: `frequency` for cadence, `kind` to split bill vs income.
  const recurringMonthly = useMemo(() => {
    const freqMul: Record<string, number> = {
      weekly: 4.345,
      biweekly: 2.1725,
      "bi-weekly": 2.1725,
      semimonthly: 2,
      "semi-monthly": 2,
      monthly: 1,
      quarterly: 1 / 3,
      semiannual: 1 / 6,
      semiannually: 1 / 6,
      yearly: 1 / 12,
      annually: 1 / 12,
      annual: 1 / 12,
    };
    let income = 0;
    let expense = 0;
    for (const r of recurringItems) {
      if (r.active && r.active !== "true" && r.active !== "1") continue;
      const amt = Math.abs(Number(r.amount) || 0);
      const mul = freqMul[String(r.frequency ?? "monthly").toLowerCase()] ?? 1;
      const monthly = amt * mul;
      const isIncome = String(r.kind ?? "").toLowerCase() === "income";
      if (isIncome) income += monthly;
      else expense += monthly;
    }
    return { income, expense };
  }, [recurringItems]);

  // Build a 90-day projected balance from forecast events + starting balance.
  const forecastSeries = useMemo(() => {
    if (!forecast) return [];
    const startBal = Number(forecast.settings?.startingBalance ?? 0) || 0;
    const sorted = [...(forecast.events ?? [])].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
    let bal = startBal;
    const byDate = new Map<string, number>();
    for (const e of sorted) {
      bal += Number(e.amount) || 0;
      byDate.set(e.date, bal);
    }
    if (byDate.size === 0) return [];
    return Array.from(byDate.entries()).map(([date, balance]) => ({
      date,
      balance: Math.round(balance * 100) / 100,
    }));
  }, [forecast]);
  const burn = useMemo(() => rolling30DayBurn(dailyCurr), [dailyCurr]);
  const kpis = useMemo(() => cashFlowKpis(dailyCurr), [dailyCurr]);
  const prevKpis = useMemo(
    () => cashFlowKpis(dailyCashFlow(prevTxns, excludedCategoryIds)),
    [prevTxns, excludedCategoryIds],
  );
  const pctDelta = (curr: number, prev: number) =>
    prev === 0 ? Number.NaN : ((curr - prev) / Math.abs(prev)) * 100;
  const incomeDelta = compareToPrev
    ? { pct: pctDelta(kpis.avgIncome, prevKpis.avgIncome), goodIfUp: true }
    : null;
  const expenseDelta = compareToPrev
    ? { pct: pctDelta(kpis.avgExpense, prevKpis.avgExpense), goodIfUp: false }
    : null;
  const netDelta = compareToPrev
    ? { pct: pctDelta(kpis.avgNet, prevKpis.avgNet), goodIfUp: true }
    : null;
  const savingsDelta = compareToPrev
    ? { pct: pctDelta(kpis.savingsRatePct, prevKpis.savingsRatePct), goodIfUp: true }
    : null;

  // Income source vs spending category breakdown for the most recent month.
  const flowMonth = useMemo(() => {
    if (series.length === 0) return null;
    const last = series[series.length - 1];
    return last.date.slice(0, 7);
  }, [series]);
  const flowBars = useMemo(() => {
    if (!flowMonth) return [];
    const incomeByDesc = new Map<string, number>();
    const expenseByCat = new Map<string, number>();
    for (const t of txns) {
      if (!t.occurredOn.startsWith(flowMonth)) continue;
      const a = Number(t.amount) || 0;
      if (a > 0) {
        const k = t.description?.split(" ")[0] ?? "Income";
        incomeByDesc.set(k, (incomeByDesc.get(k) ?? 0) + a);
      } else if (a < 0) {
        const k = t.categoryId
          ? catNameById.get(t.categoryId) ?? "Uncategorized"
          : "Uncategorized";
        expenseByCat.set(k, (expenseByCat.get(k) ?? 0) + -a);
      }
    }
    const incomeTotal = Array.from(incomeByDesc.values()).reduce((s, v) => s + v, 0);
    const expenseTotal = Array.from(expenseByCat.values()).reduce((s, v) => s + v, 0);
    const savings = Math.max(0, incomeTotal - expenseTotal);
    const topExpense = Array.from(expenseByCat.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    return [
      { stage: "Income", ...Object.fromEntries(incomeByDesc) },
      {
        stage: "Spending",
        ...Object.fromEntries(topExpense),
      },
      { stage: "Outcome", Savings: savings, Spent: expenseTotal },
    ];
  }, [flowMonth, txns, catNameById]);

  const flowKeys = useMemo(() => {
    const set = new Set<string>();
    for (const row of flowBars) {
      for (const k of Object.keys(row)) if (k !== "stage") set.add(k);
    }
    return Array.from(set);
  }, [flowBars]);

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Section · Cash Flow"
        title="Money in, money out"
        blurb="The pulse of your accounts — what came in, what left, and what stuck around."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HeroTile
          label="Avg monthly income"
          value={formatCurrency(kpis.avgIncome)}
          tone="good"
          icon={<TrendingUp className="w-4 h-4" />}
          delta={incomeDelta}
        />
        <HeroTile
          label="Avg monthly expense"
          value={formatCurrency(kpis.avgExpense)}
          tone="bad"
          icon={<TrendingDown className="w-4 h-4" />}
          delta={expenseDelta}
        />
        <HeroTile
          label="Avg monthly net"
          value={formatCurrency(kpis.avgNet)}
          tone={kpis.avgNet >= 0 ? "good" : "bad"}
          icon={<PiggyBank className="w-4 h-4" />}
          delta={netDelta}
        />
        <HeroTile
          label="Savings rate"
          value={`${kpis.savingsRatePct.toFixed(1)}%`}
          tone="amber"
          delta={savingsDelta}
        />
      </div>

      <ChartCard
        title="Income vs expense"
        caption={
          compareToPrev
            ? "Solid = current period. Dashed = previous period."
            : "The classic line — income up top, expense below."
        }
        empty={series.length === 0 ? "All clear — no transactions in this window." : null}
        hideWhenEmpty
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={seriesWithPrev} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="income" stroke={H2_PALETTE.primary} strokeWidth={2.5} dot={false} name="Income" />
            <Line type="monotone" dataKey="expense" stroke={H2_PALETTE.red} strokeWidth={2.5} dot={false} name="Expense" />
            {compareToPrev && (
              <Line
                type="monotone"
                dataKey="prevIncome"
                stroke={H2_PALETTE.primary}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.6}
                dot={false}
                name="Income (prev)"
                connectNulls
              />
            )}
            {compareToPrev && (
              <Line
                type="monotone"
                dataKey="prevExpense"
                stroke={H2_PALETTE.red}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.6}
                dot={false}
                name="Expense (prev)"
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Net cash flow"
        caption={
          compareToPrev
            ? "Bars = current net. Solid line = running net. Dashed = previous-period net."
            : "Bars = net per period. The line = running cumulative net."
        }
        empty={series.length === 0 ? "All clear — no transactions in this window." : null}
        hideWhenEmpty
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={seriesWithPrev} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Bar dataKey="net" name="Net" radius={[4, 4, 0, 0]}>
              {series.map((row, i) => (
                <Cell
                  key={i}
                  fill={row.net >= 0 ? H2_PALETTE.emerald : H2_PALETTE.red}
                />
              ))}
            </Bar>
            <Line type="monotone" dataKey="running" stroke={H2_PALETTE.violet} strokeWidth={2} dot={false} name="Running net" />
            {compareToPrev && (
              <Line
                type="monotone"
                dataKey="prevNet"
                stroke={H2_PALETTE.slate}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.7}
                dot={false}
                name="Net (prev)"
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Locked-in monthly burn
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <div className="text-4xl font-serif font-bold tabular-nums">
                {formatCurrency(recurringMonthly.expense)}
              </div>
              <div className="text-xs text-muted-foreground">/mo from recurring bills</div>
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              Recurring income: {formatCurrency(recurringMonthly.income)} · net{" "}
              {formatCurrency(recurringMonthly.income - recurringMonthly.expense)}/mo
            </div>
            <div className="text-[10px] text-muted-foreground italic mt-1">
              From {recurringItems.length} recurring item{recurringItems.length === 1 ? "" : "s"}.
            </div>
          </CardContent>
        </Card>

        <ChartCard
          title="Forecast balance (next 90 days)"
          caption="Projected cash balance from your forecast settings."
          empty={forecastSeries.length === 0 ? "All clear — no forecast data yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={forecastSeries} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <defs>
                <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={H2_PALETTE.violet} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={H2_PALETTE.violet} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Area
                type="monotone"
                dataKey="balance"
                stroke={H2_PALETTE.violet}
                strokeWidth={2}
                fill="url(#forecastGrad)"
                name="Projected balance"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard
          title="Money flow this month"
          caption="Income sources → spending categories → savings/spent."
          empty={flowBars.length === 0 ? "All clear — no transactions yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={flowBars} margin={{ top: 10, right: 16, bottom: 24, left: 0 }} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <YAxis dataKey="stage" type="category" tick={{ fontSize: 11 }} width={80} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              {flowKeys.map((k, i) => (
                <Bar
                  key={k}
                  dataKey={k}
                  stackId="flow"
                  fill={CHART_SERIES[i % CHART_SERIES.length]}
                  name={k}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Rolling 30-day burn rate"
          caption="Average daily spending — the smoothed signal under the noise."
          empty={burn.length === 0 ? "All clear — no spending data yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={burn} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <defs>
                <linearGradient id="burn-gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={H2_PALETTE.amber} stopOpacity={0.7} />
                  <stop offset="100%" stopColor={H2_PALETTE.amber} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" angle={-25} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
              <Area type="monotone" dataKey="avg" stroke={H2_PALETTE.amber} strokeWidth={2} fill="url(#burn-gradient)" name="Avg daily spend" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// SPENDING SECTION
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// SPENDING SECTION (Phase 2 — facts pipeline)
//
// Rebuilt on top of GET /reports/spending-facts. Everything here renders from
// the deterministic facts payload (real spend excludes income/transfers/debt/
// reimbursement; merchant names are cleaned server-side; the uncategorized
// backlog is its own surface). The `excluded.*` buckets are intentionally
// NEVER surfaced — the pipeline excludes them and the UI stays silent about it.
// --------------------------------------------------------------------------

// Tracking began May 1, 2026 (mirrors server TRACKING_START).
const TRACKING_START_YM = "2026-05";

interface HeatCell {
  date: string;
  amount: number;
  week: number;
  dow: number;
}

// Mirrors the server's transfer/payment description patterns so the
// Recategorize popover lists exactly the txns that the facts pipeline counts
// as uncategorized (spendingFilter.ts isUncategorizedSpend).
const SPENDING_TRANSFER_PATTERNS = [
  "online transfer",
  "ach pmt",
  "ach payment",
  "web id:",
  "credit card pmt",
  "autopay",
  "payment thank you",
  "card pmt",
  "epay",
  "chase credit",
  "bk of amer",
  "wells fargo card",
];

function spendMagnitude(t: Transaction): number {
  const a = parseFloat(t.amount);
  if (!Number.isFinite(a)) return 0;
  if (t.source === "amex") return a > 0 ? a : 0;
  return a < 0 ? -a : 0;
}

// Client-side mirror of isUncategorizedSpend — used only to populate the
// Recategorize popover with the actual transaction rows + IDs.
function isUncategorizedSpendTxn(t: Transaction): boolean {
  if (spendMagnitude(t) <= 0) return false;
  if (t.isTransfer === true) return false;
  if (t.categoryId) return false;
  const d = (t.description ?? "").toLowerCase();
  if (SPENDING_TRANSFER_PATTERNS.some((p) => d.includes(p))) return false;
  return true;
}

function sentenceCase(s: string): string {
  const t = (s ?? "").trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function monthLongLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}
function monthShortLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" });
}

// Pretty "May 1–29" style label from two ISO dates.
function rangeLabel(startIso: string, endIso: string): string {
  const s = new Date(`${startIso}T00:00:00Z`);
  const e = new Date(`${endIso}T00:00:00Z`);
  const sM = s.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const eM = e.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const sD = s.getUTCDate();
  const eD = e.getUTCDate();
  return sM === eM ? `${sM} ${sD}–${eD}` : `${sM} ${sD} – ${eM} ${eD}`;
}

// Inclusive list of ISO days between two dates (UTC).
function eachIsoDay(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// (Phase 2) Warning banner above the tile row. Only renders when there is an
// uncategorized backlog. The Recategorize button opens the same per-row
// CategoryPicker popover treatment shipped on /debrief.
function UncategorizedBanner({
  facts,
  uncategorizedTxns,
  categories,
}: {
  facts: SpendingFacts;
  uncategorizedTxns: Transaction[];
  categories: { id: string; name: string }[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const updateTxn = useUpdateTransaction();

  const handleChange = (
    txnId: string,
    newCategoryId: string | null,
    rememberPattern?: string | null,
  ) => {
    updateTxn.mutate(
      {
        id: txnId,
        data: {
          categoryId: newCategoryId,
          ...(rememberPattern ? { rememberPattern } : {}),
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          qc.invalidateQueries({
            queryKey: getGetReportsSpendingFactsQueryKey(),
          });
          qc.invalidateQueries({
            queryKey: getGetReportsAdvisorSummaryQueryKey({ tab: "spending" }),
          });
          toast({ title: "Recategorized" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't recategorize",
            description: (err as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const samples = facts.uncategorized.sampleMerchants
    .slice(0, 3)
    .map((m) => m.name)
    .join(", ");

  return (
    <Card
      className="rounded-2xl border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/[0.08]"
      data-testid="banner-uncategorized"
    >
      <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <Wand2 className="w-5 h-5 text-[hsl(var(--warning))] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-lg font-serif font-bold">
              <span className="tabular-nums">
                {formatCurrency(facts.uncategorized.total)}
              </span>{" "}
              of your spending is uncategorized
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 truncate">
              {facts.uncategorized.transactionCount} transactions
              {samples ? ` · top merchants: ${samples}` : ""}
            </div>
          </div>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 border-[hsl(var(--warning))]/50"
              data-testid="button-recategorize-uncategorized"
            >
              <Wand2 className="w-3.5 h-3.5 mr-1.5" />
              Recategorize
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-96 p-0 max-h-[28rem] overflow-y-auto"
          >
            <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground sticky top-0 bg-popover">
              {uncategorizedTxns.length} uncategorized{" "}
              {uncategorizedTxns.length === 1 ? "transaction" : "transactions"}
            </div>
            {uncategorizedTxns.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                All caught up — nothing uncategorized.
              </div>
            ) : (
              <div className="divide-y">
                {uncategorizedTxns.map((t) => (
                  <div key={t.id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {t.description}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {t.occurredOn}
                        </div>
                      </div>
                      <div className="tabular-nums text-sm whitespace-nowrap">
                        {formatCurrency(Math.abs(parseFloat(t.amount)))}
                      </div>
                    </div>
                    <div className="mt-1">
                      <CategoryPicker
                        value={t.categoryId ?? null}
                        categories={categories}
                        description={t.description}
                        onChange={(newId, rememberPattern) =>
                          handleChange(t.id, newId, rememberPattern)
                        }
                        testId={`recat-uncat-${t.id}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </CardContent>
    </Card>
  );
}

function SpendingSection({
  from,
  to,
  txns,
  categories,
}: {
  from: string;
  to: string;
  txns: Transaction[];
  categories: { id: string; name: string }[];
}) {
  const { data: facts, isLoading } = useGetReportsSpendingFacts({ from, to });

  // Real uncategorized rows (with IDs) for the Recategorize popover, scoped to
  // the facts' (possibly floor-clamped) range so the count matches the banner.
  const uncategorizedTxns = useMemo(() => {
    if (!facts) return [];
    const lo = facts.range.start;
    const hi = facts.range.end;
    return txns
      .filter((t) => t.occurredOn >= lo && t.occurredOn <= hi)
      .filter(isUncategorizedSpendTxn)
      .sort((a, b) => spendMagnitude(b) - spendMagnitude(a));
  }, [facts, txns]);

  // Top categories excluding the DB "Uncategorized" bucket (it has its own
  // banner; it must never show as a category or in the pie).
  const realCats = useMemo(
    () =>
      (facts?.byCategory ?? []).filter((c) => !/uncategorized/i.test(c.name)),
    [facts],
  );

  // Pie: top 8 real categories + an "Other" slice for the rest.
  const pieData = useMemo(() => {
    const top8 = realCats.slice(0, 8).map((c) => ({
      name: c.name,
      total: c.total,
      pct: c.pctOfRealSpend,
    }));
    const rest = realCats.slice(8);
    if (rest.length > 0) {
      top8.push({
        name: "Other",
        total: rest.reduce((s, c) => s + c.total, 0),
        pct: rest.reduce((s, c) => s + c.pctOfRealSpend, 0),
      });
    }
    return top8;
  }, [realCats]);

  // Reimbursable donut from facts.reimbursable.
  const reimDonut = useMemo(() => {
    if (!facts) return [];
    return [
      {
        name: "Outstanding reimbursable",
        value: Math.round(facts.reimbursable.outstandingReimbursableTotal),
      },
      { name: "Personal", value: Math.round(facts.reimbursable.personalTotal) },
    ].filter((r) => r.value > 0);
  }, [facts]);

  // Heatmap: build a continuous calendar from the range. While we have under
  // 12 weeks (84 days) of data, show every day since tracking started;
  // afterward automatically roll to the last 84 days.
  const { heatCols, maxHeat, heatStartIso } = useMemo(() => {
    if (!facts)
      return { heatCols: [] as { week: number; cells: HeatCell[] }[], maxHeat: 0, heatStartIso: "" };
    const totals = new Map(facts.dailyBuckets.map((b) => [b.date, b.total]));
    const allDays = eachIsoDay(facts.range.start, facts.range.end);
    const days = allDays.length > 84 ? allDays.slice(-84) : allDays;
    const first = new Date(`${days[0]}T00:00:00Z`);
    const firstSunday = new Date(first);
    firstSunday.setUTCDate(firstSunday.getUTCDate() - first.getUTCDay());
    const cells: HeatCell[] = days.map((date) => {
      const d = new Date(`${date}T00:00:00Z`);
      const diffDays = Math.floor(
        (d.getTime() - firstSunday.getTime()) / 86_400_000,
      );
      return {
        date,
        amount: totals.get(date) ?? 0,
        week: Math.floor(diffDays / 7),
        dow: d.getUTCDay(),
      };
    });
    let max = 0;
    for (const c of cells) if (c.amount > max) max = c.amount;
    const cols: { week: number; cells: HeatCell[] }[] = [];
    let curr: HeatCell[] = [];
    let lastWeek = -1;
    for (const c of cells) {
      if (c.week !== lastWeek) {
        if (curr.length) cols.push({ week: lastWeek, cells: curr });
        curr = [];
        lastWeek = c.week;
      }
      curr.push(c);
    }
    if (curr.length) cols.push({ week: lastWeek, cells: curr });
    return { heatCols: cols, maxHeat: max, heatStartIso: days[0] };
  }, [facts]);

  // Day-of-week: avg per day, highlight the highest-average day.
  const maxDowAvg = useMemo(() => {
    let m = 0;
    for (const d of facts?.dayOfWeek ?? []) if (d.avgPerDay > m) m = d.avgPerDay;
    return m;
  }, [facts]);

  const topMerch = useMemo(
    () => (facts?.byMerchant ?? []).slice(0, 10),
    [facts],
  );
  const maxMerch = topMerch[0]?.total ?? 0;

  // Category trends treatment depends on how many months of data exist.
  const months = facts?.monthlyTrends ?? [];
  const trendTopCatNames = useMemo(() => {
    const agg = new Map<string, number>();
    for (const mo of months)
      for (const c of mo.byTopCategory)
        agg.set(c.name, (agg.get(c.name) ?? 0) + c.total);
    return [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name]) => name);
  }, [months]);
  const trendBarData = useMemo(
    () =>
      months.map((mo) => {
        const row: Record<string, number | string> = {
          month: monthShortLabel(mo.month),
        };
        for (const name of trendTopCatNames) {
          row[name] =
            mo.byTopCategory.find((c) => c.name === name)?.total ?? 0;
        }
        return row;
      }),
    [months, trendTopCatNames],
  );
  const trendSparkData = useMemo(
    () =>
      trendTopCatNames.map((name) => ({
        name,
        total: months.reduce(
          (s, mo) =>
            s + (mo.byTopCategory.find((c) => c.name === name)?.total ?? 0),
          0,
        ),
        series: months.map((mo) => ({
          month: monthShortLabel(mo.month),
          spend: mo.byTopCategory.find((c) => c.name === name)?.total ?? 0,
        })),
      })),
    [months, trendTopCatNames],
  );

  if (isLoading || !facts) {
    return (
      <div className="space-y-6">
        <SectionHeader
          eyebrow="Section · Spending"
          title="Where the money went"
          blurb="The rhythms, the leaks, and the merchants that quietly add up."
        />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const topCat = realCats[0];
  const topMerchant = facts.byMerchant[0];
  const showUncatBanner = facts.uncategorized.total > 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Section · Spending"
        title="Where the money went"
        blurb="The rhythms, the leaks, and the merchants that quietly add up."
      />

      {showUncatBanner && (
        <UncategorizedBanner
          facts={facts}
          uncategorizedTxns={uncategorizedTxns}
          categories={categories}
        />
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HeroTile
          label="Total real spend"
          value={formatCurrency(facts.realSpend.total)}
          sub={`${facts.realSpend.transactionCount} transactions · ${rangeLabel(facts.range.start, facts.range.end)}`}
        />
        <HeroTile
          label="Top category"
          value={topCat?.name ?? "—"}
          sub={
            topCat
              ? `${formatCurrency(topCat.total)} · ${Math.round(topCat.pctOfRealSpend)}% of real spend`
              : "—"
          }
          tone="amber"
        />
        <HeroTile
          label="Top merchant"
          value={topMerchant?.name ?? "—"}
          sub={
            topMerchant
              ? `${topMerchant.count} ${topMerchant.count === 1 ? "hit" : "hits"}${topMerchant.sampleCategoryName ? ` · ${topMerchant.sampleCategoryName}` : ""}`
              : "—"
          }
        />
        <HeroTile
          label="Reimbursable outstanding"
          value={formatCurrency(facts.reimbursable.outstandingReimbursableTotal)}
          sub={
            facts.reimbursable.outstandingReimbursableTotal > 0
              ? "still owed back to the household"
              : "nothing outstanding"
          }
          tone={
            facts.reimbursable.outstandingReimbursableTotal > 0
              ? "amber"
              : "good"
          }
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard
          title="Top categories"
          caption="Real spend by category — uncategorized lives in its own banner."
          empty={pieData.length === 0 ? "All clear — no categorized spend yet." : null}
          hideWhenEmpty
        >
          <div className="flex flex-col sm:flex-row items-center gap-4 h-full">
            <div className="w-full sm:w-1/2 h-full min-h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="total"
                    nameKey="name"
                    outerRadius={100}
                    innerRadius={52}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={CHART_SERIES[i % CHART_SERIES.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: number) => tooltipMoney(v)}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* Custom HTML legend — sentence-case label, dollars, percentage. */}
            <ul className="w-full sm:w-1/2 space-y-1.5 text-xs">
              {pieData.map((d, i) => (
                <li key={d.name} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-[2px] shrink-0"
                    style={{ background: CHART_SERIES[i % CHART_SERIES.length] }}
                  />
                  <span className="truncate flex-1">{sentenceCase(d.name)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(d.total)}
                  </span>
                  <span className="tabular-nums text-muted-foreground/70 w-9 text-right">
                    {Math.round(d.pct)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>

        <ChartCard
          title="Reimbursable vs personal"
          caption="On Amex: how much will come back vs. the true personal cost."
          empty={reimDonut.length === 0 ? "All clear — no Amex spend tagged yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={reimDonut}
                dataKey="value"
                nameKey="name"
                innerRadius={60}
                outerRadius={110}
              >
                <Cell fill={H2_PALETTE.amber} />
                <Cell fill={H2_PALETTE.primary} />
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard
        title="Spending heatmap"
        caption={`Since tracking started — ${monthLongLabel(TRACKING_START_YM)}. Each square is one day; darker = more spent.`}
        empty={
          heatCols.length === 0 || maxHeat === 0
            ? "All clear — no spending recorded yet."
            : null
        }
        hideWhenEmpty
        height={180}
      >
        <div className="flex items-start gap-1 h-full overflow-x-auto pb-2">
          <div className="grid grid-rows-7 gap-1 mr-2 text-[9px] text-muted-foreground items-center">
            {["", "Mon", "", "Wed", "", "Fri", ""].map((l, i) => (
              <div key={i} className="h-3 leading-none">
                {l}
              </div>
            ))}
          </div>
          {heatCols.map((col) => (
            <div key={col.week} className="grid grid-rows-7 gap-1">
              {Array.from({ length: 7 }).map((_, dow) => {
                const cell = col.cells.find((c) => c.dow === dow);
                if (!cell) return <div key={dow} className="h-3 w-3" />;
                const intensity = maxHeat > 0 ? cell.amount / maxHeat : 0;
                const bg =
                  cell.amount === 0
                    ? "hsl(var(--muted))"
                    : `hsl(var(--chart-1) / ${0.25 + intensity * 0.75})`;
                return (
                  <div
                    key={dow}
                    className="h-3 w-3 rounded-[2px]"
                    style={{ background: bg }}
                    title={`${cell.date}: ${formatCurrency(cell.amount)}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard
          title="Day of week"
          caption="Average spend per day — exposes which weekday does the damage."
          empty={
            (facts.dayOfWeek ?? []).every((d) => d.avgPerDay === 0)
              ? "All clear — no spending data yet."
              : null
          }
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={facts.dayOfWeek}
              margin={{ top: 10, right: 16, bottom: 24, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => `$${Math.round(v)}`}
                label={{
                  value: "Avg / day",
                  angle: -90,
                  position: "insideLeft",
                  style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
                }}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
              />
              <Bar dataKey="avgPerDay" radius={[6, 6, 0, 0]}>
                {facts.dayOfWeek.map((d, i) => (
                  <Cell
                    key={i}
                    fill={
                      maxDowAvg > 0 && d.avgPerDay === maxDowAvg
                        ? H2_PALETTE.amber
                        : H2_PALETTE.primary
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Top merchants"
          caption="Where your dollars actually land. Top 10 by total, with category context."
          empty={topMerch.length === 0 ? "All clear — no merchants tracked yet." : null}
          hideWhenEmpty
        >
          {/* Custom HTML bar list so each merchant can carry its category
              context as muted text to the right of the bar. */}
          <div className="h-full overflow-y-auto pr-1 space-y-2.5">
            {topMerch.map((m) => (
              <div key={m.name}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium">{m.name}</span>
                  <span className="tabular-nums whitespace-nowrap">
                    {formatCurrency(m.total)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${maxMerch > 0 ? (m.total / maxMerch) * 100 : 0}%`,
                        background: H2_PALETTE.primary,
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {m.count} {m.count === 1 ? "hit" : "hits"}
                    {m.sampleCategoryName ? ` · ${m.sampleCategoryName}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      {months.length === 1 ? (
        <ChartCard
          title="Category trends — since tracking started"
          caption="One month of data so far. A trend line appears as more months land."
          height={220}
        >
          <div className="flex flex-col h-full">
            <div className="text-sm font-medium mb-1">
              {monthLongLabel(months[0].month)}:{" "}
              <span className="tabular-nums">
                {formatCurrency(months[0].total)}
              </span>{" "}
              across {realCats.length}{" "}
              {realCats.length === 1 ? "category" : "categories"}
            </div>
            {/* Single horizontal stacked bar of the month's top categories. */}
            <div className="flex h-8 w-full rounded-md overflow-hidden mt-2">
              {months[0].byTopCategory.map((c, i) => {
                const w =
                  months[0].total > 0 ? (c.total / months[0].total) * 100 : 0;
                return (
                  <div
                    key={c.name}
                    className="h-full"
                    style={{
                      width: `${w}%`,
                      background: CHART_SERIES[i % CHART_SERIES.length],
                    }}
                    title={`${c.name}: ${formatCurrency(c.total)}`}
                  />
                );
              })}
            </div>
            <ul className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5 text-xs mt-3">
              {months[0].byTopCategory.map((c, i) => (
                <li key={c.name} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-[2px] shrink-0"
                    style={{ background: CHART_SERIES[i % CHART_SERIES.length] }}
                  />
                  <span className="truncate flex-1">{sentenceCase(c.name)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(c.total)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </ChartCard>
      ) : months.length >= 6 ? (
        <ChartCard
          title="Category trends — last 6 months"
          caption="One sparkline per top category. Watch for upward creep."
          empty={trendSparkData.length === 0 ? "All clear — no category spending yet." : null}
          hideWhenEmpty
          height={260}
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 h-full">
            {trendSparkData.map((t, i) => (
              <div key={t.name} className="flex flex-col">
                <div className="text-xs font-medium truncate">{t.name}</div>
                <div className="text-[10px] text-muted-foreground tabular-nums mb-1">
                  {formatCurrency(t.total)}
                </div>
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={t.series}
                      margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
                    >
                      <Area
                        type="monotone"
                        dataKey="spend"
                        stroke={CHART_SERIES[i % CHART_SERIES.length]}
                        fill={CHART_SERIES[i % CHART_SERIES.length]}
                        fillOpacity={0.25}
                        strokeWidth={1.5}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: number) => tooltipMoney(v)}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ))}
          </div>
        </ChartCard>
      ) : (
        <ChartCard
          title="Category trends — since tracking started"
          caption="Spend per month for your top categories. A sparkline grid takes over at 6 months."
          empty={trendBarData.length === 0 ? "All clear — no category spending yet." : null}
          hideWhenEmpty
          height={280}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={trendBarData}
              margin={{ top: 10, right: 16, bottom: 8, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => `$${Math.round(v)}`}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {trendTopCatNames.map((name, i) => (
                <Bar
                  key={name}
                  dataKey={name}
                  stackId="trend"
                  fill={CHART_SERIES[i % CHART_SERIES.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}


// --------------------------------------------------------------------------
// BUDGET SECTION
// --------------------------------------------------------------------------

function BudgetSection({
  monthStart,
  monthOffset,
  setMonthOffset,
  budget,
  budgetTimeline,
  monthKeys,
  txns,
  today,
}: {
  monthStart: string;
  monthOffset: string;
  setMonthOffset: (s: string) => void;
  budget: import("@workspace/api-client-react").BudgetMonthDetail | undefined;
  budgetTimeline: (import("@workspace/api-client-react").BudgetMonthDetail | undefined)[];
  monthKeys: string[];
  txns: Transaction[];
  today: Date;
}) {
  const variance = useMemo(() => budgetVariance(budget), [budget]);
  const burndown = useMemo(
    () => budgetBurndown(budget, txns, monthStart, today),
    [budget, txns, monthStart, today],
  );
  const perCatBurn = useMemo(
    () => perCategoryBurndown(budget, txns, monthStart, today, 5),
    [budget, txns, monthStart, today],
  );
  const consistency = useMemo(
    () => budgetConsistencyHeatmap(budgetTimeline, monthKeys),
    [budgetTimeline, monthKeys],
  );

  const totalPlanned = useMemo(
    () => (budget?.lines ?? []).reduce((s, l) => s + Number(l.plannedAmount), 0),
    [budget],
  );
  const totalActual = useMemo(
    () => (budget?.lines ?? []).reduce((s, l) => s + Number(l.actualAmount), 0),
    [budget],
  );
  const overUnder = totalActual - totalPlanned;

  const barData = useMemo(() => {
    if (!budget) return [];
    return budget.lines
      .map((l) => ({
        name: l.categoryName,
        Budgeted: Number(l.plannedAmount) || 0,
        Actual: Number(l.actualAmount) || 0,
      }))
      .sort((a, b) => b.Budgeted - a.Budgeted)
      .slice(0, 12);
  }, [budget]);

  return (
    <div className="space-y-6">
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
          <SelectTrigger className="w-44 h-9">
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HeroTile label="Budgeted" value={formatCurrency(totalPlanned)} />
        <HeroTile
          label="Spent"
          value={formatCurrency(totalActual)}
          tone={totalActual > totalPlanned ? "bad" : "good"}
        />
        <HeroTile
          label={overUnder >= 0 ? "Over budget" : "Under budget"}
          value={formatCurrency(Math.abs(overUnder))}
          tone={overUnder > 0 ? "bad" : "good"}
        />
        <HeroTile
          label="Categories tracked"
          value={String(budget?.lines?.length ?? 0)}
          tone="amber"
        />
      </div>

      <ChartCard
        title={`Budgeted vs Actual — ${monthStart.slice(0, 7)}`}
        caption="The classic side-by-side; biggest planned categories first."
        empty={barData.length === 0 ? "All clear — no budget set for this month." : null}
        hideWhenEmpty
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={barData} margin={{ top: 10, right: 16, bottom: 60, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" interval={0} height={70} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="Budgeted" fill={H2_PALETTE.primarySoft} radius={[4, 4, 0, 0]} />
            <Bar dataKey="Actual" fill={H2_PALETTE.primary} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Variance — under vs over"
        caption="Bars that point right are over budget (bad). Left = under (good)."
        empty={variance.length === 0 ? "All clear — nothing to compare yet." : null}
        hideWhenEmpty
        height={Math.max(260, 30 + variance.length * 22)}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={variance} layout="vertical" margin={{ top: 10, right: 24, bottom: 10, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <YAxis dataKey="name" type="category" tick={{ fontSize: 10 }} width={130} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <ReferenceLine x={0} stroke="hsl(var(--foreground))" />
            <Bar dataKey="variance" radius={[0, 6, 6, 0]}>
              {variance.map((v, i) => (
                <Cell key={i} fill={v.variance > 0 ? H2_PALETTE.red : H2_PALETTE.emerald} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Total burn-down"
        caption="Cumulative planned vs actual through the month — see if the household is pacing over."
        empty={burndown.length === 0 ? "All clear — no budget set for this month." : null}
        hideWhenEmpty
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={burndown} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis dataKey="day" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => tooltipMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="planned" stroke={H2_PALETTE.primarySoft} strokeWidth={2} strokeDasharray="6 4" dot={false} name="Planned (paced)" />
            <Line type="monotone" dataKey="actual" stroke={H2_PALETTE.primary} strokeWidth={2.5} dot={false} name="Actual" connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Burn-down by category"
        caption="One line per top-5 budgeted category. Dashed = paced plan, solid = actual cumulative."
        empty={
          perCatBurn.categories.length === 0
            ? "All clear — no budget set for this month."
            : null
        }
        hideWhenEmpty
        height={320}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
            <XAxis
              dataKey="day"
              type="number"
              domain={[1, perCatBurn.daysInMonth]}
              tick={{ fontSize: 10 }}
              allowDuplicatedCategory={false}
            />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => tooltipMoney(v)}
              labelFormatter={(l: number) => `Day ${l}`}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {perCatBurn.categories.map((c, i) => {
              const color = CHART_SERIES[i % CHART_SERIES.length];
              return [
                <Line
                  key={`${c.id}-planned`}
                  data={c.series}
                  type="monotone"
                  dataKey="planned"
                  stroke={color}
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  dot={false}
                  name={`${c.name} · plan`}
                />,
                <Line
                  key={`${c.id}-actual`}
                  data={c.series}
                  type="monotone"
                  dataKey="actual"
                  stroke={color}
                  strokeWidth={2.25}
                  dot={false}
                  connectNulls={false}
                  name={c.name}
                />,
              ];
            })}
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="6-month consistency"
        caption="Cells colored by % of budget used. Green = on plan. Red = blew it. Empty = no budget set that month."
        empty={consistency.length === 0 ? "All clear — set a budget across recent months to compare." : null}
        hideWhenEmpty
        height={Math.max(220, 60 + consistency.length * 28)}
      >
        <div className="overflow-y-auto pr-1 h-full">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-normal pb-1">Category</th>
                {monthKeys.map((mk) => (
                  <th key={mk} className="text-center font-normal pb-1">
                    {mk.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {consistency.slice(0, 12).map((row) => (
                <tr key={row.category}>
                  <td className="py-1 truncate max-w-[140px]">{row.category}</td>
                  {row.cells.map((c, i) => {
                    if (!c)
                      return (
                        <td key={i} className="py-1 px-1">
                          <div className="h-6 rounded bg-muted/40" />
                        </td>
                      );
                    const pct = c.pct;
                    const color =
                      pct >= 100
                        ? H2_PALETTE.red
                        : pct >= 85
                          ? H2_PALETTE.amber
                          : H2_PALETTE.emerald;
                    return (
                      <td key={i} className="py-1 px-1">
                        <div
                          className="h-6 rounded flex items-center justify-center text-[10px] font-mono text-white tabular-nums"
                          style={{ background: color }}
                          title={`${formatCurrency(c.actual)} / ${formatCurrency(c.planned)}`}
                        >
                          {pct >= 999 ? "—" : `${Math.round(pct)}%`}
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
    </div>
  );
}

// --------------------------------------------------------------------------
// BEHAVIOR & FUN
// --------------------------------------------------------------------------

function BehaviorSection({
  txns,
  yearTxns,
  catNameById,
  today,
  budgetTimeline,
  trackers,
}: {
  txns: Transaction[];
  yearTxns: Transaction[];
  catNameById: Map<string, string>;
  today: Date;
  budgetTimeline: (import("@workspace/api-client-react").BudgetMonthDetail | undefined)[];
  trackers: DaysSinceTracker[];
}) {
  const trackerTiles = useMemo(
    () =>
      trackers.map((tr) => {
        const compiled = compileMatcher(tr, catNameById);
        return {
          id: tr.id,
          label: tr.label,
          days: compiled.error
            ? null
            : daysSinceLast(yearTxns, compiled.match, today),
          error: compiled.error,
        };
      }),
    [trackers, yearTxns, today, catNameById],
  );

  const dayOfMonth = useMemo(() => spendByDayOfMonth(txns), [txns]);
  const clock = useMemo(() => hourlySpendClock(txns), [txns]);
  const hallOfFame = useMemo(() => biggest(txns), [txns]);

  const diningStreak = useMemo(
    () =>
      noPurchaseStreak(
        yearTxns,
        (t) =>
          Number(t.amount) < 0 &&
          /(restaurant|dining|doordash|grubhub|uber eats)/i.test(
            (t.description ?? "") + " " + (t.categoryId ? catNameById.get(t.categoryId) ?? "" : ""),
          ),
        today,
      ),
    [yearTxns, today, catNameById],
  );
  const underBudget = useMemo(
    () => underBudgetMonthStreak(budgetTimeline),
    [budgetTimeline],
  );
  const onTrack = useMemo(
    () => onTrackMonthStreak(yearTxns, today, 6),
    [yearTxns, today],
  );

  const radar = useMemo(() => personalityRadar(txns, catNameById), [txns, catNameById]);

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Section · Behavior &amp; Fun"
        title="Money personality, decoded"
        blurb="The streaks, the spikes, and the spending-shaped fingerprint of your month."
      />

      {trackerTiles.length === 0 ? (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="p-5 text-center text-sm text-muted-foreground">
            All clear — no "days since" trackers configured. Add some on the{" "}
            <a href="/settings" className="text-primary underline">Settings</a> page.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {trackerTiles.map((t) => (
            <DaysSinceTile
              key={t.id}
              label={t.label}
              days={t.days}
              error={t.error}
            />
          ))}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <StreakCard
          label="No-dining streak"
          current={diningStreak.current}
          longest={diningStreak.longest}
          unit="days"
        />
        <StreakCard
          label="Under-budget streak"
          current={underBudget.current}
          longest={underBudget.longest}
          unit="months"
        />
        <StreakCard
          label="On-track streak"
          current={onTrack.current}
          longest={onTrack.longest}
          unit="months"
          help="months where income covered expenses"
        />
      </div>

      <div className="grid lg:grid-cols-1 gap-4">
        <Card className="rounded-2xl">
          <CardContent className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Hall of fame
            </div>
            <div className="mt-3 grid sm:grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground">
                  Biggest expense this window
                </div>
                <div className="text-lg font-serif font-semibold tabular-nums text-destructive">
                  {hallOfFame.expense
                    ? formatCurrency(hallOfFame.expense.amount)
                    : "—"}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {hallOfFame.expense?.description ?? ""}
                  {hallOfFame.expense ? ` · ${hallOfFame.expense.date}` : ""}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">
                  Biggest income this window
                </div>
                <div className="text-lg font-serif font-semibold tabular-nums text-[hsl(var(--positive))]">
                  {hallOfFame.income
                    ? formatCurrency(hallOfFame.income.amount)
                    : "—"}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {hallOfFame.income?.description ?? ""}
                  {hallOfFame.income ? ` · ${hallOfFame.income.date}` : ""}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <ChartCard
        title="Hourly spending clock"
        caption="What hours of the day money actually leaves the account."
        empty={
          clock === null
            ? "All clear — no time-of-day data in this window yet (Plaid often ships date only)."
            : clock.every((c) => c.amount === 0)
              ? "All clear — no spending in this window."
              : null
        }
        hideWhenEmpty
        height={280}
      >
        {clock && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={clock} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={1} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
                labelFormatter={(l: string) => `${l}`}
              />
              <Bar dataKey="amount" fill={H2_PALETTE.amber} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard
          title="Spend by day of month"
          caption="Which days money tends to leave — payday, mid-month creep, end-of-month splurges."
          empty={dayOfMonth.every((d) => d.amount === 0) ? "All clear — no spending data yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dayOfMonth} margin={{ top: 10, right: 16, bottom: 24, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={2} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => tooltipMoney(v)}
                labelFormatter={(l: string) => `Day ${l}`}
              />
              <Bar dataKey="amount" fill={H2_PALETTE.violet} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Money personality radar"
          caption="The shape of where your dollars go (relative, not absolute)."
          empty={radar.every((r) => r.value === 0) ? "All clear — no spending data yet." : null}
          hideWhenEmpty
        >
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radar}>
              <PolarGrid />
              <PolarAngleAxis dataKey="axis" tick={{ fontSize: 11 }} />
              <PolarRadiusAxis tick={{ fontSize: 9 }} />
              <Radar
                name="This window"
                dataKey="value"
                stroke={H2_PALETTE.primary}
                fill={H2_PALETTE.primary}
                fillOpacity={0.35}
              />
              <Tooltip contentStyle={tooltipStyle} />
            </RadarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
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
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </div>
          <Flame className="w-4 h-4 text-amber-600" />
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

function DaysSinceTile({
  label,
  days,
  error,
}: {
  label: string;
  days: number | null;
  error?: string | null;
}) {
  const tone = days === null ? "default" : days >= 14 ? "good" : days >= 7 ? "amber" : "bad";
  if (error) {
    return (
      <Card className="rounded-2xl border-dashed" data-testid={`tracker-tile-error-${label}`}>
        <CardContent className="p-5 text-center">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Days since last
          </div>
          <div className="text-lg font-serif font-semibold mt-1">{label}</div>
          <div className="text-sm text-amber-700 dark:text-amber-400 mt-3">
            Couldn't read this rule
          </div>
          <div
            className="text-[11px] text-muted-foreground mt-1 italic truncate"
            title={error}
          >
            Edit it on the Settings page.
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="rounded-2xl border-dashed">
      <CardContent className="p-5 text-center">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Days since last
        </div>
        <div className="text-lg font-serif font-semibold mt-1">{label}</div>
        <div
          className={cn(
            "text-5xl font-serif font-bold tabular-nums mt-2",
            tone === "good" && "text-emerald-700 dark:text-emerald-400",
            tone === "amber" && "text-amber-700 dark:text-amber-400",
            tone === "bad" && "text-destructive",
          )}
        >
          {days ?? "—"}
        </div>
      </CardContent>
    </Card>
  );
}
