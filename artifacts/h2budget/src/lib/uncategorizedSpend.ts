import {
  classifyOutflow,
  spendAmount,
  type SpendContext,
} from "@workspace/avalanche-core";

/**
 * (PR7) Which ledger rows the Spending page's "Needs a category" popover
 * offers to fix. It runs THE server's spending rule (`classifyOutflow`, shared
 * from `@workspace/avalanche-core`), not a browser copy of it, so the rows it
 * lists are exactly the ones the server counts in `uncategorized`: no card
 * payments, transfers, reimbursable charges or bank noise.
 *
 * The shape is structural so a generated `Transaction` fits as-is.
 */
export type SpendRow = {
  amount: string;
  source: string;
  isTransfer: boolean;
  categoryId?: string | null;
  description: string;
  debtId?: string | null;
  isExternalCardPayment: boolean;
  reimbursable: boolean;
  pfcDetailed?: string | null;
};

/**
 * Only whether a row's category still EXISTS can change the uncategorized
 * verdict: a live category makes the row categorized spend or excluded (both
 * "not uncategorized"), a deleted one makes it uncategorized. So the context
 * needs the category ids, not their names, kinds or debt links.
 */
function contextFor(categoryIds: Iterable<string>): SpendContext {
  const categoriesById: SpendContext["categoriesById"] = new Map();
  for (const id of categoryIds) {
    categoriesById.set(id, { name: "", debtId: null, kind: "expense" });
  }
  return { categoriesById, debtCategoryIds: new Set() };
}

export function spendAmountOf(t: Pick<SpendRow, "amount" | "source">): number {
  return spendAmount(t);
}

export function isUncategorizedSpendRow(
  t: SpendRow,
  categoryIds: Iterable<string> = [],
): boolean {
  const c = classifyOutflow(
    {
      amount: t.amount,
      source: t.source,
      isTransfer: t.isTransfer,
      categoryId: t.categoryId ?? null,
      description: t.description,
      debtId: t.debtId ?? null,
      isExternalCardPayment: t.isExternalCardPayment,
      reimbursable: t.reimbursable,
      pfcDetailed: t.pfcDetailed ?? null,
    },
    contextFor(categoryIds),
  );
  return c.kind === "spend" && !c.categorized;
}
