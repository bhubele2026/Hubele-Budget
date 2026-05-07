import { useMemo } from "react";
import {
  useListDebts,
  useGetAvalancheSettings,
  useGetAvalancheExtra,
} from "@workspace/api-client-react";
import type { Debt } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { DebtReauthBanner } from "@/components/debt-plaid-link";
import {
  simulateWithSolvableFallback,
  sortDebts,
  fmtMonth,
  type SimDebt,
  type Strategy,
} from "@/lib/avalanche";

const MANUAL_EXTRA_CAP = 5000;

function debtToSim(d: Debt): SimDebt {
  return {
    id: d.id,
    name: d.name,
    apr: Number(d.apr),
    balance: Number(d.balance),
    minPayment: Number(d.minPayment),
    status: d.status,
  };
}

export default function DebtsPage() {
  const { data: debts, isLoading } = useListDebts();
  const { data: settings } = useGetAvalancheSettings();
  const { data: resolvedExtra } = useGetAvalancheExtra();

  const strategy: Strategy = (settings?.strategy as Strategy) ?? "avalanche";
  const clampManual = (n: number) =>
    Number.isFinite(n) ? Math.max(0, Math.min(MANUAL_EXTRA_CAP, n)) : 0;
  const manualExtra = clampManual(Number(settings?.manualExtra ?? 0));
  const rawResolvedExtraAmount = Number(resolvedExtra?.amount ?? manualExtra);
  const isManualSource =
    (resolvedExtra?.source ?? settings?.extraSource ?? "manual") === "manual";
  const resolvedExtraAmount = isManualSource
    ? clampManual(rawResolvedExtraAmount)
    : Number.isFinite(rawResolvedExtraAmount)
      ? Math.max(0, rawResolvedExtraAmount)
      : 0;

  const simDebts: SimDebt[] = useMemo(
    () => (debts ?? []).map(debtToSim),
    [debts],
  );

  const fallback = useMemo(
    () =>
      simulateWithSolvableFallback({
        debts: simDebts,
        extraPerMonth: resolvedExtraAmount,
        strategy,
      }),
    [simDebts, resolvedExtraAmount, strategy],
  );
  const sim = fallback.sim;
  const effectiveDebts = fallback.effectiveDebts;

  // Mirror the /avalanche planner: every debt the simulator pays extra to
  // this month is a "current target." When month 0 has no extra to spill
  // (e.g. $0 extra), fall back to the strategy's first solvable debt so
  // the UI always highlights one card.
  const planTargetIds = useMemo(() => {
    const monthTargets = sim.months[0]?.targets ?? [];
    if (monthTargets.length > 0) {
      return new Set(monthTargets.map((t) => t.id));
    }
    const sortedSolvable = sortDebts(
      effectiveDebts.filter((d) => d.balance > 0),
      strategy,
    );
    const fallbackTarget = sortedSolvable[0] ?? null;
    return new Set(fallbackTarget ? [fallbackTarget.id] : []);
  }, [sim.months, effectiveDebts, strategy]);

  const killById = useMemo(() => {
    const m = new Map<string, Date>();
    for (const k of sim.killedOrder) m.set(k.id, k.date);
    return m;
  }, [sim]);

  const underwaterIds = useMemo(
    () => new Set(sim.underwater.map((u) => u.id)),
    [sim.underwater],
  );

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  // Sort by APR descending (avalanche)
  const sortedDebts = [...(debts || [])].sort((a, b) => parseFloat(b.apr) - parseFloat(a.apr));

  const payoffFor = (debtId: string): { date: Date | null; reason: string } => {
    const date = killById.get(debtId) ?? null;
    if (date) return { date, reason: "" };
    if (underwaterIds.has(debtId)) {
      return {
        date: null,
        reason: "Underwater — minimum doesn't cover interest",
      };
    }
    return { date: null, reason: "Beyond planning horizon" };
  };

  return (
    <div className="space-y-6">
      <DebtReauthBanner debts={debts} />
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Debt Avalanche</h1>
          <p className="text-muted-foreground mt-1">Sorted by APR to minimize interest paid.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedDebts.map((debt) => {
          const isTarget = planTargetIds.has(debt.id);
          const { date: payoffDate, reason: payoffReason } = payoffFor(debt.id);
          const payoffLabel = payoffDate ? fmtMonth(payoffDate) : "—";
          return (
            <Card key={debt.id} className={isTarget ? "border-primary" : ""}>
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <CardTitle className="text-lg">{debt.name}</CardTitle>
                  {isTarget && <span className="bg-primary text-primary-foreground text-xs px-2 py-1 rounded">Target</span>}
                </div>
                <p className="text-xs text-muted-foreground">{debt.type || "General"}</p>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 mt-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">Balance</span>
                    <span className="text-sm font-medium">{formatCurrency(debt.balance)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">APR</span>
                    <span className="text-sm font-medium">{debt.apr}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">Min Payment</span>
                    <span className="text-sm font-medium">{formatCurrency(debt.minPayment)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">Payoff</span>
                    <span
                      className="text-sm font-medium tabular-nums"
                      data-testid="debt-card-payoff-date"
                      data-debt-id={debt.id}
                      title={payoffDate ? "Projected payoff month" : payoffReason}
                      aria-label={
                        payoffDate
                          ? `Projected payoff ${payoffLabel}`
                          : `No projected payoff: ${payoffReason}`
                      }
                    >
                      {payoffLabel}
                    </span>
                  </div>
                  {isTarget && (
                    <div className="flex justify-between pt-2 border-t border-border/60">
                      <span className="text-sm text-muted-foreground">Target payoff</span>
                      <span
                        className="text-sm font-semibold tabular-nums text-primary"
                        data-testid="debt-card-target-payoff-date"
                        data-debt-id={debt.id}
                        title={payoffDate ? "Projected target payoff month" : payoffReason}
                        aria-label={
                          payoffDate
                            ? `Target payoff ${payoffLabel}`
                            : `No projected target payoff: ${payoffReason}`
                        }
                      >
                        {payoffLabel}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {sortedDebts.length === 0 && (
        <div
          className="text-center py-12 text-muted-foreground"
          data-testid="text-debts-empty-state"
        >
          No debts recorded. You're debt free!
        </div>
      )}
    </div>
  );
}
