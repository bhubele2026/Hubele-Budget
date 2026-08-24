import { useMemo } from "react";
import {
  useListDebts,
  useGetAvalancheSettings,
  useGetAvalancheExtra,
  useListDebtBalanceHistory,
} from "@workspace/api-client-react";
import type { Debt, DebtBalanceHistoryEntry } from "@workspace/api-client-react";
import { PageSkeleton } from "@/components/page-skeleton";
import { DebtReauthBanner } from "@/components/debt-plaid-link";
import {
  Page,
  Stat,
  Help,
  Foot,
  card,
  cardHead,
  th,
  td,
  tdNum,
  emptyNote,
} from "@/ui";
import { cn, formatCurrency } from "@/lib/utils";
import {
  simulateWithSolvableFallback,
  sortDebts,
  fmtMonth,
  fmtPct,
  type SimDebt,
  type Strategy,
} from "@/lib/avalanche";
import { effectiveDebtBalance } from "@/lib/debtBalance";
import { DebtPendingHint } from "@/components/debt-pending-hint";

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

// ⚠️ `effectiveDebtBalance`, NOT `Number(d.balance)`. This page used to feed
// the payoff simulation raw posted balances while /avalanche fed it netted
// ones, so the two screens projected different payoff months for the same
// debt. Same function, same basis, same answer — see `@/lib/debtBalance`.
function debtToSim(d: Debt): SimDebt {
  return {
    id: d.id,
    name: d.name,
    apr: Number(d.apr),
    balance: effectiveDebtBalance(d),
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
  // the UI always highlights one row.
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

  // Stale-while-revalidate: only skeleton on a genuine cold load (no cached
  // debts yet). Once any data exists, render it and let refetches happen in the
  // background — never blank the page.
  if (isLoading && !debts) {
    return <PageSkeleton />;
  }

  // Sort by APR descending (avalanche)
  const sortedDebts = [...(debts || [])].sort((a, b) => parseFloat(b.apr) - parseFloat(a.apr));
  // Netted, so a debt whose tagged payments already clear it counts as
  // cleared here exactly as it does in the /avalanche active-debt filter.
  const paidOffCount = sortedDebts.filter((d) =>
    isPaidOff(effectiveDebtBalance(d)),
  ).length;
  const activeCount = sortedDebts.length - paidOffCount;

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
    <Page title="Debts">
      <DebtReauthBanner debts={debts} />

      <div className="mb-5 flex flex-wrap gap-3">
        <Stat index={0} label="Active" value={activeCount} hint="carrying a balance" />
        <Stat index={1} label="Cleared" value={paidOffCount} hint="paid in full" />
        <Stat
          index={2}
          label="Extra / month"
          value={formatCurrency(resolvedExtraAmount)}
          hint="on top of minimums"
        />
      </div>

      <div className={card}>
        <div className={cardHead}>
          <span className="text-title font-semibold text-brand-navy">Creditors</span>
          <span className="text-micro uppercase tracking-wide text-neutral-400">
            Highest APR first
          </span>
          <Help className="ml-auto">
            Ordered by APR, highest first — the avalanche order, which pays the
            least total interest. Target marks the debt this month's extra goes
            to; payoff months come from the same simulation the planner runs.
          </Help>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Creditor</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>APR</th>
                <th className={`${th} text-right`}>Balance</th>
                <th className={`${th} text-right`}>Min</th>
                <th className={`${th} text-right`}>Payoff</th>
                <th className={`${th} text-right`}>Target payoff</th>
                <th className={`${th} text-right`}>Extra</th>
              </tr>
            </thead>
            <tbody>
              {sortedDebts.map((debt) => {
                const balanceNum = effectiveDebtBalance(debt);
                const paidOff = isPaidOff(balanceNum);
                const originalNum = Number(debt.originalBalance ?? 0);
                const paidRatio =
                  originalNum > 0
                    ? Math.max(0, Math.min(1, (originalNum - balanceNum) / originalNum))
                    : 0;
                const isTarget = !paidOff && planTargetIds.has(debt.id);
                const { date: payoffDate, reason: payoffReason } = payoffFor(debt.id);
                const payoffLabel = payoffDate ? fmtMonth(payoffDate) : "—";
                const targetExtra = extraByTargetId.get(debt.id) ?? 0;

                if (paidOff) {
                  const killDate = killMonthByDebtId.get(debt.id) ?? null;
                  const killLabel = killDate ? fmtMonth(killDate) : null;
                  return (
                    <tr
                      key={debt.id}
                      data-testid="debt-card-paid-off"
                      data-debt-id={debt.id}
                    >
                      <td className={td}>
                        <div className="font-medium text-neutral-700">{debt.name}</div>
                        <div className="text-micro capitalize text-neutral-400">
                          {debt.type || "General"}
                        </div>
                      </td>
                      <td className={td}>
                        <span className="chip ok" data-testid="debt-card-paid-off-headline">
                          Paid off
                        </span>
                      </td>
                      <td className={`${tdNum} text-neutral-400`}>{fmtPct(Number(debt.apr))}</td>
                      <td className={`${tdNum} text-neutral-400`}>{formatCurrency(0)}</td>
                      <td className={`${tdNum} text-neutral-400`}>—</td>
                      <td
                        className={`${td} whitespace-nowrap text-right text-label text-neutral-500`}
                        data-testid="debt-card-paid-off-month"
                        data-debt-id={debt.id}
                      >
                        {killLabel ? `Paid off ${killLabel}` : "Paid off"}
                      </td>
                      <td className={td} />
                      <td className={td} />
                    </tr>
                  );
                }

                return (
                  <tr key={debt.id} className={cn(isTarget && "bg-brand-tint")}>
                    <td className={td}>
                      <div className="font-medium text-neutral-700">{debt.name}</div>
                      <div className="flex items-center gap-1.5 text-micro text-neutral-400">
                        <span className="capitalize">{debt.type || "General"}</span>
                        {originalNum > 0 && (
                          <span className="font-mono tabular-nums">
                            · {Math.round(paidRatio * 100)}% paid
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={td}>
                      {isTarget ? (
                        <span className="chip bg-brand-navy text-white">Target</span>
                      ) : (
                        <span className="chip gray">Active</span>
                      )}
                    </td>
                    <td className={tdNum}>{fmtPct(Number(debt.apr))}</td>
                    <td className={tdNum}>
                      <div>{formatCurrency(balanceNum)}</div>
                      {/* The balance above already nets tagged payments the
                          creditor hasn't reported; disclose the delta so the
                          figure can be reconciled against a statement. */}
                      <DebtPendingHint debt={debt} fmt={formatCurrency} />
                    </td>
                    <td className={tdNum}>{formatCurrency(debt.minPayment)}</td>
                    <td
                      className={`${td} whitespace-nowrap text-right font-mono text-label tabular-nums`}
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
                    </td>
                    {/* (#639) The Target-only cells keep a reserved footprint on
                        every row, so flipping isTarget (e.g. when the avalanche
                        extra changes) can't resize the table. The testid is only
                        attached in the visible case, so assertions that count
                        target rows by testid stay accurate. */}
                    <td
                      className={cn(
                        `${td} whitespace-nowrap text-right font-mono text-label font-semibold tabular-nums text-brand-navy`,
                        !isTarget && "invisible",
                      )}
                      aria-hidden={!isTarget}
                      data-testid={isTarget ? undefined : "debt-card-target-payoff-slot"}
                    >
                      <span
                        data-testid={isTarget ? "debt-card-target-payoff-date" : undefined}
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
                    </td>
                    <td
                      className={cn(
                        `${td} whitespace-nowrap text-right font-mono text-label font-semibold tabular-nums text-brand-navy`,
                        !(isTarget && targetExtra > 0) && "invisible",
                      )}
                      aria-hidden={!(isTarget && targetExtra > 0)}
                      data-testid={
                        isTarget && targetExtra > 0 ? undefined : "debt-card-target-extra-slot"
                      }
                    >
                      <span
                        data-testid={
                          isTarget && targetExtra > 0 ? "debt-card-target-extra" : undefined
                        }
                        data-debt-id={debt.id}
                        title="Avalanche extra applied to this target this month"
                        aria-label={`Extra this month ${formatCurrency(Math.max(targetExtra, 0))}`}
                      >
                        {formatCurrency(Math.max(targetExtra, 0))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {sortedDebts.length === 0 && (
          <div className={emptyNote} data-testid="text-debts-empty-state">
            No debts recorded.
          </div>
        )}

        {sortedDebts.length > 0 && (
          <Foot>
            Target payoff and Extra show only on the debt (or debts) this month's
            extra payment goes to.
          </Foot>
        )}
      </div>
    </Page>
  );
}
