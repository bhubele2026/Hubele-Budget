import { useMemo } from "react";
import type { Transaction } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { StackBar, DeltaPill, MoneyText } from "@/components/viz";

const MIX_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-5))",
];

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Compact visual strip for the Chase page: a week-over-week spend DeltaPill +
 * a StackBar of this month's category mix. Pairs with the existing balance
 * trend chart. Self-contained — derives everything from the txn list (same
 * exclude-set the reports use), recomputes no money the server owns.
 */
export function ChaseInsightStrip({
  txns,
  categories,
}: {
  txns: Transaction[];
  categories: { id: string; name: string; excludeFromBudget?: boolean }[];
}) {
  const { excluded, nameById } = useMemo(() => {
    const ex = new Set<string>();
    const nm = new Map<string, string>();
    for (const c of categories) {
      nm.set(c.id, c.name);
      if (c.excludeFromBudget) ex.add(c.id);
    }
    return { excluded: ex, nameById: nm };
  }, [categories]);

  const isSpend = (t: Transaction) => {
    const a = Number(t.amount) || 0;
    if (a >= 0) return false;
    if (t.isTransfer) return false;
    if (t.categoryId && excluded.has(t.categoryId)) return false;
    return true;
  };

  // This week vs last week (Sun–Sat) spend → DeltaPill.
  const delta = useMemo(() => {
    const now = new Date();
    const sun = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const thisStart = isoOf(sun);
    const lastStart = isoOf(new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() - 7));
    let cur = 0;
    let prev = 0;
    for (const t of txns) {
      if (!isSpend(t)) continue;
      const amt = Math.abs(Number(t.amount) || 0);
      if (t.occurredOn >= thisStart) cur += amt;
      else if (t.occurredOn >= lastStart && t.occurredOn < thisStart) prev += amt;
    }
    const pct = prev > 0 ? ((cur - prev) / prev) * 100 : null;
    return { cur, prev, pct };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns, excluded]);

  // This month's category mix → StackBar.
  const mix = useMemo(() => {
    const ym = isoOf(new Date()).slice(0, 7);
    const totals = new Map<string, number>();
    for (const t of txns) {
      if (!isSpend(t) || !t.occurredOn.startsWith(ym)) continue;
      const name = (t.categoryId && nameById.get(t.categoryId)) || "Uncategorized";
      totals.set(name, (totals.get(name) ?? 0) + Math.abs(Number(t.amount) || 0));
    }
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value], i) => ({ label, value, color: MIX_COLORS[i % MIX_COLORS.length] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns, excluded, nameById]);

  if (!mix.length && delta.cur === 0) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              Spend this week
            </span>
            {delta.pct != null && <DeltaPill value={delta.pct} invert />}
          </div>
          <div className="text-2xl font-bold">
            <MoneyText amount={delta.cur} />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            vs <MoneyText amount={delta.prev} className="text-foreground" /> last week
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-5">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium mb-3">
            This month · category mix
          </div>
          {mix.length ? (
            <StackBar segments={mix} legendMax={4} />
          ) : (
            <div className="text-xs text-muted-foreground">No categorized spend yet.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
