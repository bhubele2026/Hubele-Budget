import {
  addDaysISO,
  classifyOutflow,
  classifyRefund,
  isRefundCandidate,
  matchesTransferPattern,
} from "@workspace/avalanche-core";
import { refundSignature } from "../../merchantNameExtract";
import { spendTxnOf } from "../direction";
import type { EngineContext, EngineRow, OutflowRef, StageResult } from "../types";

/** (B6: 60 → 90) How far back a refund may point. */
export const REFUND_WINDOW_DAYS = 90;
const TRANSFER_PFC = new Set(["TRANSFER_IN", "TRANSFER_OUT"]);

/** The confidence of every refund decision: below 0.6, so the QUEUE — never filed. */
export const REFUND_CONFIDENCE = 0.55;

/** Money out: a bank row below zero, an Amex charge above zero. */
export function isOutflow(row: { amount: string; source: string }): boolean {
  const a = Number(row.amount) || 0;
  return row.source === "amex" ? a > 0 : a < 0;
}

/**
 * The earlier outflow a refund points back to: same refund-link signature
 * (`refundSignature`: "KROGER #442 REFUND" and "KROGER #442" both sign
 * `kroger`), dated on or before the credit and at most 90 days before it, and
 * at least as large. A purchase on the credit's own account wins; then the
 * latest; then the lowest id.
 *
 * (B6) Only a credit nothing rules out as a refund (`isRefundCandidate`: not a
 * transfer, a card payment, income, bank noise, a debt or excluded category)
 * is linked. The matched purchase is the evidence, so the account may be any.
 */
export function findRefundOf(row: EngineRow, ctx: EngineContext): OutflowRef | null {
  if (!isRefundCandidate(spendTxnOf(row), ctx.spendCtx, { reimbursableIsSpend: true })) return null;
  const sig = refundSignature(row.description);
  if (!sig) return null;
  const floor = addDaysISO(row.occurredOn, -REFUND_WINDOW_DAYS);
  const abs = Math.abs(Number(row.amount) || 0);
  const own = (o: OutflowRef) => row.plaidAccountId != null && o.plaidAccountId === row.plaidAccountId;
  let best: OutflowRef | null = null;
  for (const o of ctx.outflowsBySignature.get(sig) ?? []) {
    if (o.id === row.id || o.occurredOn > row.occurredOn || o.occurredOn < floor) continue;
    if (abs > o.amountAbs + 1e-9) continue;
    if (
      !best ||
      (own(o) && !own(best)) ||
      (own(o) === own(best) && (o.occurredOn > best.occurredOn || (o.occurredOn === best.occurredOn && o.id < best.id)))
    ) {
      best = o;
    }
  }
  return best;
}

/**
 * ⭐ (B6) A RECOGNISED REFUND IS A QUESTION FOR A PERSON. A credit that links
 * to an earlier purchase (`findRefundOf`) gets a queue decision proposing that
 * purchase's category — "Refund of <purchase> on <date>" — and the link
 * (`refund_of_txn_id`). It runs right after `locked` (decide.ts), so memory, a
 * rule or a recurring item can never auto-file a refund as the purchase it
 * returns.
 */
export function refundStage(row: EngineRow, ctx: EngineContext): StageResult | null {
  const refund = findRefundOf(row, ctx);
  if (!refund) return null;
  return {
    source: "refund",
    categoryId: refund.categoryId,
    confidence: REFUND_CONFIDENCE,
    explanation: `Refund of ${refund.description} on ${refund.occurredOn}`,
    refundOfTxnId: refund.id,
  };
}

/**
 * Evidence, not a filing: card payments (spending rules 8/9), transfers and
 * bank noise (9b, Plaid TRANSFER_*), refunds. Always below 0.6 → the QUEUE.
 * Never writes `is_transfer` (owner #666).
 *
 * (B6) A credit that IS a refund by the spending rule (`classifyRefund`: money
 * back on a card, or a refund word on another account) but matched no earlier
 * purchase is still queued — a plain refund decision with no category.
 */
export function heuristicStage(row: EngineRow, ctx: EngineContext): StageResult | null {
  const refund = refundStage(row, ctx);
  if (refund) return refund;
  const tx = spendTxnOf(row);
  if (!isOutflow(row)) {
    if (classifyRefund(tx, ctx.spendCtx, { reimbursableIsSpend: true })) {
      return {
        source: "refund",
        categoryId: null,
        confidence: REFUND_CONFIDENCE,
        explanation: "Looks like a refund; no earlier purchase matched.",
      };
    }
    return null;
  }
  if (row.isTransfer) return null;
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
