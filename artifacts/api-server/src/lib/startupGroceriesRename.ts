import { and, eq } from "drizzle-orm";
import {
  budgetCategoriesTable,
  db,
  recurringItemsTable,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * One-shot startup pass: rename the "Weekly Spend" recurring item to
 * "Groceries & Dining" and re-link it from Misc/Buffer to the
 * Groceries budget category for the affected user. Confirmed by the
 * user (chat 2026-05-09): the $450/wk bill is their actual food +
 * groceries spend, not a generic catch-all.
 *
 * Targeted to a single user_id and a single bill name so it's a
 * no-op for everyone else and idempotent (re-running after the first
 * pass is also a no-op because the WHERE clause won't match).
 */
const TARGET_USER_ID = "user_3DEMSSg5icQ1ZEVuEv0bGoHNQtt";
const OLD_NAME = "Weekly Spend";
const NEW_NAME = "Groceries & Dining";
const TARGET_CATEGORY_NAME = "Groceries";

export async function runStartupGroceriesRename(): Promise<{
  renamed: boolean;
  reason?: string;
}> {
  try {
    const [bill] = await db
      .select({
        id: recurringItemsTable.id,
        currentCategoryId: recurringItemsTable.categoryId,
      })
      .from(recurringItemsTable)
      .where(
        and(
          eq(recurringItemsTable.userId, TARGET_USER_ID),
          eq(recurringItemsTable.name, OLD_NAME),
        ),
      )
      .limit(1);

    if (!bill) return { renamed: false, reason: "bill_not_found_or_already_renamed" };

    const [groceries] = await db
      .select({ id: budgetCategoriesTable.id })
      .from(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.userId, TARGET_USER_ID),
          eq(budgetCategoriesTable.name, TARGET_CATEGORY_NAME),
        ),
      )
      .limit(1);

    if (!groceries) {
      return { renamed: false, reason: "groceries_category_missing" };
    }

    await db
      .update(recurringItemsTable)
      .set({
        name: NEW_NAME,
        categoryId: groceries.id,
      })
      .where(eq(recurringItemsTable.id, bill.id));

    logger.info(
      {
        userId: TARGET_USER_ID,
        billId: bill.id,
        previousCategoryId: bill.currentCategoryId,
        newCategoryId: groceries.id,
      },
      "Startup groceries rename: 'Weekly Spend' -> 'Groceries & Dining', linked to Groceries",
    );
    return { renamed: true };
  } catch (err) {
    logger.error({ err }, "Startup groceries rename failed");
    return { renamed: false, reason: "error" };
  }
}
