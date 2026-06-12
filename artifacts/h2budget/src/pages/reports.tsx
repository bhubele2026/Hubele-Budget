import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useListTransactions,
  useListCategories,
  useListDebts,
  useListDebtBalanceHistory,
  useGetAvalancheSettings,
  useGetAvalancheExtra,
  useListRecurringItems,
  useGetForecast,
  useGetForecastCashSignal,
  useGetDashboard,
  useListPlaidLiabilityAccounts,
  useGetReportsAdvisorSummary,
  getReportsAdvisorSummary,
  getGetReportsAdvisorSummaryQueryKey,
  useGetReportsSpendingFacts,
  getGetReportsSpendingFactsQueryKey,
  useGetReportsBehaviorFacts,
  useGetReportsBudgetFacts,
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
import { SubscriptionInsightsSection } from "@/components/subscription-insights";
import { useToast } from "@/hooks/use-toast";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import {
  resolveAmexRevolvingBalance,
  describeReportsAmexTileSub,
  AMEX_BALANCE_DISTINCTION,
  cashBufferStatusMeta,
  type CashSignalStatus,
} from "@/lib/reportsBalances";
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
import {
  Trophy,
  Flame,
  Calendar,
  TrendingUp,
  TrendingDown,
  PiggyBank,
  CreditCard,
  ArrowRight,
  Sparkles,
  RefreshCcw,
  Loader2,
  Wand2,
  Check,
  Clock,
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
  debtToSim,
  payoffStackedSeries,
  snowballWaterfall,
  interestVsPrincipal,
  perDebtProgress,
  totalPaidOffSoFar,
  totalBalanceHistory,
  debtsKilledOrder,
  debtFreeCountdown,
  totalsForDebts,
  simulate,
  interestIfMinimumsOnly,
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
  // Confetti celebration removed by request.
}

// --- Small visual building blocks -----------------------------------------

function HeroTile({
  label,
  value,
  sub,
  tone = "default",
  icon,
  delta,
  badge,
  action,
  tooltip,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "bad" | "amber";
  icon?: React.ReactNode;
  delta?: { pct: number; goodIfUp: boolean } | null;
  badge?: string;
  action?: { label: string; href: string };
  // (#884) Optional hover hint, surfaced via the native title attribute.
  // Used by the Amex tile to explain why its "current balance" can differ
  // from the Amex page's projected end-of-month figure.
  tooltip?: string;
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
    <Card className="rounded-2xl" title={tooltip}>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </div>
          {icon && <div className="text-muted-foreground/70">{icon}</div>}
        </div>
        <div className="mt-2 flex items-baseline gap-2 flex-wrap">
          <div
            className={cn(
              "text-3xl md:text-4xl font-serif font-bold tabular-nums truncate",
              toneClass,
            )}
          >
            {value}
          </div>
          {badge && (
            <Badge variant="secondary" className="tabular-nums shrink-0">
              {badge}
            </Badge>
          )}
        </div>
        {sub && (
          <div className="text-xs text-muted-foreground mt-1">{sub}</div>
        )}
        {action && (
          <Link
            href={action.href}
            className="text-xs font-medium text-primary hover:underline mt-1 inline-flex items-center gap-1"
          >
            {action.label}
            <ArrowRight className="w-3 h-3" />
          </Link>
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
  // On-demand: don't auto-fire the (LLM-backed, billable) AI summary. The
  // user opts in per tab, so opening Reports is instant and costs nothing
  // unless they actually ask for the AI read.
  const [show, setShow] = useState(false);

  const params: GetReportsAdvisorSummaryParams = useMemo(
    () => ({ tab, rangeDays, monthOffset }),
    [tab, rangeDays, monthOffset],
  );
  const { data, isLoading } = useGetReportsAdvisorSummary(params, {
    query: { enabled: show },
  });

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
            disabled={!show || refreshing || isLoading}
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
        {!show ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShow(true)}
            data-testid={`button-advisor-generate-${tab}`}
          >
            <Sparkles className="w-3.5 h-3.5 mr-1.5 text-primary" />
            Explain these numbers
          </Button>
        ) : isLoading || !data ? (
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
}: {
  forecast: ForecastBundle | null | undefined;
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

  const { data: amexCardAccounts } = useListPlaidLiabilityAccounts();
  const amex = useMemo(
    () => resolveAmexRevolvingBalance(amexCardAccounts),
    [amexCardAccounts],
  );
  const amexValue = amex.found ? formatCurrency(amex.total) : "—";
  // No revolving Amex card was found in the Plaid liability-account list
  // at all (as opposed to a card being present but lacking a usable
  // balance). Only in that empty state do we nudge the user to link one.
  const amexNoCardLinked = !amex.blueCash.present && !amex.platinum.present;
  // (#884) When at least one card is present, describeReportsAmexTileSub
  // prefixes the sub-line with "Current balance ·" so the tile reads as
  // the live current balance (distinct from the Amex page's projected
  // end-of-month figure).
  const amexSub = amexNoCardLinked
    ? "Link an Amex card to track your revolving balance"
    : describeReportsAmexTileSub(amex);

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
        action={
          amexNoCardLinked
            ? { label: "Link your Amex", href: "/amex" }
            : undefined
        }
        tooltip={amex.found ? AMEX_BALANCE_DISTINCTION.reportsTooltip : undefined}
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

  // Selected month for budget tab. (#854 Phase 2) The Budget tab now renders
  // entirely from GET /reports/budget-facts inside BudgetSection, so the parent
  // only needs the selected month start — the old per-month useGetBudgetMonth
  // timeline fetches were removed with the client-side analytics rebuild.
  const budgetMonthStart = useMemo(() => {
    const d = new Date(today.getFullYear(), today.getMonth() - Number(monthOffset), 1);
    return fmtISO(d);
  }, [today, monthOffset]);

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
      <ReportsBalanceTiles forecast={forecast} />

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
          />
        </TabsContent>

        <TabsContent value="behavior" className="space-y-6">
          <AdvisorSummaryCard tab="behavior" rangeDays={Number(rangeDays)} monthOffset={Number(monthOffset)} />
          <BehaviorSection from={fmtISO(fromDate)} to={fmtISO(today)} />
          <SubscriptionInsightsSection
            recurringItems={recurringItems}
            txns={txns}
            catNameById={catNameById}
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
            ? "Total household debt over time, trending down as you pay off. Balances before a debt was linked are approximated, and the final point reflects current balances (paid-off debts drop to $0)."
            : "We're collecting daily snapshots — the curve fills in as you pay down."
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

function BudgetSection({
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
        <Card className="rounded-2xl">
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
        <Card className="rounded-2xl">
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
        <Card className="rounded-2xl">
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
        <Card className="rounded-2xl">
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
        <Card className="rounded-2xl">
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

// --------------------------------------------------------------------------
// BEHAVIOR & FUN
// --------------------------------------------------------------------------

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

function BehaviorSection({ from, to }: { from: string; to: string }) {
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
            <Skeleton key={i} className="h-28 rounded-2xl" />
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
        <Card className="rounded-2xl border-dashed">
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
      <Card className="rounded-2xl">
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
    <Card className="rounded-2xl">
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

