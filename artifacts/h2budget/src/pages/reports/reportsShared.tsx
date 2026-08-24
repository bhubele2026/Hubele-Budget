// The ONE shared module for the Reports family: recharts type-wrappers, the
// HeroTile/ChartCard visual blocks, tooltip helpers, the balance-tile row,
// range controls, and the drill-page shell. Data fetching lives in each page —
// every report page mounts only the hooks for what it actually renders (the
// old shared-hook fan-out fired 11 network hooks on every sub-page).
import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
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
  ReferenceLine as ReferenceLineRaw,
  type AreaProps,
  type BarProps,
  type LegendProps,
  type LineProps,
  type PieProps,
  type ReferenceLineProps,
  type TooltipProps,
  type XAxisProps,
  type YAxisProps,
} from "recharts";
import {
  useGetDashboard,
  useGetForecastCashSignal,
  useListDebts,
  useListPlaidLiabilityAccounts,
  type ForecastBundle,
} from "@workspace/api-client-react";
import { pendingPaymentTotalOf } from "@/lib/debtBalance";
import { ArrowRight, PiggyBank, CreditCard, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { useCountUp } from "@/hooks/useCountUp";
import { formatCurrency, cn } from "@/lib/utils";
import { StatTile, StatTileRow } from "@/components/stat-tile";

// Recharts ships these as class components, which TypeScript + React 19's
// @types/react can no longer accept as JSX element constructors. Re-bind each
// to a function-component shape that preserves the component's own prop type.
type FCFromProps<P> = (props: P) => React.ReactElement | null;
export const Line = LineRaw as unknown as FCFromProps<LineProps>;
export const Area = AreaRaw as unknown as FCFromProps<AreaProps>;
export const Bar = BarRaw as unknown as FCFromProps<BarProps>;
export const XAxis = XAxisRaw as unknown as FCFromProps<XAxisProps>;
export const YAxis = YAxisRaw as unknown as FCFromProps<YAxisProps>;
export const Tooltip = TooltipRaw as unknown as FCFromProps<TooltipProps<number, string>>;
export const Legend = LegendRaw as unknown as FCFromProps<LegendProps>;
export const Pie = PieRaw as unknown as FCFromProps<PieProps>;
export const ReferenceLine = ReferenceLineRaw as unknown as FCFromProps<ReferenceLineProps>;

// Recharts primitives that don't need the FC re-bind, re-exported so the
// report pages can pull their whole chart toolkit from one place.
export {
  ResponsiveContainer,
  LineChart,
  AreaChart,
  BarChart,
  ComposedChart,
  CartesianGrid,
  PieChart,
  Cell,
};

/**
 * Day-span for a Wk/Mo/Yr mode, fed into each page's date-window derivation.
 * Weekly-first: "wk" is the default everywhere and resolves to the current
 * Sun–Sat week's span; mo/yr are opt-in.
 */
export function daysForMode(mode: RangeMode): number {
  return rangeDaysOf(rangeForMode(mode));
}

// --- Small visual building blocks -----------------------------------------

export function HeroTile({
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
  void icon;
  // (#wow) Count currency figures up on load; pass non-currency values
  // (dates, "Not Yet", "∞") through untouched.
  const numericTarget = useMemo(() => {
    if (!value.includes("$")) return null;
    const n = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }, [value]);
  const counted = useCountUp(numericTarget);
  const displayValue = numericTarget != null ? formatCurrency(counted) : value;
  return (
    <Card className="rounded-lg" title={tooltip}>
      <CardContent className="p-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </div>
        <div className="mt-1.5 flex items-baseline gap-2 flex-wrap">
          <div
            className={cn(
              "text-[1.9rem] md:text-[2.1rem] font-semibold tracking-[-0.02em] tabular-nums truncate leading-none",
              toneClass,
            )}
          >
            {displayValue}
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

export function ChartCard({
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
    <Card className="rounded-lg">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-display">{title}</CardTitle>
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

export function tooltipMoney(v: number | string) {
  return formatCurrency(v);
}

export const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--card-border))",
  color: "hsl(var(--card-foreground))",
  borderRadius: 8,
  fontSize: 12,
  boxShadow: "var(--shadow-md)",
};

/** Four at-a-glance balance tiles — the household's live vitals. */
export function ReportsBalanceTiles({
  forecast,
}: {
  forecast: ForecastBundle | null | undefined;
}) {
  const { data: dashboard } = useGetDashboard();
  // Shared {horizonDays: 90} key — see avalanche-ready-card.tsx.
  const { data: cashSignal } = useGetForecastCashSignal({ horizonDays: 90 });

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

  // (C10) `dashboard.totalDebt` is now NETTED server-side — it used to be a
  // raw `sum(debts.balance)` in SQL, which is why this tile could sit on the
  // same screen as the netted Debts/Avalanche figures and quote a bigger
  // number. Since it nets, it discloses: the same "−$X pending" phrasing the
  // per-debt `DebtPendingHint` uses, aggregated, because this tile is a total
  // and there is no single debt to hang the per-row hint on.
  // ⚠️ `useListDebts` here costs no request: the only caller of this component
  // (`pages/reports.tsx`) already holds that query, so this reads its cache.
  const { data: debtsForPending } = useListDebts();
  const pendingTotal = useMemo(
    () =>
      (debtsForPending ?? []).reduce((s, d) => s + pendingPaymentTotalOf(d), 0),
    [debtsForPending],
  );
  const totalDebtValue =
    dashboard != null ? formatCurrency(dashboard.totalDebt) : "—";
  const activeDebtCount = dashboard?.activeDebtCount ?? 0;
  const totalDebtSub =
    dashboard != null
      ? `${activeDebtCount} active debt${activeDebtCount === 1 ? "" : "s"}${
          pendingTotal > 0 ? ` · −${formatCurrency(pendingTotal)} pending` : ""
        }`
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
