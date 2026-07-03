import { useMemo } from "react";
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
  Radar as RadarRaw,
  ReferenceLine as ReferenceLineRaw,
  type AreaProps,
  type BarProps,
  type LegendProps,
  type LineProps,
  type PieProps,
  type RadarProps,
  type ReferenceLineProps,
  type TooltipProps,
  type XAxisProps,
  type YAxisProps,
} from "recharts";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useCountUp } from "@/hooks/useCountUp";
import { formatCurrency, cn } from "@/lib/utils";

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
export const Radar = RadarRaw as unknown as FCFromProps<RadarProps>;
export const ReferenceLine = ReferenceLineRaw as unknown as FCFromProps<ReferenceLineProps>;

// Recharts primitives that don't need the FC re-bind, re-exported so the
// section files can pull their whole chart toolkit from one place.
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

export function fireMilestoneConfetti() {
  // Confetti celebration removed by request.
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

export function SectionHeader({
  eyebrow,
  title,
  blurb,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {eyebrow}
      </div>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground">{blurb}</p>
    </div>
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
