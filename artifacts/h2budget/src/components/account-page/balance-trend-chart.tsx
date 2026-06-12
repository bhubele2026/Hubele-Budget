import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceDot,
  ReferenceLine,
  Label as RechartsLabel,
} from "recharts";
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatCurrency } from "@/lib/utils";

export type TrendPoint = {
  key: string;
  label: string;
  shortLabel: string;
  balance: number;
  isSelected: boolean;
};

// (#809) A single point on the forward-looking, date-keyed window
// series. `x` is the millisecond timestamp the point is anchored at
// (the Saturday that closes its Sun–Sat week); `balance` is the actual
// ending balance at that point; `label` is the human date shown in the
// tooltip.
export type WindowPoint = {
  x: number;
  balance: number;
  label: string;
};

// (#809) Additive forward-window configuration. When supplied, the
// chart renders a fixed date-keyed window over `domain` (a numeric/time
// X-axis) instead of the default month-keyed trailing series. Only
// points up to today are plotted, so the portion after `todayMs` stays
// genuinely blank rather than flat-lining the last value.
export type WindowConfig = {
  series: WindowPoint[];
  domain: [number, number];
  monthTicks: number[];
  todayMs: number;
  subtitle: string;
};

/** A single weekly (Sun–Sat) balance sample keyed by ISO date. */
export type BalanceSeriesPoint = {
  /** Bucket date, `YYYY-MM-DD` (the week-ending Saturday, or `todayISO`). */
  date: string;
  balance: number;
};

type SingleSeriesProps = {
  caption: string;
  data?: TrendPoint[];
  color?: string;
  valueLabel?: string;
  testId?: string;
  // (#809) When provided, switch to the forward-looking windowed mode.
  // Leaving it undefined preserves the original trailing-12-months
  // behavior exactly.
  window?: WindowConfig;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

type MultiSeriesProps = {
  caption: string;
  /** Right-aligned window range, e.g. "May 2026 – May 2027". */
  subtitle?: string;
  /** Historical end-of-week checking balance, weeks ending on/before today. */
  historicalActual: BalanceSeriesPoint[];
  /** Daily projection aggregated into weekly buckets, today → horizon. */
  forecastFromToday: BalanceSeriesPoint[];
  /** Actual points from today forward (today's seed + any real future points). */
  actualFromToday: BalanceSeriesPoint[];
  /** The actual/forecast split marker, `YYYY-MM-DD`. */
  todayISO: string;
  /**
   * Full weekly date scaffold (ISO) spanning the intended window. Seeds
   * empty rows so the monthly x-axis ticks span the whole ~12-month
   * window even when the forecast data is sparse or still loading.
   */
  axisDates?: string[];
  actualColor?: string;
  forecastColor?: string;
  valueLabel?: string;
  testId?: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

type BalanceTrendChartProps = SingleSeriesProps | MultiSeriesProps;

/** Shared collapsible caption header — a chevron toggles the chart body. */
function ChartHeader({
  caption,
  subtitle,
  collapsed,
  onToggle,
}: {
  caption: string;
  subtitle?: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      data-testid="chart-collapse-toggle"
      className="w-full flex items-baseline justify-between gap-2 px-2 py-1 -mx-1 mb-1 text-left rounded-md cursor-pointer hover:bg-muted/60 transition-colors"
    >
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        {caption}
      </span>
      {subtitle != null && (
        <span className="text-[10px] text-muted-foreground">{subtitle}</span>
      )}
    </button>
  );
}

function isMultiSeries(
  props: BalanceTrendChartProps,
): props is MultiSeriesProps {
  return "historicalActual" in props;
}

export function BalanceTrendChart(props: BalanceTrendChartProps) {
  // Collapse state is remembered per chart (keyed by testId/caption) so a
  // user who hides a chart keeps it hidden across visits.
  const storageKey = `h2:chart-collapsed:${props.testId ?? props.caption}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const onToggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  if (isMultiSeries(props)) {
    return (
      <MultiSeriesBalanceTrendChart
        {...props}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
      />
    );
  }
  return (
    <SingleSeriesBalanceTrendChart
      {...props}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
    />
  );
}

function SingleSeriesBalanceTrendChart({
  caption,
  data = [],
  color = "hsl(var(--chart-1))",
  valueLabel = "Ending balance",
  testId = "card-balance-trend",
  window,
  collapsed,
  onToggleCollapsed,
}: SingleSeriesProps) {
  if (window) {
    // (#809) Render the fixed window (axes, month ticks, today marker)
    // even when no week has closed yet — e.g. the first few days of a
    // new month before the first Saturday. The series simply hasn't
    // accumulated any points; the frame should still show so the chart
    // never disappears mid-month.
    return (
      <Card data-testid={testId}>
        <CardContent className="p-3 pt-4">
          <ChartHeader
            caption={caption}
            subtitle={window.subtitle}
            collapsed={collapsed}
            onToggle={onToggleCollapsed}
          />
          <div className={cn("h-[120px] w-full", collapsed && "hidden")}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={window.series}
                margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
              >
                <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.7} vertical={false} />
                <XAxis
                  dataKey="x"
                  type="number"
                  scale="time"
                  domain={window.domain}
                  ticks={window.monthTicks}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) =>
                    new Date(v).toLocaleDateString("en-US", { month: "short" })
                  }
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
                  width={44}
                  tickLine={false}
                  axisLine={false}
                />
                <RechartsTooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--card-border))",
                    color: "hsl(var(--card-foreground))",
                    borderRadius: 6,
                    fontSize: 12,
                    boxShadow: "var(--shadow-md)",
                  }}
                  labelFormatter={(_label: unknown, payload: any) => {
                    const p = payload?.[0]?.payload as
                      | { label?: string }
                      | undefined;
                    return p?.label ?? String(_label);
                  }}
                  formatter={(v: number) => [formatCurrency(v), valueLabel]}
                />
                <ReferenceLine
                  x={window.todayMs}
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  ifOverflow="extendDomain"
                  data-testid="ref-today"
                >
                  <RechartsLabel
                    value="Today"
                    position="insideTopRight"
                    fill="hsl(var(--muted-foreground))"
                    fontSize={10}
                  />
                </ReferenceLine>
                <Line
                  type="monotone"
                  dataKey="balance"
                  stroke={color}
                  strokeWidth={2}
                  dot={{ r: 2.5, stroke: color, fill: "hsl(var(--background))", strokeWidth: 1.5 }}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) return null;
  return (
    <Card data-testid={testId}>
      <CardContent className="p-3 pt-4">
        <ChartHeader
          caption={caption}
          subtitle={`${data[0].label} – ${data[data.length - 1].label}`}
          collapsed={collapsed}
          onToggle={onToggleCollapsed}
        />
        <div className={cn("h-[120px] w-full", collapsed && "hidden")}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.7} vertical={false} />
              <XAxis
                dataKey="shortLabel"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
                width={44}
                tickLine={false}
                axisLine={false}
              />
              <RechartsTooltip
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--card-border))",
                  color: "hsl(var(--card-foreground))",
                  borderRadius: 6,
                  fontSize: 12,
                  boxShadow: "var(--shadow-md)",
                }}
                labelFormatter={(_label: unknown, payload: any) => {
                  const p = payload?.[0]?.payload as
                    | { label?: string }
                    | undefined;
                  return p?.label ?? String(_label);
                }}
                formatter={(v: number) => [formatCurrency(v), valueLabel]}
              />
              <Line
                type="monotone"
                dataKey="balance"
                stroke={color}
                strokeWidth={2}
                dot={{ r: 2.5, stroke: color, fill: "hsl(var(--background))", strokeWidth: 1.5 }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
              {data
                .filter((p) => p.isSelected)
                .map((p) => (
                  <ReferenceDot
                    key={p.key}
                    x={p.shortLabel}
                    y={p.balance}
                    r={5}
                    fill={color}
                    stroke="hsl(var(--background))"
                    strokeWidth={2}
                    ifOverflow="extendDomain"
                  />
                ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

type MergedRow = {
  date: string;
  /** Continuous solid line: historical + actual-from-today. */
  actual: number | null;
  /** Dashed forecast line, today → horizon. */
  forecast: number | null;
};

function monthTickLabel(iso: string): string {
  // iso is YYYY-MM-DD; build a local Date at noon to dodge TZ edges.
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, (m || 1) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short" });
}

function MultiSeriesBalanceTrendChart({
  caption,
  subtitle,
  historicalActual,
  forecastFromToday,
  actualFromToday,
  todayISO,
  axisDates,
  actualColor = "hsl(var(--chart-1))",
  forecastColor = "hsl(214 55% 64%)",
  valueLabel = "Balance",
  testId = "card-balance-trend",
  collapsed,
  onToggleCollapsed,
}: MultiSeriesProps) {
  // Merge the three weekly series into one date-keyed row set. The
  // historical and actual-from-today series are folded into a single
  // `actual` field so they render as one continuous solid line that
  // meets — and then continues past — today's real balance.
  const byDate = new Map<string, MergedRow>();
  const ensure = (date: string): MergedRow => {
    let row = byDate.get(date);
    if (!row) {
      row = { date, actual: null, forecast: null };
      byDate.set(date, row);
    }
    return row;
  };
  // Seed the full window scaffold first so the axis spans the whole
  // ~12-month range even when the forecast is sparse or still loading.
  for (const d of axisDates ?? []) ensure(d);
  for (const p of historicalActual) ensure(p.date).actual = p.balance;
  for (const p of actualFromToday) ensure(p.date).actual = p.balance;
  for (const p of forecastFromToday) ensure(p.date).forecast = p.balance;

  const merged = Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  if (merged.length === 0) return null;

  // Explicit monthly ticks: the first bucket date of each distinct
  // calendar month present in the data. Keeps the axis to clean monthly
  // labels across the ~12-month span instead of one tick per week.
  const monthTicks: string[] = [];
  const seenMonths = new Set<string>();
  for (const row of merged) {
    const mk = row.date.slice(0, 7);
    if (!seenMonths.has(mk)) {
      seenMonths.add(mk);
      monthTicks.push(row.date);
    }
  }

  return (
    <Card data-testid={testId}>
      <CardContent className="p-3 pt-4">
        <ChartHeader
          caption={caption}
          subtitle={
            subtitle ? (
              <span data-testid="text-trend-subtitle">{subtitle}</span>
            ) : null
          }
          collapsed={collapsed}
          onToggle={onToggleCollapsed}
        />
        <div className={cn("flex items-center gap-3 px-1 mb-1", collapsed && "hidden")}>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className="inline-block h-[2px] w-4 rounded"
              style={{ background: actualColor }}
            />
            Actual
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className="inline-block h-0 w-4 border-t-2 border-dashed"
              style={{ borderColor: forecastColor }}
            />
            Forecast
          </span>
        </div>
        <div className={cn("h-[140px] w-full", collapsed && "hidden")}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={merged}
              margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.7} vertical={false} />
              <XAxis
                dataKey="date"
                ticks={monthTicks}
                tickFormatter={monthTickLabel}
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                minTickGap={8}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
                width={44}
                tickLine={false}
                axisLine={false}
              />
              <RechartsTooltip
                content={({
                  active,
                  payload,
                }: {
                  active?: boolean;
                  payload?: any[];
                }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const row = payload[0]?.payload as MergedRow | undefined;
                  if (!row) return null;
                  const isFuture = row.date >= todayISO;
                  const hasActual =
                    row.actual != null && Number.isFinite(row.actual);
                  const hasForecast =
                    row.forecast != null && Number.isFinite(row.forecast);
                  const showDelta =
                    isFuture && hasActual && hasForecast;
                  const delta = showDelta
                    ? (row.actual as number) - (row.forecast as number)
                    : NaN;
                  const [y, m, d] = row.date.split("-").map(Number);
                  const labelDate = new Date(
                    y,
                    (m || 1) - 1,
                    d || 1,
                  ).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  });
                  return (
                    <div
                      style={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--card-border))",
                        color: "hsl(var(--card-foreground))",
                        borderRadius: 6,
                        fontSize: 12,
                        padding: "8px 10px",
                        minWidth: 150,
                        boxShadow: "var(--shadow-md)",
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{labelDate}</div>
                      {isFuture ? (
                        <>
                          {hasForecast && (
                            <div style={{ marginTop: 2 }}>
                              Forecast:{" "}
                              <span
                                style={{
                                  fontVariantNumeric: "tabular-nums",
                                  color: forecastColor,
                                  fontWeight: 600,
                                }}
                              >
                                {formatCurrency(row.forecast as number)}
                              </span>
                            </div>
                          )}
                          {hasActual && (
                            <div style={{ marginTop: 2 }}>
                              Actual:{" "}
                              <span
                                style={{
                                  fontVariantNumeric: "tabular-nums",
                                  color: actualColor,
                                  fontWeight: 600,
                                }}
                              >
                                {formatCurrency(row.actual as number)}
                              </span>
                            </div>
                          )}
                          {showDelta && (
                            <div
                              style={{ marginTop: 2 }}
                              data-testid={`tooltip-delta-${row.date}`}
                            >
                              Δ:{" "}
                              <span
                                style={{ fontVariantNumeric: "tabular-nums" }}
                              >
                                {delta >= 0 ? "+" : ""}
                                {formatCurrency(delta)}
                              </span>
                            </div>
                          )}
                        </>
                      ) : (
                        <div style={{ marginTop: 2 }}>
                          {valueLabel}:{" "}
                          <span
                            style={{
                              fontVariantNumeric: "tabular-nums",
                              color: actualColor,
                              fontWeight: 600,
                            }}
                          >
                            {hasActual
                              ? formatCurrency(row.actual as number)
                              : "—"}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                }}
              />
              <ReferenceLine
                x={todayISO}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="2 2"
                strokeOpacity={0.6}
              />
              <Line
                type="monotone"
                dataKey="actual"
                stroke={actualColor}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="forecast"
                stroke={forecastColor}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
