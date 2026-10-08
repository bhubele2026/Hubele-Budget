import {
  addDaysISO,
  classifyOutflow,
  matchesTransferPattern,
  type SpendTxn,
} from "@workspace/avalanche-core";
import { merchantSignature } from "../../merchantNameExtract";
import type { EngineContext, EngineRow, OutflowRef, StageResult } from "../types";

/** How far back a refund may point. */
export const REFUND_WINDOW_DAYS = 60;
const TRANSFER_PFC = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);

/** Money out: a bank row below zero, an Amex charge above zero. */
export function isOutflow(row: { amount: string; source: string }): boolean {
  const a = Number(row.amount) || 0;
  return row.source === "amex" ? a > 0 : a < 0;
}

/** The earlier outflow (same signature, ≤ 60 days before, |amount| ≥ this inflow's) a refund points back to. */
export function findRefundOf(row: EngineRow, ctx: EngineContext): OutflowRef | null {
  const a = Number(row.amount) || 0;
  if (a === 0 || isOutflow(row)) return null;
  const sig = merchantSignature(row.description);
  if (!sig) return null;
  const floor = addDaysISO(row.occurredOn, -REFUND_WINDOW_DAYS);
  const abs = Math.abs(a);
  let best: OutflowRef | null = null;
  for (const o of ctx.outflowsBySignature.get(sig) ?? []) {
    if (o.id === row.id || o.occurredOn > row.occurredOn || o.occurredOn < floor) continue;
    if (abs > o.amountAbs + 1e-9) continue;
    if (!best || o.occurredOn > best.occurredOn || (o.occurredOn === best.occurredOn && o.id < best.id)) {
      best = o;
    }
  }
  return best;
}

/**
 * Evidence, not a filing: card payments (spending rules 8/9), transfers and
 * bank noise (9b, Plaid TRANSFER_*), refunds. Always below 0.6 → the QUEUE.
 * Never writes `is_transfer` (owner #666).
 */
export function heuristicStage(row: EngineRow, ctx: EngineContext): StageResult | null {
  const refund = findRefundOf(row, ctx);
  if (refund) {
    return {
      source: "refund",
      categoryId: refund.categoryId,
      confidence: 0.55,
      explanation: "Looks like a refund of an earlier purchase.",
      refundOfTxnId: refund.id,
    };
  }
  if (row.isTransfer || !isOutflow(row)) return null;
  const tx: SpendTxn = {
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
  const c = classifyOutflow(tx, ctx.spendCtx);
  if (c.rule === "8-pfc-card-payment" || c.rule === "9-card-payment-pattern") {
    return {
      source: "heuristic",
      categoryId: null,
      confidence: 0.5,
      explanation: "Looks like a credit card payment.",
    };
  }
  if (
    c.rule === "9b-bank-noise" ||
    TRANSFER_PFC.has((row.pfcPrimary ?? "").toUpperCase()) ||
    matchesTransferPattern(row.description)
  ) {
    return {
      source: "heuristic",
      categoryId: null,
      confidence: 0.5,
      explanation: "Looks like a transfer or a payment, not a purchase.",
    };
  }
  return null;
}
