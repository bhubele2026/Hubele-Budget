// ⭐ (F2) THE SERVER SIDE OF THE EVIDENCE RULE (`classifyEvidence`,
// avalanche-core). This file only gathers what the rule reads; it decides
// nothing itself:
//
//   billSuggestions  the forecast ledger's own pairs (`ledger.matches`) that
//                    did NOT take the bill off the curve: a tier-3 suggestion,
//                    an ambiguous pair, or a pair that underpays. A tier-2
//                    off-curve pair is already `bill_matched`
//                    (`tier2PairedTxnIdsOf`), and a confirmed answer already a
//                    `matchedTxnIds` row. A posted row whose replaced pending
//                    row carried a suggestion inherits it.
//   context          the money context the row was classified with
//                    (categories, uncategorized ids, the household's credit
//                    accounts) and those suggestions.
//
// ⚠️ READ-ONLY. No write, no Plaid call.

import {
  classifyEvidence,
  type BillSuggestionRef,
  type EvidenceContext,
  type EvidenceRow,
  type MovementClassification,
  type RowEvidence,
} from "@workspace/avalanche-core";
import type { DetailedCashSignal } from "./cashSignal";
import type { MoneyContext, MoneyContextSupersede } from "./moneyContext";

/**
 * The bill the forecast SUGGESTS for each row — never one it counted as paid.
 * See the file header. `supersede` (optional) carries a pending row's
 * suggestion to the posted row that replaced it.
 */
export function billSuggestionsOf(
  ledger: Pick<DetailedCashSignal["ledger"], "matches" | "planOccurrences">,
  supersede?: Pick<MoneyContextSupersede, "replacedBy"> | null,
): Map<string, BillSuggestionRef> {
  const byKey = new Map(ledger.planOccurrences.map((o) => [o.planKey, o] as const));
  const out = new Map<string, BillSuggestionRef>();
  for (const m of ledger.matches) {
    // A tier-1/2 pair that took the plan off the curve is evidence, not a suggestion.
    if (m.tier <= 2 && m.offCurve) continue;
    // Income pairs suggest a paycheck, not a bill: never contrary evidence for an outflow.
    if (m.planAmount > 0) continue;
    const o = byKey.get(m.planKey);
    out.set(m.txnId, {
      planKey: m.planKey,
      itemId: m.planItemId,
      label: o?.label ?? "",
      occurrenceDate: o?.occurrenceDate ?? m.planDate,
    });
  }
  if (supersede) {
    for (const [postedId, pending] of supersede.replacedBy) {
      const s = out.get(pending.id);
      if (s && !out.has(postedId)) out.set(postedId, s);
    }
  }
  return out;
}

/** The context `classifyEvidence` reads, from the money context a window was classified with. */
export function evidenceContextOf(
  money: Pick<MoneyContext, "categoriesById" | "debtCategoryIds" | "filingCtx" | "cardAccountIds">,
  billSuggestions: ReadonlyMap<string, BillSuggestionRef>,
): EvidenceContext {
  return {
    categoriesById: money.categoriesById,
    debtCategoryIds: money.debtCategoryIds,
    uncategorizedIds: money.filingCtx.uncategorizedIds,
    cardAccountIds: money.cardAccountIds,
    billSuggestions,
  };
}

/** One row's evidence (`classifyEvidence`), or null when the rule says nothing about it. */
export function rowEvidenceOf(row: EvidenceRow, m: MovementClassification, ctx: EvidenceContext): RowEvidence | null {
  return classifyEvidence(row, m, ctx);
}
