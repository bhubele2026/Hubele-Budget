import { useMemo } from "react";
import {
  useListDebts,
  useGetAvalancheSettings,
  useGetAvalancheExtra,
  useListDebtBalanceHistory,
} from "@workspace/api-client-react";
import type { Debt, DebtBalanceHistoryEntry } from "@workspace/api-client-react";
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

// Treat anything within half a cent as paid off so floating-point dust
// from rate or rounding never keeps a card stuck in the "active" layout.
const PAID_OFF_EPSILON = 0.005;

function isPaidOff(balance: number): boolean {
  return Number.isFinite(balance) && Math.abs(balance) < PAID_OFF_EPSILON;
}

// Parse a YYYY-MM-DD snapshot date in the local calendar so the rendered
// month never shifts due to UTC offsets.
function parseRecordedOn(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d);
}

// The "kill month" is the earliest snapshot date on/after which the
// balance is $0 AND stays $0 through the end of recorded history,
// provided we have at least one earlier snapshot showing a positive
// balance (so we can prove a transition). If the debt was already $0
// the very first time we recorded it, return null and let the UI fall
// back to "Paid off" with no month.
export function killMonthForHistory(
  history: DebtBalanceHistoryEntry[],
): Date | null {
  if (history.length === 0) return null;
  const sorted = [...history].sort((a, b) =>
    a.recordedOn < b.recordedOn ? -1 : a.recordedOn > b.recordedOn ? 1 : 0,
  );
  let firstZeroIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (!isPaidOff(Number(sorted[i].balance))) continue;
    let allZeroAfter = true;
    for (let j = i + 1; j < sorted.length; j++) {
      if (!isPaidOff(Number(sorted[j].balance))) {
        allZeroAfter = false;
        break;
      }
    }
    if (allZeroAfter) {
      firstZeroIdx = i;
      break;
    }
  }
  if (firstZeroIdx <= 0) return null;
  const hadPositive = sorted
    .slice(0, firstZeroIdx)
    .some((h) => Number(h.balance) > PAID_OFF_EPSILON);
  if (!hadPositive) return null;
  return parseRecordedOn(sorted[firstZeroIdx].recordedOn);
}

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
  const { data: balanceHistory } = useListDebtBalanceHistory();

  const killMonthByDebtId = useMemo(() => {
    const m = new Map<string, Date | null>();
    const byDebt = new Map<string, DebtBalanceHistoryEntry[]>();
    for (const h of balanceHistory ?? []) {
      const arr = byDebt.get(h.debtId) ?? [];
      arr.push(h);
      byDebt.set(h.debtId, arr);
    }
    for (const [id, arr] of byDebt) {
      m.set(id, killMonthForHistory(arr));
    }
    return m;
  }, [balanceHistory]);

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

  const extraByTargetId = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of sim.months[0]?.targets ?? []) {
      m.set(t.id, t.extraPaid);
    }
    return m;
  }, [sim.months]);

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
          const balanceNum = Number(debt.balance);
          const paidOff = isPaidOff(balanceNum);
          const isTarget = !paidOff && planTargetIds.has(debt.id);
          const { date: payoffDate, reason: payoffReason } = payoffFor(debt.id);
          const payoffLabel = payoffDate ? fmtMonth(payoffDate) : "—";
          const targetExtra = extraByTargetId.get(debt.id) ?? 0;
          if (paidOff) {
            const killDate = killMonthByDebtId.get(debt.id) ?? null;
            const killLabel = killDate ? fmtMonth(killDate) : null;
            return (
              <Card
                key={debt.id}
                className="border-emerald-500/60 bg-emerald-50/40 dark:bg-emerald-950/20"
                data-testid="debt-card-paid-off"
                data-debt-id={debt.id}
              >
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-lg">{debt.name}</CardTitle>
                  </div>
                  <p className="text-xs text-muted-foreground">{debt.type || "General"}</p>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col items-center justify-center text-center py-4 gap-1">
                    <div
                      className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400"
                      data-testid="debt-card-paid-off-headline"
                    >
                      <span aria-hidden="true">🎉</span> Paid off!
                    </div>
                    {killLabel ? (
                      <div
                        className="text-sm text-emerald-700 dark:text-emerald-300 tabular-nums"
                        data-testid="debt-card-paid-off-month"
                        data-debt-id={debt.id}
                      >
                        Paid off {killLabel}
                      </div>
                    ) : (
                      <div
                        className="text-sm text-muted-foreground"
                        data-testid="debt-card-paid-off-month"
                        data-debt-id={debt.id}
                      >
                        Paid off
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          }
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
                  {isTarget && targetExtra > 0 && (
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Extra this month</span>
                      <span
                        className="text-sm font-semibold tabular-nums text-primary"
                        data-testid="debt-card-target-extra"
                        data-debt-id={debt.id}
                        title="Avalanche extra applied to this target this month"
                        aria-label={`Extra this month ${formatCurrency(targetExtra)}`}
                      >
                        {formatCurrency(targetExtra)}
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
