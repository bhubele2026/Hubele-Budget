import { useMemo, useState, type ReactNode } from "react";
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
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, PiggyBank, CreditCard, TrendingDown, RefreshCcw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DrillBreadcrumb } from "@/components/drill-breadcrumb";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import {
  resolveAmexRevolvingBalance,
  describeReportsAmexTileSub,
  AMEX_BALANCE_DISTINCTION,
  cashBufferStatusMeta,
  type CashSignalStatus,
} from "@/lib/reportsBalances";
import { formatCurrency } from "@/lib/utils";
import { fmtISO } from "@/lib/reportsAnalytics";
import { HeroTile } from "./shared";

export const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
];

/**
 * Shared data layer for every Reports drill page. Each routed sub-page calls
 * this with its own range/month state; React Query dedupes the underlying
 * fetches so the five pages share one set of network requests. Lifted
 * verbatim from the old tabbed ReportsPage — no money math changed.
 */
export function useReportsData(rangeDays: number, monthOffset: number) {
  const today = useMemo(() => new Date(), []);

  const fromDate = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - rangeDays);
    return d;
  }, [today, rangeDays]);
  const prevFromDate = useMemo(() => {
    const d = new Date(fromDate);
    d.setDate(d.getDate() - rangeDays);
    return d;
  }, [fromDate, rangeDays]);
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

  const excludedCategoryIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of categories ?? []) {
      if (c.excludeFromBudget) s.add(c.id);
    }
    return s;
  }, [categories]);

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

  const budgetMonthStart = useMemo(() => {
    const d = new Date(today.getFullYear(), today.getMonth() - monthOffset, 1);
    return fmtISO(d);
  }, [today, monthOffset]);

  return {
    today,
    fromDate,
    txns,
    txnsLoading,
    categories,
    debts,
    debtBalanceHistory,
    avSettings,
    avExtra,
    recurringItems,
    forecast,
    catNameById,
    excludedCategoryIds,
    rangeTxns,
    prevRangeTxns,
    budgetMonthStart,
  };
}

/**
 * Per-page Claude narrative. Opt-in (LLM call is billable) so opening a
 * report page is instant + free until the user asks for the read.
 */
export function AdvisorSummaryCard({
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

/** Four at-a-glance balance tiles — the household's live vitals. */
export function ReportsBalanceTiles({
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
  const amexNoCardLinked = !amex.blueCash.present && !amex.platinum.present;
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
          amexNoCardLinked ? { label: "Link your Amex", href: "/amex" } : undefined
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

/** Range select + compare-to-previous toggle, shared by sub-pages that need it. */
export function ReportsRangeControls({
  rangeDays,
  setRangeDays,
  compareToPrev,
  setCompareToPrev,
  showCompare = true,
}: {
  rangeDays: string;
  setRangeDays: (v: string) => void;
  compareToPrev?: boolean;
  setCompareToPrev?: (v: boolean) => void;
  showCompare?: boolean;
}) {
  return (
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
      {showCompare && setCompareToPrev && (
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
      )}
    </div>
  );
}

/** Wrapper for a Reports drill destination: breadcrumb + editorial header. */
export function ReportShell({
  crumb,
  title,
  blurb,
  children,
}: {
  crumb: string;
  title: string;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <DrillBreadcrumb items={[{ label: "Reports", href: "/reports" }, { label: crumb }]} />
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground mt-1 leading-tight">
          {title}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{blurb}</p>
        <div className="border-t border-border mt-5" />
      </div>
      {children}
    </div>
  );
}
