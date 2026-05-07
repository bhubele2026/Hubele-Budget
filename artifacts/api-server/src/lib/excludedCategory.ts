import { and, eq } from "drizzle-orm";
import { db, budgetCategoriesTable } from "@workspace/db";

// (#474) Shared guard: returns true when `categoryId` belongs to a
// budget category flagged `exclude_from_budget` (today: just the
// system-managed "Uncategorized"). Mapping rules must never target an
// excluded category — auto-categorize would otherwise sweep rows into
// Uncategorized, which exists only as a manual triage option from the
// row's category picker. Centralised so every rule-mutating endpoint
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

export const EXCLUDED_CATEGORY_RULE_ERROR =
  "Mapping rules cannot target the Uncategorized category. Pick a real budget category.";
