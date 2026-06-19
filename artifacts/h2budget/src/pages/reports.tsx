import { useMemo, useState } from "react";
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
  type ForecastBundle,
  type GetReportsAdvisorSummaryParams,
  type GetReportsAdvisorSummaryTab,
} from "@workspace/api-client-react";
import { AiInsightBar } from "@/components/ai-insight-bar";
import { SubscriptionInsightsSection } from "@/components/subscription-insights";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import {
  resolveAmexRevolvingBalance,
  describeReportsAmexTileSub,
  AMEX_BALANCE_DISTINCTION,
  cashBufferStatusMeta,
  type CashSignalStatus,
} from "@/lib/reportsBalances";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/utils";
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
  PiggyBank,
  CreditCard,
  TrendingDown,
  RefreshCcw,
  Loader2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { fmtISO } from "@/lib/reportsAnalytics";
import { HeroTile } from "./reports/shared";
import { DebtSection } from "./reports/DebtSection";
import { CashFlowSection } from "./reports/CashFlowSection";
import { SpendingSection } from "./reports/SpendingSection";
import { BudgetSection } from "./reports/BudgetSection";
import { BehaviorSection } from "./reports/BehaviorSection";

const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
];

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
    query: {
      enabled: show,
      queryKey: getGetReportsAdvisorSummaryQueryKey(params),
    },
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
            aria-label="Regenerate"
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
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
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
    <div className="space-y-6">
      {/* Editorial header */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Section V
        </div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground mt-0.5 leading-tight">
          Reports
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your money, told as a story — debt momentum, cash flow, where it all
          went, and a few surprises.
        </p>
        <div className="border-t border-border mt-5" />
      </div>

      <AiInsightBar />

      {/* (Play B) At-a-glance balance tiles — formerly the Dashboard */}
      <ReportsBalanceTiles forecast={forecast} />

      {/* Global controls */}
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <Label className="text-xs uppercase tracking-widest text-muted-foreground">
            Range
          </Label>
          <Select value={rangeDays} onValueChange={setRangeDays}>
            <SelectTrigger className="w-44 h-9" aria-label="Report date range">
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
