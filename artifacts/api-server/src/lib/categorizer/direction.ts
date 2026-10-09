// (WP5c) The engine's side of the direction guard. The rule itself is
// `categoryDirectionConflict` in avalanche-core (spendingRule.ts), shared with
// the web; this module only reads an engine row the way that rule needs it.
import {
  categoryDirectionConflict,
  isCardLedgerRow,
  type DirectionConflict,
  type SpendContext,
  type SpendTxn,
} from "@workspace/avalanche-core";
import type { AccountFacts, EngineRow, StageResult } from "./types";

/** The row as the one spending rule reads it (shared by every stage that asks it). */
export function spendTxnOf(row: EngineRow): SpendTxn {
  return {
    amount: row.amount,
    source: row.source,
    isTransfer: row.isTransfer,
    categoryId: row.categoryId,
    description: row.description,
    debtId: row.debtId,
    isExternalCardPayment: row.isExternalCardPayment,
    reimbursable: row.reimbursable,
    pfcDetailed: row.pfcDetailed,
  };
}

/** What the guard reads: a slice of EngineContext (a model JudgeContext carries it too). */
export interface DirectionContext {
  spendCtx: SpendContext;
  uncategorizedIds: ReadonlySet<string>;
  accounts: ReadonlyMap<string, AccountFacts>;
}

/** The row is on a card: its Plaid account is a credit account, or a card ledger source. */
export function isCardRow(
  row: Pick<EngineRow, "source" | "plaidAccountId">,
  accounts: ReadonlyMap<string, AccountFacts>,
): boolean {
  const type = row.plaidAccountId ? accounts.get(row.plaidAccountId)?.type : null;
  return isCardLedgerRow(row.source, type);
}

/** Would filing this row under `categoryId` go against the money's direction? */
export function directionConflictOf(
  row: EngineRow,
  categoryId: string | null | undefined,
  ctx: DirectionContext,
): DirectionConflict | null {
  return categoryDirectionConflict(spendTxnOf(row), categoryId, ctx.spendCtx, {
    isCardAccount: isCardRow(row, ctx.accounts),
    uncategorizedIds: ctx.uncategorizedIds,
  });
}

/** A conflicting pick is a question for a person: the queue band (bands.ts, < 0.6). */
export const DIRECTION_CONFLICT_CONFIDENCE = 0.5;

export const DIRECTION_EXPLANATION: Readonly<Record<DirectionConflict, string>> = {
  inflow_into_expense: "Money in, but this would file it under an expense category.",
  outflow_into_income: "Money out, but this would file it under an income category.",
};

/**
 * ⭐ (WP5c) A memory, rule or recurring pick that would file money in under an
 * expense category, or money out under an income one, is never written: it
 * becomes a QUEUE decision (confidence 0.5) that still names the category and
 * still carries the rule / memory / recurring item that proposed it, so a
 * person sees which one and can fix it. Anything else passes through unchanged.
 */
export function guardDirection(row: EngineRow, result: StageResult, ctx: DirectionContext): StageResult {
  const conflict = directionConflictOf(row, result.categoryId, ctx);
  if (!conflict) return result;
  return {
    ...result,
    confidence: DIRECTION_CONFLICT_CONFIDENCE,
    explanation: DIRECTION_EXPLANATION[conflict],
  };
}
