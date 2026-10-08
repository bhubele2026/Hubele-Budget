import { effectiveFiling } from "../../pendingFiling";
import type { EngineContext, EngineRow, StageResult } from "../types";

/**
 * A posted row that replaced a pending row (`pairPendingWithPosted`) gets the
 * pending row's filing WRITTEN now, through the same `effectiveFiling` the
 * readers apply at read time — so what is stored equals what is counted.
 *
 * Order: it runs after rule/memory/recurring and yields only where
 * `effectiveFiling` disagrees with the earlier stage's pick — i.e. where owner
 * decision 14 says the pending row's HAND filing beats an automatic one, or
 * where no earlier stage picked anything. `isTransfer` is never written.
 */
export function inheritedStage(
  row: EngineRow,
  earlier: StageResult | null,
  ctx: EngineContext,
): StageResult | null {
  const replaced = ctx.replacedBy.get(row.id);
  if (!replaced) return null;
  const candidate = earlier?.categoryId ?? row.categoryId;
  const eff = effectiveFiling(
    { ...row, categoryId: candidate },
    replaced,
    { uncategorizedIds: ctx.uncategorizedIds },
  );
  if (!eff.categoryId || ctx.uncategorizedIds.has(eff.categoryId)) return null;
  if (earlier && eff.categoryId === earlier.categoryId) return null;
  const fromPending = eff.categoryId === replaced.filing.categoryId;
  return {
    source: "inherited",
    categoryId: eff.categoryId,
    confidence: 0.95,
    explanation: "Carried over from the pending charge this one replaced.",
    inheritedFiling: {
      weeklyAllowance: eff.weeklyAllowance,
      monthlyAllowance: eff.monthlyAllowance,
      unplannedAllowance: eff.unplannedAllowance,
      weeklyBucket: eff.weeklyBucket,
      reimbursable: eff.reimbursable,
      debtId: eff.debtId,
      categoryLockedByUser: fromPending && !!replaced.filing.categoryLockedByUser,
    },
  };
}
