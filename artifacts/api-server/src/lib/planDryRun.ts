// ⭐ (F1) THE PLAN DIALOG'S DRY RUN — `POST /allowance-plans?dryRun=1`.
//
// Before the owner sets a plan, the dialog shows what it does to the forecast:
// each hook occurrence the plan governs, before → after, with its split
// (purchases still owed, paid, carried, what is left of the allowance), and the
// forecast's low point before → after. Two ledgers are built from the same
// rules — today's, and one that reads the plan as if it were written
// (`computeCashSignalWithPlan`) — and nothing is written. The plan gate's
// answer comes with it: a refused plan says why, and still shows the effect.
//
// ⚠️ READ-ONLY. Every figure is the ledger's; this file only lines them up.

import type { HookPayoff, PlanOverride } from "./everydayHooks";
import { computeCashSignalDetailed, computeCashSignalWithPlan } from "./cashSignal";
import { POSITION_HORIZON_DAYS } from "./moneyPosition";
import { planWriteGate } from "./planSafety";

const dollars = (cents: number): string => (cents / 100).toFixed(2);

/** One occurrence's reserve, as the dry run shows it. */
export interface DryRunReserve {
  /** Before payment evidence and answers (`hookReserves[].amount`). */
  amount: string;
  /** What lands on the curve (amount − paid). */
  onCurve: string;
  basis: "plan" | "stored_amount";
  incurred: string;
  paid: string;
  carried: string;
  allowanceLeft: string;
}

const reserveOf = (p: HookPayoff): DryRunReserve => ({
  amount: dollars(p.amountCents),
  onCurve: dollars(p.curveCents),
  basis: p.fromStoredAmount ? "stored_amount" : "plan",
  incurred: dollars(p.incurredCents),
  paid: dollars(p.paidCents),
  carried: dollars(p.carriedCents),
  allowanceLeft: dollars(p.allowanceLeftCents),
});

const same = (a: DryRunReserve, b: DryRunReserve): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function planDryRun(householdId: string, ownerUserId: string, plan: PlanOverride) {
  const opts = { horizonDays: POSITION_HORIZON_DAYS };
  const [gate, before, after] = await Promise.all([
    planWriteGate(householdId, ownerUserId),
    computeCashSignalDetailed(householdId, ownerUserId, opts),
    computeCashSignalWithPlan(householdId, ownerUserId, opts, plan),
  ]);
  // The occurrences the plan governs (its cadence, its period on), and any other
  // whose figures moved.
  const occurrences = [...after.ledger.hookPayoffs.entries()]
    .map(([planKey, a]) => {
      const b = before.ledger.hookPayoffs.get(planKey);
      const was = b ? reserveOf(b) : null;
      const now = reserveOf(a);
      const governed = a.cadence === plan.period && a.periodStart >= plan.effectiveFrom;
      if (!governed && was && same(was, now)) return null;
      return {
        planKey,
        hook: a.cadence,
        occurrenceDate: a.occurrenceDate,
        label: a.label,
        before: was,
        after: now,
        cards: a.cards.map((c) => ({ accountId: c.accountId, name: c.name, mask: c.mask, mode: c.mode, amount: dollars(c.cents) })),
      };
    })
    .filter((o): o is NonNullable<typeof o> => o != null)
    .sort((x, y) => (x.occurrenceDate === y.occurrenceDate ? x.hook.localeCompare(y.hook) : x.occurrenceDate < y.occurrenceDate ? -1 : 1));
  return {
    dryRun: true as const,
    allowed: gate.ok,
    reason: gate.ok ? null : gate.reason,
    plan: { period: plan.period, amount: Number(plan.amount).toFixed(2), effectiveFrom: plan.effectiveFrom },
    occurrences,
    lowPoint: {
      before: { amount: before.signal.lowestProjected ?? null, date: before.signal.lowestDate ?? null },
      after: { amount: after.signal.lowestProjected ?? null, date: after.signal.lowestDate ?? null },
    },
  };
}

export type AllowancePlanDryRunView = Awaited<ReturnType<typeof planDryRun>>;
