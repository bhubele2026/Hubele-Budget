// The ONE shared module for the Reports family: recharts type-wrappers, the
// ChartCard block, the shared tooltip surface, the balance-tile row, range
// controls, and the drill-page shell. Data fetching lives in each page — every
// report page mounts only the hooks for what it actually renders (the old
// shared-hook fan-out fired 11 network hooks on every sub-page).
//
// ⚠️ This module statically imports recharts (~450 KB). Everything that
// imports it must stay on a LAZY route chunk; `scripts/check-entry-graph.mjs`
// fails the build if a recharts fingerprint reaches the landing graph.
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
import { Switch } from "@/components/ui/switch";
import { TimeRangeToggle } from "@/components/time-range-toggle";
import { rangeForMode, rangeDays as rangeDaysOf, type RangeMode } from "@/lib/timeRange";
import { deriveEffectiveSnapshot } from "@/lib/effectiveSnapshot";
import {
  AMEX_BALANCE_DISTINCTION,
  resolveAmexRevolvingBalance,
  describeReportsAmexTileSub,
  cashBufferStatusMeta,
  type CashSignalStatus,
} from "@/lib/reportsBalances";
import { formatCurrency, cn } from "@/lib/utils";
import { CHART } from "@/lib/chartTokens";
import { card, cardHead, emptyNote, fieldLabel, Stat, Help } from "@/ui";

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

// --- Chart chrome ---------------------------------------------------------

/** Axis ticks + legend, on the kit's type scale. One object, every chart. */
export const AXIS_TICK = { fontSize: 11, fill: "#64748b" } as const;
export const LEGEND_STYLE = { fontSize: 11 } as const;
/** Money on an axis, short enough to fit a ~55px tick. */
export const axisMoney = (v: number) => `$${Math.round(v).toLocaleString()}`;
export const axisMoneyK = (v: number) => `$${Math.round(v / 1000)}k`;

export function tooltipMoney(v: number | string) {
  return formatCurrency(v);
}

/**
 * The kit's tooltip surface — a white card with the brand hairline, replacing
 * recharts' grey-outline default. Hex literals rather than `hsl(var(--…))`
 * because recharts writes these into an inline style on an element outside
 * the themed subtree.
 */
export const tooltipStyle = {
  background: "#ffffff",
  border: `1px solid ${CHART.grid}`,
  color: "#1a2233",
  borderRadius: 8,
  fontSize: 12,
  boxShadow: "0 6px 24px -8px rgb(25 49 91 / 0.18)",
};

/** Grid stroke, so no page hand-rolls one. */
export const GRID_STROKE = CHART.grid;

// --- Small visual building blocks -----------------------------------------

/**
 * A chart in a kit card.
 *
 * ⭐ WHERE THE CAPTIONS WENT. Every one of these used to carry a sentence
 * under the title ("The classic line — income up top, expense below"). The
 * sentence is not deleted, it is demoted to the `Help` chip in the head:
 * the face carries the title, the explanation is one hover away.
 */
export function ChartCard({
  title,
  help,
  empty,
  hideWhenEmpty,
  children,
  height = 320,
  right,
  testId,
}: {
  title: string;
  /** The disclosure — what this counts, or which basis it uses. */
  help?: string;
  empty?: string | null;
  hideWhenEmpty?: boolean;
  children: ReactNode;
  height?: number;
  /** Optional control rendered at the right of the card head. */
  right?: ReactNode;
  testId?: string;
}) {
  if (empty && hideWhenEmpty) return null;
  return (
    <div className={card} data-testid={testId}>
      <div className={cardHead}>
        <span className={cn(fieldLabel, "flex-1 truncate")}>{title}</span>
        {help && <Help>{help}</Help>}
        {right}
      </div>
      {empty ? (
        <div className={emptyNote} style={{ height }}>
          <span className="flex h-full items-center justify-center">{empty}</span>
        </div>
      ) : (
        <div className="px-4 py-3" style={{ height: height + 24 }}>
          <div style={{ height }}>{children}</div>
        </div>
      )}
    </div>
  );
}

/**
 * A plain card with a kit head — for the blocks that are a list or a figure
 * rather than a chart. Same head geometry as `ChartCard` so titles line up
 * down the page.
 */
export function PanelCard({
  title,
  help,
  children,
  right,
  className,
  testId,
}: {
  title: string;
  help?: string;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn(card, className)} data-testid={testId}>
      <div className={cardHead}>
        <span className={cn(fieldLabel, "flex-1 truncate")}>{title}</span>
        {help && <Help>{help}</Help>}
        {right}
      </div>
      {children}
    </div>
  );
}

/** Four at-a-glance balance tiles — the household's live vitals. */
export function ReportsBalanceTiles({
  forecast,
}: {
  forecast: ForecastBundle | null | undefined;
}) {
  const { data: dashboard } = useGetDashboard();
  // Shared {horizonDays: 90} key.
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

  return (
    <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        index={0}
        label="Total debt"
        value={totalDebtValue}
        hint={totalDebtSub}
        data-testid="reports-tile-total-debt"
      />
      <Stat
        index={1}
        label="Bank balance"
        value={bankValue}
        hint={bankSub}
        data-testid="reports-tile-bank"
      />
      {/* (#884/#887) The Amex tile carries hover copy explaining why this
          CURRENT balance can differ from the Amex page's projected
          end-of-month figure — and carries it only when there IS a live
          balance to explain.

          ⚠️ This was lost in a refactor: the tooltip shipped on `HeroTile`,
          then `ReportsBalanceTiles` moved to `StatTile`, which has no title
          prop, and nothing put it back. `e2e/reports-amex-tile.spec.ts` still
          asserts it (against a `div.rounded-2xl` locator that also no longer
          matches anything), so the spec has been red rather than guarding it.
          Restored here on a wrapper we control, with a testid so the spec can
          stop matching on class names. */}
      <div
        title={amexNoCardLinked ? undefined : AMEX_BALANCE_DISTINCTION.reportsTooltip}
        data-testid="reports-tile-amex"
      >
        <Stat
          index={2}
          label="Amex (Blue Cash + Platinum)"
          value={amexValue}
          hint={amexSub}
          tone={amex.found && amex.total > 0 ? "bad" : "navy"}
        />
      </div>
      <Stat
        index={3}
        label="Cash buffer"
        value={statusMeta.label}
        hint={cashSub}
        data-testid="reports-tile-cash-buffer"
      />
    </div>
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
    <div className="flex flex-wrap items-center gap-5">
      <div className="flex items-center gap-2">
        <span className={fieldLabel}>Range</span>
        <TimeRangeToggle value={mode} onChange={setMode} />
      </div>
      {showCompare && setCompareToPrev && (
        <div className="flex items-center gap-2">
          <Switch
            id="cmp-prev"
            checked={compareToPrev}
            onCheckedChange={setCompareToPrev}
          />
          <label htmlFor="cmp-prev" className={cn(fieldLabel, "cursor-pointer")}>
            Compare to previous
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * Wrapper for a Reports drill destination: the trail back up, the title, and
 * the page's own controls on the same baseline as the title — the house
 * header shape, matching Budget and Allowances.
 */
export function ReportShell({
  crumb,
  title,
  children,
  controls,
}: {
  crumb: string;
  title: string;
  /** Range toggles etc., rendered on the title row rather than under it. */
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-1 text-micro text-neutral-400">
        <Link
          href="/reports"
          className="press rounded px-1 py-0.5 font-medium text-neutral-500 hover:bg-neutral-100 hover:text-brand-navy"
        >
          Reports
        </Link>
        <span aria-hidden className="text-neutral-300">
          ›
        </span>
        <span className="px-1 py-0.5 text-neutral-400">{crumb}</span>
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display font-semibold text-brand-navy">{title}</h1>
        {controls}
      </div>
      {children}
    </div>
  );
}
