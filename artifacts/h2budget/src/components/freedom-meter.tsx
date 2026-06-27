import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

/**
 * "Freedom meter" — how much of your all-time debt you've crushed
 * (paidLifetime vs paidLifetime + totalDebt), with 25/50/75 milestone ticks
 * and a fill that animates in. Celebratory copy when you're debt-free.
 */
export function FreedomMeter({
  totalDebt,
  paidLifetime,
  paidThisMonth,
}: {
  totalDebt: number;
  paidLifetime: number;
  paidThisMonth: number;
}) {
  const denom = totalDebt + paidLifetime;
  const pct =
    denom > 0 ? Math.min(1, paidLifetime / denom) : paidLifetime > 0 ? 1 : 0;
  const debtFree = totalDebt <= 0.005 && paidLifetime > 0;

  const [fill, setFill] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setFill(pct), 80);
    return () => window.clearTimeout(t);
  }, [pct]);

  // Nothing to show if there's no debt history at all.
  if (denom <= 0) return null;

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
            Freedom meter · debt paid off
          </span>
          <span className="text-sm font-bold tabular-nums">
            {Math.round(pct * 100)}%
          </span>
        </div>
        <div className="relative h-3 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-positive transition-[width] duration-1000 ease-out"
            style={{ width: `${Math.round(fill * 100)}%` }}
          />
          {[25, 50, 75].map((m) => (
            <div
              key={m}
              className="absolute top-0 bottom-0 w-px bg-background/70"
              style={{ left: `${m}%` }}
            />
          ))}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {debtFree ? (
            <span className="font-medium text-positive">
              🎉 Debt-free. Absolute legends.
            </span>
          ) : (
            <>
              <span className="font-medium text-foreground">
                {formatCurrency(paidLifetime)}
              </span>{" "}
              crushed · {formatCurrency(totalDebt)} to go
              {paidThisMonth > 0
                ? ` · ${formatCurrency(paidThisMonth)} this month 🔥`
                : ""}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
