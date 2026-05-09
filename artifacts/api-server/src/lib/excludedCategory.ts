import { and, eq } from "drizzle-orm";
import { db, budgetCategoriesTable } from "@workspace/db";
import { TRANSFER_CATEGORY_NAME } from "./budgetSeed";

// (#474, #607) Shared guard: returns true when `categoryId` belongs to a
// budget category flagged `exclude_from_budget` (today: the system-managed
// "Uncategorized" and "Transfer" rows). Mapping rules must never target an
// excluded category — auto-categorize would otherwise sweep rows into
// Uncategorized/Transfer, both of which exist only as manual picks from
// the row's category picker. Centralised so every rule-mutating endpoint
// (mapping CRUD, transactions auto-learn, recategorize-by-pattern Undo
// repoint) shares the same check.
export async function isExcludedCategory(
  userId: string,
  categoryId: string | null | undefined,
): Promise<boolean> {
  if (!categoryId) return false;
  const [cat] = await db
    .select({ excludeFromBudget: budgetCategoriesTable.excludeFromBudget })
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.id, categoryId),
        eq(budgetCategoriesTable.userId, userId),
      ),
    );
  return Boolean(cat?.excludeFromBudget);
}

// (#607) Returns true when `categoryId` is the user's system-managed
// "Transfer" category. Used by the transactions PATCH/POST handlers to
// flip `isTransfer=true` (with `isTransferUserOverridden=true`) and
// clear allowance fields when the picker selects this category. Looked
// up by name so it survives the Uncategorized-style lazy-seed flow
// without needing a stable id.
export async function isTransferCategory(
  userId: string,
  categoryId: string | null | undefined,
): Promise<boolean> {
  if (!categoryId) return false;
  const [cat] = await db
    .select({ name: budgetCategoriesTable.name })
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.id, categoryId),
        eq(budgetCategoriesTable.userId, userId),
      ),
    );
  return cat?.name === TRANSFER_CATEGORY_NAME;
}

export const EXCLUDED_CATEGORY_RULE_ERROR =
  "Mapping rules cannot target the Uncategorized or Transfer category. Pick a real budget category.";
