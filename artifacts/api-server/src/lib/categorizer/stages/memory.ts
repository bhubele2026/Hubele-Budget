import { merchantSignature } from "../../merchantNameExtract";
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

/** What the household taught it: 0.92 once confirmed 3+ times, else 0.75. */
export function memoryStage(row: EngineRow, ctx: EngineContext): StageResult | null {
  const sig = merchantSignature(row.description);
  if (!sig) return null;
  const m = applicableMemory(ctx.memoryBySignature.get(sig) ?? [], row);
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
