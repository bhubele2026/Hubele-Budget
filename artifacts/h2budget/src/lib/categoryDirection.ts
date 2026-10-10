import {
  categoryDirectionConflict,
  isCardLedgerRow,
  type DirectionConflict,
  type SpendContext,
  type SpendTxn,
} from "@/lib/avalanche";
import type { PlaidItemDetail } from "@workspace/api-client-react";

/**
 * ⭐ "INCOME FILED UNDER AN EXPENSE CATEGORY" — a deterministic review flag.
 *
 * A paycheck credit sitting in Dining & Coffee (seen live, 2026-10-09) is not
 * spending and not income anywhere the app looks: the spending rule ignores an
 * inflow, and `isRealIncome` only counts an inflow filed under an INCOME
 * category. So it silently drops out of both. This says so, for a person to
 * re-file. It never changes a row or a total.
 *
 * (WP5c) It is the shared direction rule itself — `categoryDirectionConflict`
 * in `@workspace/avalanche-core` (spendingRule.ts, via `@/lib/avalanche`) — the
 * same predicate the server's categorizer uses to stop a rule, a merchant
 * memory or a model from filing a row this way. This file only reads a row and
 * the categories list the way that rule needs them; it decides nothing itself.
 * In short, the rule says money in under an expense category is flagged unless
 * it is a transfer, a debt row or debt category, an excluded category
 * (Transfer, Ignore, Reimbursement, …), reimbursable, a credit on a CARD (any
 * issuer: the caller says, from the account's type), or a refund by
 * `classifyRefund`; and that the system "Uncategorized" category files a row
 * nowhere. Pure: same row and categories in, same answer out.
 */

/** A category as the categories list gives it (a generated `Category` fits). */
export interface DirectionCategory {
  name: string;
  kind: string;
  /** Set on a debt's own category, when the caller has it. */
  debtId?: string | null;
  /** `auto_debts` marks a debt's own category (one per debt, server-synced). */
  sourceKind?: string | null;
}

/** What the flag reads from a row (a generated `Transaction` fits). */
export interface DirectionTxn {
  amount: string | number;
  source: string;
  categoryId?: string | null;
  description: string;
  isTransfer: boolean;
  debtId?: string | null;
  isExternalCardPayment: boolean;
  reimbursable: boolean;
  pfcDetailed?: string | null;
  /** Plaid's EXTERNAL account id — the key of `accountTypesOf`. */
  plaidAccountId?: string | null;
}

/**
 * The system "Uncategorized" category, by its exact name — the same test the
 * server applies (`uncategorizedCategoryIds`, api-server lib/pendingFiling.ts).
 */
const UNCATEGORIZED_NAME = "Uncategorized";

function contextOf(categoriesById: ReadonlyMap<string, DirectionCategory>): {
  ctx: SpendContext;
  uncategorizedIds: Set<string>;
} {
  const map: SpendContext["categoriesById"] = new Map();
  const uncategorizedIds = new Set<string>();
  for (const [id, c] of categoriesById) {
    map.set(id, {
      name: c.name,
      kind: c.kind,
      debtId: c.debtId ?? (c.sourceKind === "auto_debts" ? `auto_debts:${id}` : null),
    });
    if (c.name === UNCATEGORIZED_NAME) uncategorizedIds.add(id);
  }
  return { ctx: { categoriesById: map, debtCategoryIds: new Set() }, uncategorizedIds };
}

/** Categories keyed by id, for `isInflowFiledAsExpense`. */
export function categoriesByIdOf<C extends DirectionCategory & { id: string }>(
  categories: readonly C[] | null | undefined,
): Map<string, C> {
  return new Map((categories ?? []).map((c) => [c.id, c]));
}

/**
 * (WP5c) Each Plaid account's type, keyed by Plaid's EXTERNAL `account_id` —
 * what a transaction's `plaidAccountId` holds (never the internal row id).
 */
export function accountTypesOf(
  items: readonly PlaidItemDetail[] | null | undefined,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const it of items ?? []) {
    for (const a of it.accounts ?? []) out.set(a.accountId, a.type ?? null);
  }
  return out;
}

/** (WP5c) Is the row on a card: a credit account (any bank), or a card ledger source? */
export function isCardTxn(
  txn: Pick<DirectionTxn, "source" | "plaidAccountId">,
  accountTypes: ReadonlyMap<string, string | null>,
): boolean {
  const type = txn.plaidAccountId ? accountTypes.get(txn.plaidAccountId) : null;
  return isCardLedgerRow(txn.source, type);
}

/** (WP5c) The shared direction rule, for a row as filed today. */
export function directionConflictOfTxn(
  txn: DirectionTxn,
  categoriesById: ReadonlyMap<string, DirectionCategory>,
  opts: { isCardAccount: boolean },
): DirectionConflict | null {
  const tx: SpendTxn = {
    amount: txn.amount,
    source: txn.source,
    isTransfer: txn.isTransfer,
    categoryId: txn.categoryId ?? null,
    description: txn.description,
    debtId: txn.debtId ?? null,
    isExternalCardPayment: txn.isExternalCardPayment,
    reimbursable: txn.reimbursable,
    pfcDetailed: txn.pfcDetailed ?? null,
  };
  const { ctx, uncategorizedIds } = contextOf(categoriesById);
  return categoryDirectionConflict(tx, tx.categoryId, ctx, {
    isCardAccount: opts.isCardAccount,
    uncategorizedIds,
  });
}

/** Money in, filed under an expense category (see the header). */
export function isInflowFiledAsExpense(
  txn: DirectionTxn,
  categoriesById: ReadonlyMap<string, DirectionCategory>,
  opts: { isCardAccount: boolean },
): boolean {
  return directionConflictOfTxn(txn, categoriesById, opts) === "inflow_into_expense";
}
