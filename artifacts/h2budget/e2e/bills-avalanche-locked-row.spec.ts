import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, debtsTable, recurringItemsTable } from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  // Best-effort DB cleanup so this spec doesn't leak rows between runs.
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
      await db.delete(debtsTable).where(eq(debtsTable.userId, userId));
    } catch {
      // ignore — Clerk teardown below will still attempt user removal.
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Bills locked-row affordance + Avalanche deep-link (Task #70)", () => {
  test("locked debt-min row deep-links to /avalanche?focus=, dedups linked recurring item", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "bills-locked-row",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // Direct DB seed: minPaymentSource="plaid" is only writable via the
    // Plaid sync flow, which we can't drive from a test.
    const [debtPlaid] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Capital One Quicksilver",
        balance: "3500",
        apr: "0.2299",
        minPayment: "75",
        payment: "75",
        status: "active",
        dueDay: 15,
        minPaymentSource: "plaid",
      })
      .returning();
    const [debtUnlinked] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Discover It",
        balance: "1800",
        apr: "0.1899",
        minPayment: "55",
        payment: "55",
        status: "active",
        dueDay: 22,
        minPaymentSource: "manual",
      })
      .returning();
    const [linkedRecurring] = await db
      .insert(recurringItemsTable)
      .values({
        userId,
        householdId,
        name: "Discover It Min",
        kind: "bill",
        amount: "55",
        frequency: "monthly",
        dayOfMonth: 22,
        active: "true",
        debtId: debtUnlinked.id,
      })
      .returning();
    // Unrelated bill — must survive dedup so the test isn't trivially passing.
    await db.insert(recurringItemsTable).values({
      userId,
      householdId,
      name: "Internet",
      kind: "bill",
      amount: "75",
      frequency: "monthly",
      dayOfMonth: 1,
      active: "true",
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/bills");

    await expect(
      page.getByRole("heading", { name: /bills/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Both debt-min rows should appear, both locked.
    const rowPlaid = page.getByTestId(`row-debt-min-${debtPlaid.id}`);
    const rowUnlinked = page.getByTestId(`row-debt-min-${debtUnlinked.id}`);
    await expect(rowPlaid).toBeVisible({ timeout: 15_000 });
    await expect(rowUnlinked).toBeVisible();

    // Locked-row affordance: lock icon present, no inline edit button.
    await expect(
      rowPlaid.locator('svg[aria-label="Locked — managed by Debts"]'),
    ).toHaveCount(1);
    await expect(rowPlaid.getByRole("button", { name: /edit/i })).toHaveCount(0);
    await expect(
      rowUnlinked.locator('svg[aria-label="Locked — managed by Debts"]'),
    ).toHaveCount(1);
    await expect(rowUnlinked.getByRole("button", { name: /edit/i })).toHaveCount(0);

    // Plaid-linked rows show the "synced from Plaid" caption; manual don't.
    await expect(rowPlaid.getByText(/synced from Plaid/i)).toBeVisible();
    await expect(rowUnlinked.getByText(/synced from Plaid/i)).toHaveCount(0);

    // Dedup: the linked recurring item must NOT also render as a bill row.
    await expect(
      page.getByTestId(`row-bill-${linkedRecurring.id}`),
    ).toHaveCount(0);
    await expect(page.getByText("Internet", { exact: false })).toBeVisible();

    // Click the locked Plaid row → URL becomes /avalanche?focus=<debtPlaid.id>
    await rowPlaid.click();
    await page.waitForURL(/\/avalanche\?focus=/, { timeout: 10_000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/avalanche");
    expect(url.searchParams.get("focus")).toBe(debtPlaid.id);

    // The Future Goal page renders and the focused row picks up the highlight ring.
    await expect(
      page.getByRole("heading", { name: /^future goal$/i }),
    ).toBeVisible({ timeout: 15_000 });
    const focusedRow = page.getByTestId(`row-debt-${debtPlaid.id}`);
    await expect(focusedRow).toBeVisible();
    await expect(focusedRow).toHaveClass(/ring-primary/, { timeout: 3_000 });

    await context.close();
  });
});
