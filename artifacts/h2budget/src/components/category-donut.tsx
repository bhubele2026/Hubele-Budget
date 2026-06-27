import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

const COLORS = [
  "hsl(193 67% 43%)",
  "hsl(197 63% 58%)",
  "hsl(45 95% 50%)",
  "hsl(33 94% 49%)",
  "hsl(202 55% 32%)",
  "hsl(193 50% 62%)",
];

/** Donut of the top spend categories this month, with a legend + center total. */
export function CategoryDonut({
  categories,
}: {
  categories: { categoryName: string; total: string }[];
}) {
  const data = (categories ?? [])
    .slice(0, 5)
    .map((c) => ({ name: c.categoryName, value: Number(c.total) || 0 }))
    .filter((d) => d.value > 0);
  if (data.length < 2) return null;
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium mb-3">
          Where your money goes
        </div>
        <div className="flex items-center gap-5">
          <div className="relative w-[136px] h-[136px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={42}
                  outerRadius={62}
                  paddingAngle={2}
                  stroke="none"
                  isAnimationActive
                  animationDuration={900}
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <RechartsTooltip
                  formatter={(v: number) => formatCurrency(Number(v))}
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--card-border))",
                    color: "hsl(var(--card-foreground))",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="text-center">
                <div className="text-[9px] uppercase tracking-widest text-muted-foreground">
                  Total
                </div>
                <div className="text-sm font-bold tabular-nums">
                  {formatCurrency(total)}
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0 space-y-1.5">
            {data.map((d, i) => (
              <div key={d.name} className="flex items-center gap-2 text-xs">
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ background: COLORS[i % COLORS.length] }}
                />
                <span className="flex-1 truncate">{d.name}</span>
                <span className="tabular-nums font-medium">
                  {formatCurrency(d.value)}
                </span>
                <span className="tabular-nums text-muted-foreground w-9 text-right">
                  {Math.round((d.value / total) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
