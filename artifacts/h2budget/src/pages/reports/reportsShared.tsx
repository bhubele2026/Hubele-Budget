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
// (C0) Through the kit, never from "recharts" directly (`chartsDoor.test.ts`).
import {
  RcResponsiveContainer as ResponsiveContainer,
  RcLineChart as LineChart,
  RcLine as LineRaw,
  RcAreaChart as AreaChart,
  RcArea as AreaRaw,
  RcBarChart as BarChart,
  RcBar as BarRaw,
  RcComposedChart as ComposedChart,
  RcXAxis as XAxisRaw,
  RcYAxis as YAxisRaw,
  RcCartesianGrid as CartesianGrid,
  RcTooltip as TooltipRaw,
  RcLegend as LegendRaw,
  RcPieChart as PieChart,
  RcPie as PieRaw,
  RcCell as Cell,
  RcReferenceLine as ReferenceLineRaw,
  type RcAreaProps as AreaProps,
  type RcBarProps as BarProps,
  type RcLegendProps as LegendProps,
  type RcLineProps as LineProps,
  type RcPieProps as PieProps,
  type RcReferenceLineProps as ReferenceLineProps,
  type RcTooltipProps as TooltipProps,
  type RcXAxisProps as XAxisProps,
  type RcYAxisProps as YAxisProps,
} from "@/lib/charts";
import {
  useGetDashboard,
  useListDebts,
  useListPlaidLiabilityAccounts,
  type ForecastBundle,
} from "@workspace/api-client-react";
import { useSpine } from "@/hooks/useSpine";
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
import { moneyFace } from "@/components/data-state";
import { CHART } from "@/lib/chartTokens";
import { emptyNote, fieldLabel, Help } from "@/ui";
import { Panel, StatBlock, type PanelSpan } from "@/components/next";
import { useCountUp } from "@/hooks/useCountUp";

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
 * A chart in a panel.
 *
 * ⭐ WHERE THE CAPTIONS WENT. Every one of these used to carry a sentence
 * under the title ("The classic line — income up top, expense below"). The
 * sentence is not deleted, it is demoted to the `Help` chip in the head:
 * the face carries the title, the explanation is one hover away.
 *
 * (C1) A `Panel` on the 12-column grid. `span` places it; the chart box keeps
 * its fixed inline `height` (a `ResponsiveContainer` needs a sized parent).
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
  banner,
  span = 12,
  className,
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
  /**
   * A notice between the head and the body, such as a refresh-failed
   * `RefreshBanner`. ⚠️ It sits OUTSIDE the fixed-height chart box and grows
   * the card instead. Inside the box it took its height from the chart and
   * pushed the chart's bottom, date labels included, past the card's clipped
   * edge. It shows over the empty state too.
   */
  banner?: ReactNode;
  span?: PanelSpan;
  className?: string;
}) {
  if (empty && hideWhenEmpty) return null;
  return (
    <Panel
      title={title}
      span={span}
      variant="static"
      data-testid={testId}
      className={cn("tile-in", className)}
      actions={
        help || right ? (
          <>
            {help && <Help>{help}</Help>}
            {right}
          </>
        ) : undefined
      }
    >
      {banner ? <div className="mb-3">{banner}</div> : null}
      {empty ? (
        <div className={emptyNote} style={{ height }}>
          <span className="flex h-full items-center justify-center">{empty}</span>
        </div>
      ) : (
        <div style={{ height }}>{children}</div>
      )}
    </Panel>
  );
}

/**
 * A plain panel — for the blocks that are a list or a figure rather than a
 * chart. Flush: the contents pad their own rows, as they always did.
 */
export function PanelCard({
  title,
  help,
  children,
  right,
  className,
  testId,
  span = 12,
}: {
  title: string;
  help?: string;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
  testId?: string;
  span?: PanelSpan;
}) {
  return (
    <Panel
      title={title}
      span={span}
      variant={["static", "flush"]}
      data-testid={testId}
      className={cn("tile-in", className)}
      actions={
        help || right ? (
          <>
            {help && <Help>{help}</Help>}
            {right}
          </>
        ) : undefined
      }
    >
      {children}
    </Panel>
  );
}

/**
 * A KPI on the grid: the panel surface around a `StatBlock`. Same props as
 * the classic `Stat` (a plain number rises into place; anything pre-formatted
 * is shown as given). `navy` and `ok` are both the resting tone.
 */
export function Stat(props: {
  value: ReactNode;
  label: string;
  hint?: ReactNode;
  tone?: "ok" | "bad" | "navy";
  index?: number;
  /** `null` leaves placement to the parent (a wrapper that is the grid item). */
  span?: PanelSpan | null;
  "data-testid"?: string;
}) {
  const counted = useCountUp(typeof props.value === "number" ? props.value : null);
  const shown = typeof props.value === "number" ? String(Math.round(counted)) : props.value;
  const span = props.span === undefined ? 3 : props.span;
  return (
    <div
      className={cn("panel tile-in p-4", span != null && `span-${span}`)}
      style={
        props.index != null
          ? { animationDelay: `calc(${Math.min(props.index, 12)} * var(--stagger))` }
          : undefined
      }
    >
      <StatBlock
        label={props.label}
        value={shown}
        hint={props.hint}
        tone={props.tone === "bad" ? "bad" : "neutral"}
        data-testid={props["data-testid"]}
      />
    </div>
  );
}

/**
 * Four at-a-glance balance tiles — the household's live vitals.
 *
 * ⚠️ THE MONEY HERE IS READ, NEVER DERIVED. Two of these tiles used to compute
 * their own figures, and both could disagree with the page they sit above:
 *
 *   - Bank showed the raw `bankSnapshot` balance, while everything else in the
 *     app (landing, Forecast Overview, the spine) shows that snapshot ROLLED
 *     FORWARD through the ledger. On any day with activity since the snapshot
 *     was taken, Reports quoted a different bank balance than Forecast did.
 *   - Cash buffer took its verdict and its buffer from a second cash-signal
 *     request while the low point beside it came from the spine, so the word
 *     and the number could describe two different instants.
 *
 * Both now read `useSpine()`. The `forecast` bundle stays for the account's
 * NAME — a label, not a figure.
 */
export function ReportsBalanceTiles({
  forecast,
  forecastError = false,
}: {
  forecast: ForecastBundle | null | undefined;
  /** The forecast bundle's query failed: with no bundle, the bank hint says so. */
  forecastError?: boolean;
}) {
  const { data: dashboard } = useGetDashboard();
  const { data: spine, state: spineState } = useSpine();

  const bankSnapshot = forecast?.bankSnapshot ?? null;
  const accountSnapshots = forecast?.accountSnapshots ?? {};
  const plaidCheckingAccounts = forecast?.plaidCheckingAccounts ?? [];
  // Identity only — which account the figure belongs to, and where it came
  // from. The BALANCE is the spine's.
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

  const bankValue =
    spine?.bank?.balance != null ? formatCurrency(spine.bank.balance) : "—";
  const bankSub = effective
    ? `${effective.source === "plaid" ? "Plaid" : "Manual"} · ${effective.name ?? "Bank"}${effective.mask ? ` ··${effective.mask}` : ""}`
    : forecast === undefined
      ? forecastError
        ? "Couldn't load"
        : undefined // the bundle has not answered: no claim about a snapshot yet
      : "No checking snapshot yet";

  const { data: amexCardAccounts, isError: amexCardAccountsError } = useListPlaidLiabilityAccounts();
  const amex = useMemo(
    () => resolveAmexRevolvingBalance(amexCardAccounts),
    [amexCardAccounts],
  );
  const amexValue = amex.found ? formatCurrency(amex.total) : "—";
  const amexNoCardLinked = !amex.blueCash.present && !amex.platinum.present;
  // Before the card accounts answer, no card is "linked" or "not linked" yet.
  const amexSub =
    amexCardAccounts === undefined
      ? amexCardAccountsError
        ? "Couldn't load"
        : undefined
      : amexNoCardLinked
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

  const status = (spine?.forecast?.status ?? "no_data") as CashSignalStatus;
  const statusMeta = cashBufferStatusMeta(status);
  // (PR3) A low point or buffer that did not arrive shows the kit's missing
  // face, "—". It used to fall back to 0 and print "Lowest $0.00", which reads
  // as a real (and alarming) projection.
  const buffer = spine?.forecast?.cashBuffer;
  const lowest = spine?.forecast?.lowPoint;
  // ⚠️ A MISSING SPINE IS NOT "NO SNAPSHOT". Without it the tile says it is
  // loading or failed; the setup hint is only true once the spine says so.
  const cashValue = spine ? statusMeta.label : "—";
  const cashSub = !spine
    ? spineState === "failed"
      ? "Couldn't load"
      : "Loading…"
    : status === "no_data"
      ? "Set a checking balance on Forecast"
      : `Lowest ${moneyFace(lowest)} · buffer ${moneyFace(buffer)}`;

  return (
    <>
      <Stat
        index={0}
        label="Total debt"
        value={totalDebtValue}
        hint={totalDebtSub}
        data-testid="reports-tile-total-debt"
      />
      {/* Same words as the Command Center's tile, because it is now the same
          figure: the spine's `bank.balance`. The hint keeps the account this
          belongs to; the number is no longer this page's own. */}
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
        className="span-3 grid"
        title={amexNoCardLinked ? undefined : AMEX_BALANCE_DISTINCTION.reportsTooltip}
        data-testid="reports-tile-amex"
      >
        <Stat
          index={2}
          span={null}
          label="Amex (Blue Cash + Platinum)"
          value={amexValue}
          hint={amexSub}
          tone={amex.found && amex.total > 0 ? "bad" : "navy"}
        />
      </div>
      <Stat
        index={3}
        label="Cash buffer"
        value={cashValue}
        hint={cashSub}
        data-testid="reports-tile-cash-buffer"
      />
    </>
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
