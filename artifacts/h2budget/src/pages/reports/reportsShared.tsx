import { useMemo, type ReactNode } from "react";
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
  type ForecastBundle,
} from "@workspace/api-client-react";
import { PiggyBank, CreditCard, TrendingDown } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TimeRangeToggle } from "@/components/time-range-toggle";
import { rangeForMode, rangeDays as rangeDaysOf, type RangeMode } from "@/lib/timeRange";
import { DrillBreadcrumb } from "@/components/drill-breadcrumb";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import {
  resolveAmexRevolvingBalance,
  describeReportsAmexTileSub,
  cashBufferStatusMeta,
  type CashSignalStatus,
} from "@/lib/reportsBalances";
import { formatCurrency } from "@/lib/utils";
import { fmtISO } from "@/lib/reportsAnalytics";
import { StatTile, StatTileRow } from "@/components/stat-tile";

export const RANGES = [
  { value: "30", label: "Last 30 days" },
  { value: "60", label: "Last 60 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
];

/**
 * Day-span for a Wk/Mo/Yr mode, fed into useReportsData(rangeDays). Weekly-
 * first: "wk" is the default everywhere and resolves to the current Sun–Sat
 * week's span; mo/yr are opt-in.
 */
export function daysForMode(mode: RangeMode): number {
  return rangeDaysOf(rangeForMode(mode));
}

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
  // (#perf-3) Fetch only the window the page actually aggregates: the selected
  // range + its previous period (for the compare), with a 95-day floor so the
  // behavior page's subscription enrichment still has context, capped at the
  // prior 365-day max so the Yr view is unchanged. The default Wk/Mo views now
  // pull ~95 days instead of a full year (the old 1.57 MB / limit=5000 fetch).
  // rangeTxns / prevRangeTxns are byte-identical — same rows, just scoped at the
  // server instead of filtered from a year client-side.
  const fetchFromDate = useMemo(() => {
    const span = Math.min(Math.max(rangeDays * 2 + 7, 95), 365);
    const d = new Date(today);
    d.setDate(d.getDate() - span);
    return d;
  }, [today, rangeDays]);

  const { data: txns, isLoading: txnsLoading } = useListTransactions({
    from: fmtISO(fetchFromDate),
    to: fmtISO(today),
    limit: 2000,
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

  // GET OUT OF DEBT is the spine — Total Debt wears the hero gradient.
  const amexValueNode =
    amex.found && amex.total > 0 ? (
      <span className="text-[hsl(var(--negative))]">{amexValue}</span>
    ) : (
      amexValue
    );
  return (
    <StatTileRow>
      <StatTile
        label="Total Debt"
        value={totalDebtValue}
        sub={totalDebtSub}
        active
        icon={<TrendingDown className="w-4 h-4" />}
      />
      <StatTile
        label="Bank Balance"
        value={bankValue}
        sub={bankSub}
        icon={<PiggyBank className="w-4 h-4" />}
      />
      <StatTile
        label="Amex"
        value={amexValueNode}
        sub={amexSub}
        icon={<CreditCard className="w-4 h-4" />}
        href={amexNoCardLinked ? "/amex" : undefined}
      />
      <StatTile
        label="Cash Buffer"
        value={statusMeta.label}
        sub={cashSub}
        icon={<PiggyBank className="w-4 h-4" />}
      />
    </StatTileRow>
  );
}

/** Weekly-first Wk/Mo/Yr toggle + compare switch, shared by sub-pages. */
export function ReportsRangeControls({
  mode,
  setMode,
  compareToPrev,
  setCompareToPrev,
  showCompare = true,
}: {
  mode: RangeMode;
  setMode: (m: RangeMode) => void;
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
        <TimeRangeToggle value={mode} onChange={setMode} />
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
        <DrillBreadcrumb
          items={[
            { label: "Dashboard", href: "/home" },
            { label: "Reports", href: "/reports" },
            { label: crumb },
          ]}
        />
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
