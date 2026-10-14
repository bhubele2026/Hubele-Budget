import { classifyRefund } from "@workspace/avalanche-core";
import { memoryDirectionOf, memoryKeyOf, memoryRowDirection, merchantSignature } from "../../merchantNameExtract";
import { isCardRow, spendTxnOf } from "../direction";
import type { EngineContext, EngineRow, MemoryRow, StageResult } from "../types";

const bySpecificity = (a: MemoryRow, b: MemoryRow): number =>
  b.count - a.count || a.id.localeCompare(b.id);

/**
 * The memory row that applies to a transaction: merchant_amount (amount inside
 * its band) > merchant_account (same account) > merchant. Only memory learned
 * BEFORE the row arrived applies: older rows of the merchant move only when a
 * person asks (apply-retroactively), never implicitly.
 */
export function applicableMemory(
  rows: readonly MemoryRow[],
  txn: { amount: string; plaidAccountId: string | null; createdAt?: Date },
): MemoryRow | null {
  const abs = Math.abs(Number(txn.amount) || 0);
  const live = rows
    .filter((m) => !txn.createdAt || m.createdAt.getTime() <= txn.createdAt.getTime())
    .sort(bySpecificity);
  return (
    live.find(
      (m) =>
        m.scope === "merchant_amount" &&
        m.amountBandLo != null &&
        m.amountBandHi != null &&
        abs >= m.amountBandLo &&
        abs <= m.amountBandHi,
    ) ??
    live.find(
      (m) =>
        m.scope === "merchant_account" &&
        !!m.plaidAccountId &&
        m.plaidAccountId === txn.plaidAccountId,
    ) ??
    live.find((m) => m.scope === "merchant") ??
    null
  );
}

/**
 * ⭐ (F2) SIGN-AWARE: the memory rows a row may read (see `memoryKeyOf` in
 * merchantNameExtract.ts).
 *   - money OUT reads its plain signature's rows, leaving out a pre-F2 row
 *     learned into an INCOME category (that one was a paycheck's);
 *   - money IN reads its own `in:` rows; with none that applies, a pre-F2 plain
 *     row whose category is an income one (a paycheck learned before F2) —
 *     and, only for a REFUND (`classifyRefund`: a credit on a card, or a
 *     REFUND word), the purchase's own memory: money back nets the category
 *     it was spent in.
 * A payroll credit and a same-name card purchase therefore never share one.
 */
export function memoryCandidates(row: EngineRow, ctx: EngineContext): { primary: MemoryRow[]; fallback: MemoryRow[] } {
  const key = memoryKeyOf(row);
  if (!key) return { primary: [], fallback: [] };
  const kindOf = (m: MemoryRow) => ctx.spendCtx.categoriesById.get(m.categoryId)?.kind ?? null;
  const plain = ctx.memoryBySignature.get(merchantSignature(row.description)) ?? [];
  if (memoryDirectionOf(row) === "out") {
    return { primary: plain.filter((m) => memoryRowDirection(m.signature, kindOf(m)) === "out"), fallback: [] };
  }
  const refund =
    classifyRefund(spendTxnOf(row), ctx.spendCtx, { reimbursableIsSpend: true, isCardAccount: isCardRow(row, ctx.accounts) }) != null;
  return {
    primary: ctx.memoryBySignature.get(key) ?? [],
    fallback: plain.filter((m) => refund || memoryRowDirection(m.signature, kindOf(m)) === "in"),
  };
}

/** What the household taught it: 0.92 once confirmed 3+ times, else 0.75. */
export function memoryStage(row: EngineRow, ctx: EngineContext): StageResult | null {
  const { primary, fallback } = memoryCandidates(row, ctx);
  const m = applicableMemory(primary, row) ?? applicableMemory(fallback, row);
  if (!m) return null;
  const where =
    m.scope === "merchant_amount"
      ? " at about this amount"
      : m.scope === "merchant_account"
        ? " on this account"
        : "";
  return {
    source: "memory",
    categoryId: m.categoryId,
    confidence: m.count >= 3 ? 0.92 : 0.75,
    explanation: `You filed this merchant here before${where}.`,
    memoryId: m.id,
  };
}
