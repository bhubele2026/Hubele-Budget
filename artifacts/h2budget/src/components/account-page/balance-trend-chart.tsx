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
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

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

export function BalanceTrendChart({
  caption,
  data = [],
  color = "hsl(var(--chart-1))",
  valueLabel = "Ending balance",
  testId = "card-balance-trend",
  window,
}: {
  caption: string;
  data?: TrendPoint[];
  color?: string;
  valueLabel?: string;
  testId?: string;
  // (#809) When provided, switch to the forward-looking windowed mode.
  // Leaving it undefined preserves the original trailing-12-months
  // behavior exactly (still used by the Chase page).
  window?: WindowConfig;
}) {
  if (window) {
    // (#809) Render the fixed window (axes, month ticks, today marker)
    // even when no week has closed yet — e.g. the first few days of a
    // new month before the first Saturday. The series simply hasn't
    // accumulated any points; the frame should still show so the chart
    // never disappears mid-month.
    return (
      <Card data-testid={testId}>
        <CardContent className="p-3 pt-4">
          <div className="flex items-baseline justify-between gap-2 px-1 mb-1">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {caption}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {window.subtitle}
            </div>
          </div>
          <div className="h-[120px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={window.series}
                margin={{ top: 6, right: 12, bottom: 0, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} vertical={false} />
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
