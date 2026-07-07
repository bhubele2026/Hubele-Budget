import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, debtsTable, recurringItemsTable } from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the auto-archive-on-payoff polish (Task #292):
 * editing a debt's balance to $0 via the Debts edit dialog (which lives on
 * /avalanche) must auto-archive it server-side, and the Bills page must then
 * render the celebratory "Stops at payoff" row for that debt in the same
 * session. Server-level coverage already exists in
 * `debtsAutoArchiveOnZero.integration.test.ts`; this spec locks the UI path
 * end-to-end so a regression in the edit dialog or the Bills row can't break
 * the polish silently.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
      await db.delete(debtsTable).where(eq(debtsTable.userId, userId));
    } catch {
      // ignore — Clerk teardown still attempts user removal.
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Bills celebratory 'Stops at payoff' row after auto-archive (Task #292)", () => {
  test("zeroing a debt's balance in the edit dialog surfaces the celebratory row on /bills", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "bills-payoff-row",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Visa Killer",
        balance: "1500",
        apr: "0.2299",
        minPayment: "50",
        payment: "50",
        status: "active",
        dueDay: 15,
        minPaymentSource: "manual",
      })
      .returning();

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/avalanche");

    await expect(
      page.getByRole("heading", { name: /^future goal$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Sanity: the debt row is visible before we edit it.
    const row = page.getByTestId(`row-debt-${debt.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Open the edit dialog via the row's pencil button.
    await row.getByRole("button").last().click();
    await expect(
      page.getByRole("heading", { name: `Edit ${debt.name}` }),
    ).toBeVisible({ timeout: 5_000 });

    // Zero the Balance field and save. The dialog's <Label> isn't htmlFor-
    // associated with the <Input>, so getByLabel won't find it — locate the
    // Balance label's sibling number input instead.
    const dialog = page.getByRole("dialog");
    const balanceInput = dialog
      .locator('div:has(> label:text-is("Balance ($)")) > input');
    await expect(balanceInput).toBeVisible();
    await balanceInput.fill("0");
    await dialog.getByRole("button", { name: "Save" }).click();

    // Dialog closes on success; the row drops out of the active table once
    // the server flips status → archived.
    await expect(
      page.getByRole("heading", { name: `Edit ${debt.name}` }),
    ).toHaveCount(0, { timeout: 10_000 });
    await expect(row).toHaveCount(0, { timeout: 10_000 });

    // Now navigate to Bills and assert the celebratory row.
    await page.goto("/bills");
    await expect(
      page.getByRole("heading", { name: /bills/i }),
    ).toBeVisible({ timeout: 15_000 });

    const paidRow = page.getByTestId(`row-debt-min-paid-${debt.id}`);
    await expect(paidRow).toBeVisible({ timeout: 15_000 });
    await expect(paidRow).toContainText("Visa Killer minimum");
    await expect(paidRow).toContainText(/Stops at payoff/i);
    // The historical minimum is rendered struck-through next to the row.
    await expect(paidRow).toContainText("$50.00");

    // The regular (active) debt-min row must be gone — both can't render at
    // the same time for the same debt.
    await expect(
      page.getByTestId(`row-debt-min-${debt.id}`),
    ).toHaveCount(0);

    await context.close();
  });
});
