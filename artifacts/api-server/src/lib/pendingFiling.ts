// (PR-D review H1/H2, round 4; round 3 M1, L2, NIT4; owner decisions 6 and 14)
// The filing a posted row carries when it replaced a pending row the
// household had filed.
//
// ⚠️ WHY. Sync never deletes a pending row the user filed, and the posted row
// that replaces it arrives as a FRESH insert: its category is whatever the
// mapping rules assign (or none), every allowance flag false (plaidSync, the
// `values` insert). Counting a pending purchase once (PR-D) therefore made a
// filed $40 charge leave its envelope the moment it posted at $48.
//
// Owner decision 14: the household's filing carries to the posted replacement,
// and a hand filing beats an automatic one. This PR applies it at READ time
// only — nothing is written. Every reader that pairs (the Budget month's
// category actuals and allowance card, `buildSpendingFacts`) calls this one
// helper, so Budget and Spending cannot file the same posted row differently.
//
// ⚠️ ROUND 3 → ROUND 4: NOT "was this the rule's category" — the review found
// re-reading the CURRENT mapping rules gets the hand-vs-rule call wrong in both
// directions, because `PATCH /transactions/:id` repoints every matching rule
// onto whatever category the user just picked (routes/transactions.ts): by the
// time this runs, the "rule" and the user's pick are often the same thing, so a
// row the user JUST re-filed by hand reads back as "automatic", and a stale
// rule nobody asked about reads back as "hand-filed" (review H1). Round 4
// decides it instead from a fact already stored on the row:
// `isTransferUserOverridden` — set whenever the user chooses a category
// through PATCH, or creates a row, and never set by Plaid sync. It answers
// "did a person point this row here" without re-consulting rules that may have
// moved since.
//
// ⚠️ Inheriting `isTransfer` unconditionally also hid real spending (review
// H2): sync auto-flags Venmo/Zelle/PayPal and PFC TRANSFER_OUT rows as
// transfers with no user in the loop, so a pending row could carry that
// auto-flag onto a posted row the user had deliberately filed as real spending
// (categorized, `isTransferUserOverridden: true`, `isTransfer: false`). Round 4
// never lets an inherited transfer flag overrule a posted row the user
// overrode either way.
//
// ⭐ THE RULE (for PR-I to reuse when it writes this at sync). With P the
// posted row and Q the pending row it replaced; "real category" = not null and
// not the system Uncategorized:
//
//   categoryId      Q's, when Q's is real and either
//                     - P has no real category, or
//                     - both are real and different, and P is NOT
//                       `isTransferUserOverridden` while Q IS.
//                   Otherwise P's own. (Both un-overridden, or both
//                   overridden, or only P overridden → P's own.)
//   weekly / monthly / unplanned flags
//                   Q's three, only when P has none of them.
//   weeklyBucket    Q's, when P has none and both rows are weekly (after the
//                   flag step) — mergeStatePatch fills a blank slice the same way.
//   reimbursable    true when either is.
//   debtId          Q's, when P has none.
//   isTransfer      true only when P is not already a transfer, Q is, Q's
//                   transfer flag was USER-SET (`isTransferUserOverridden`),
//                   and P itself was never overridden either way. A posted row
//                   the user overrode (transfer or not) is never changed.
//
// Otherwise P's own filing stands, even when that moves the whole charge to
// another envelope (review M2).

import { UNCATEGORIZED_CATEGORY_NAME } from "./budgetSeed";

/** The user-state fields a posted row can inherit. */
export interface Filing {
  categoryId: string | null;
  weeklyAllowance: boolean;
  monthlyAllowance: boolean;
  unplannedAllowance: boolean;
  weeklyBucket: string | null;
  reimbursable: boolean;
  debtId: string | null;
  isTransfer: boolean;
  /**
   * (round 4) True when a person, not Plaid sync, is the reason this row
   * carries what it carries — set by `PATCH /transactions/:id` whenever the
   * body picks a category or sets `isTransfer`, and by row creation; never
   * set by sync. THE signal `effectiveFiling` decides hand-vs-automatic from;
   * it never re-reads the household's mapping rules (round 3 → round 4 above).
   */
  isTransferUserOverridden: boolean;
}

/** The pending row a posted row replaced, as far as inheritance needs it. */
export interface ReplacedFiling {
  description: string;
  filing: Filing;
}

export interface FilingContext {
  /** The household's system Uncategorized category ids. */
  uncategorizedIds: ReadonlySet<string>;
}

/** The household's system "Uncategorized" category ids (by its exact name). */
export function uncategorizedCategoryIds(
  categories: Iterable<{ id: string; name: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const c of categories) {
    if (c.name === UNCATEGORIZED_CATEGORY_NAME) ids.add(c.id);
  }
  return ids;
}

const isReal = (id: string | null, uncategorizedIds: ReadonlySet<string>): id is string =>
  id != null && !uncategorizedIds.has(id);

/**
 * ⭐ The posted row as it counts, given the pending row it replaced — THE RULE
 * above. Pure: returns a new object, never mutates either row. With no
 * replaced row it returns the posted row unchanged.
 */
export function effectiveFiling<T extends Filing & { description: string }>(
  posted: T,
  replaced: ReplacedFiling | null | undefined,
  ctx: FilingContext,
): T {
  if (!replaced) return posted;
  const from = replaced.filing;
  const out: T = { ...posted };
  const { uncategorizedIds } = ctx;

  if (isReal(from.categoryId, uncategorizedIds)) {
    if (!isReal(posted.categoryId, uncategorizedIds)) {
      out.categoryId = from.categoryId;
    } else if (
      posted.categoryId !== from.categoryId &&
      !posted.isTransferUserOverridden &&
      from.isTransferUserOverridden
    ) {
      out.categoryId = from.categoryId;
    }
  }

  if (!posted.weeklyAllowance && !posted.monthlyAllowance && !posted.unplannedAllowance) {
    out.weeklyAllowance = from.weeklyAllowance;
    out.monthlyAllowance = from.monthlyAllowance;
    out.unplannedAllowance = from.unplannedAllowance;
  }
  if (!posted.weeklyBucket && from.weeklyBucket && out.weeklyAllowance && from.weeklyAllowance) {
    out.weeklyBucket = from.weeklyBucket;
  }

  if (!posted.reimbursable && from.reimbursable) out.reimbursable = true;
  if (!posted.debtId && from.debtId) out.debtId = from.debtId;
  // (round 4, review H2) Only a USER-SET transfer flag on the pending row can
  // turn a non-transfer posted row into one, and only when the posted row was
  // never overridden itself — a posted row the user explicitly filed (either
  // way) is never re-flagged by an auto-tagged pending row's flag.
  if (
    !posted.isTransfer &&
    from.isTransfer &&
    from.isTransferUserOverridden &&
    !posted.isTransferUserOverridden
  ) {
    out.isTransfer = true;
  }
  return out;
}
