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
  Legend,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export type TrendPoint = {
  key: string;
  label: string;
  shortLabel: string;
  balance: number;
  isSelected: boolean;
};

export function BalanceTrendChart({
  caption,
  data,
  color = "hsl(var(--chart-1))",
  valueLabel = "Ending balance",
  testId = "card-balance-trend",
}: {
  caption: string;
  data: TrendPoint[];
  color?: string;
  valueLabel?: string;
  testId?: string;
}) {
  if (data.length === 0) return null;
  return (
    <Card data-testid={testId}>
      <CardContent className="p-3 pt-4">
        <div className="flex items-baseline justify-between gap-2 px-1 mb-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {caption}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {data[0].label} – {data[data.length - 1].label}
          </div>
        </div>
        <div className="h-[120px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
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

// ---------------------------------------------------------------------------
// (#785) Forward-looking "actual vs forecast" variant used by the Chase
// Transactions page. Sibling to BalanceTrendChart so the Amex page's
// trailing-12-months chart is unaffected.
//
// `data` is an ordered array of weekly Sun–Sat bucket points keyed by the
// ISO date of the bucket's Saturday (plus today as its own divergence
// point). Each point carries up to three series:
//   - historicalActual: the real end-of-week Chase balance for weeks that
//     finished before today. Rendered with the solid styling.
//   - actualFromToday: today's actual balance and any post-today balance
//     points (typically just today on day one; grows naturally as future
//     Plaid syncs land). Rendered with the same solid styling so visually
//     it reads as one continuous "Actual" line with historicalActual.
//   - forecastFromToday: the server `cashSignal` projection bucketed into
//     weekly Sun–Sat points starting at today. Rendered dashed.
// `todayISO` marks the divergence point as a vertical reference line and
// drives the tooltip's pre-today vs today/future field selection.
// ---------------------------------------------------------------------------

export type BalanceForecastPoint = {
  date: string;
  historicalActual: number | null;
  actualFromToday: number | null;
  forecastFromToday: number | null;
};

function parseLocalISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatMonthTick(iso: string): string {
  return parseLocalISO(iso).toLocaleDateString("en-US", { month: "short" });
}

function formatFullDateLabel(iso: string): string {
  return parseLocalISO(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function BalanceForecastTrendChart({
  caption,
  rangeLabel,
  data,
  todayISO,
  solidColor = "hsl(var(--chart-1))",
  dashedColor = "hsl(var(--chart-2))",
  testId = "card-balance-trend",
}: {
  caption: string;
  rangeLabel?: string;
  data: BalanceForecastPoint[];
  todayISO: string;
  solidColor?: string;
  dashedColor?: string;
  testId?: string;
}) {
  if (data.length === 0) return null;
  // Merge historical + actual-from-today into one `actual` column so a
  // single solid Line renders continuously across today rather than two
  // disjoint segments.
  const merged = data.map((p) => ({
    ...p,
    actual:
      p.historicalActual != null
        ? p.historicalActual
        : p.actualFromToday != null
          ? p.actualFromToday
          : null,
  }));

  return (
    <Card data-testid={testId}>
      <CardContent className="p-3 pt-4">
        <div className="flex items-baseline justify-between gap-2 px-1 mb-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {caption}
          </div>
          {rangeLabel && (
            <div className="text-[10px] text-muted-foreground">{rangeLabel}</div>
          )}
        </div>
        <div className="h-[160px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={merged}
              margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                opacity={0.2}
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                tickFormatter={formatMonthTick}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={28}
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
                content={({
                  active,
                  payload,
                  label,
                }: {
                  active?: boolean;
                  payload?: any[];
                  label?: unknown;
                }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0]?.payload as
                    | (BalanceForecastPoint & { actual: number | null })
                    | undefined;
                  if (!p) return null;
                  const dateISO = String(label ?? p.date);
                  const isFutureOrToday = dateISO >= todayISO;
                  const ac = p.actual;
                  const fc = p.forecastFromToday;
                  return (
                    <div
                      style={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--card-border))",
                        color: "hsl(var(--card-foreground))",
                        borderRadius: 6,
                        fontSize: 12,
                        padding: "8px 10px",
                        minWidth: 140,
                        boxShadow: "var(--shadow-md)",
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {formatFullDateLabel(dateISO)}
                      </div>
                      {!isFutureOrToday && ac != null && (
                        <div style={{ marginTop: 2 }}>
                          Actual:{" "}
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            {formatCurrency(ac)}
                          </span>
                        </div>
                      )}
                      {isFutureOrToday && (
                        <>
                          {fc != null && (
                            <div style={{ marginTop: 2 }}>
                              Forecast:{" "}
                              <span
                                style={{
                                  fontVariantNumeric: "tabular-nums",
                                  color: dashedColor,
                                }}
                              >
                                {formatCurrency(fc)}
                              </span>
                            </div>
                          )}
                          {ac != null && (
                            <div style={{ marginTop: 2 }}>
                              Actual:{" "}
                              <span
                                style={{
                                  fontVariantNumeric: "tabular-nums",
                                  color: solidColor,
                                  fontWeight: 600,
                                }}
                              >
                                {formatCurrency(ac)}
                              </span>
                            </div>
                          )}
                          {fc != null && ac != null && (
                            <div style={{ marginTop: 2 }}>
                              Δ:{" "}
                              <span
                                style={{
                                  fontVariantNumeric: "tabular-nums",
                                  fontWeight: 600,
                                  color:
                                    ac - fc >= 0
                                      ? "hsl(var(--chart-3))"
                                      : "hsl(var(--destructive))",
                                }}
                              >
                                {ac - fc >= 0 ? "+" : ""}
                                {formatCurrency(ac - fc)}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                }}
              />
              <Legend
                verticalAlign="top"
                height={20}
                iconType="plainline"
                wrapperStyle={{ fontSize: 11 }}
              />
              <ReferenceLine
                x={todayISO}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="2 4"
                ifOverflow="extendDomain"
              />
              <Line
                type="monotone"
                dataKey="actual"
                name="Actual"
                stroke={solidColor}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="forecastFromToday"
                name="Forecast"
                stroke={dashedColor}
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
