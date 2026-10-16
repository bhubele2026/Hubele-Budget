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
//                    row carried a suggestion inherits it. ⭐ (Task 6, A2) Plus
//                    the ledger's suggestions for SKIPPED occurrences
//                    (`ledger.skippedSuggestions`), marked `skipped`: a target
//                    for an unresolved row's own suggestion, never a reason.
//                    Every surface builds its context here, so Spending,
//                    Banking, Amex and the proposals read the same evidence.
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
  ledger: Pick<DetailedCashSignal["ledger"], "matches" | "planOccurrences"> &
    Partial<Pick<DetailedCashSignal["ledger"], "skippedSuggestions">>,
  supersede?: Pick<MoneyContextSupersede, "replacedBy"> | null,
): Map<string, BillSuggestionRef> {
  const byKey = new Map(ledger.planOccurrences.map((o) => [o.planKey, o] as const));
  const out = new Map<string, BillSuggestionRef>();
  const refOf = (m: DetailedCashSignal["ledger"]["matches"][number], skipped: boolean): BillSuggestionRef => {
    const o = byKey.get(m.planKey);
    return {
      planKey: m.planKey,
      itemId: m.planItemId,
      label: o?.label ?? "",
      occurrenceDate: o?.occurrenceDate ?? m.planDate,
      planned: o?.amount ?? m.planAmount,
      skipped,
    };
  };
  for (const m of ledger.matches) {
    // A tier-1/2 pair that took the plan off the curve is evidence, not a suggestion.
    if (m.tier <= 2 && m.offCurve) continue;
    // Income pairs suggest a paycheck, not a bill: never contrary evidence for an outflow.
    if (m.planAmount > 0) continue;
    out.set(m.txnId, refOf(m, false));
  }
  // (Task 6, A2) A skipped occurrence: only for a row no open plan already suggests.
  for (const m of ledger.skippedSuggestions ?? []) {
    if (m.planAmount > 0 || out.has(m.txnId)) continue;
    out.set(m.txnId, refOf(m, true));
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

const moneyOrNull = (n: number | null): string | null => (n == null ? null : (Math.round(n * 100) / 100).toFixed(2));

/**
 * (F2) A row's evidence as a response states it (the `RowEvidence` schema): its
 * class, why, what was read, and what it probably is. One serializer for
 * GET /money/period-breakdown and (Task 6) GET /banking/review.
 */
export function evidenceView(ev: RowEvidence | null) {
  if (!ev) return null;
  return {
    class: ev.class,
    reason: ev.reason,
    items: ev.evidence.map((i) => ({ field: i.field, value: i.value })),
    suggestion: ev.suggestion
      ? {
          kind: ev.suggestion.kind,
          detail: ev.suggestion.detail,
          target: ev.suggestion.target
            ? {
                kind: ev.suggestion.target.kind,
                id: ev.suggestion.target.itemId,
                label: ev.suggestion.target.label,
                planKey: ev.suggestion.target.planKey,
                occurrenceDate: ev.suggestion.target.occurrenceDate,
                planned: moneyOrNull(ev.suggestion.target.planned),
                skipped: ev.suggestion.target.skipped,
              }
            : null,
        }
      : null,
  };
}
