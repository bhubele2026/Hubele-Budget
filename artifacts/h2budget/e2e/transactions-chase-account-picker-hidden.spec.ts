import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #410.
 *
 * The Chase Transactions page hides the "View account" picker entirely
 * when the user has only one real linked checking account. The account
 * label still appears inline in the snapshot meta line, so the user can
 * see which account they're viewing without a redundant single-option
 * dropdown. The multi-account picker behavior is covered by #297 / #316.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, userId));
      await db
        .delete(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, userId));
      await db
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, userId));
      await db
        .delete(plaidItemsTable)
        .where(eq(plaidItemsTable.userId, userId));
    } catch {
      // best-effort
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function thisMonthStart(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

test.describe("Chase per-account picker — hidden for single-account users (#410)", () => {
  test("picker is not rendered when only one real checking account is linked", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-account-picker-hidden",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        itemId: `e2e-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        itemId: item.id,
        accountId: `e2e-acct-${suffix}`,
        name: "Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    const today = todayISO();
    await db.insert(forecastSettingsTable).values({
      userId,
      bankSnapshotBalance: "1234.56",
      bankSnapshotAt: new Date(`${today}T12:00:00Z`),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acct.id,
      bankSnapshotName: acct.name,
      bankSnapshotMask: acct.mask,
    });

    await db.insert(transactionsTable).values({
      userId,
      occurredOn: today,
      occurredAt: new Date(`${today}T15:00:00Z`).toISOString(),
      description: `E2E-${suffix} solo`,
      amount: "100.00",
      account: "Total Checking",
      source: "plaid",
      plaidTransactionId: `e2e-${suffix}-solo`,
      plaidAccountId: acct.accountId,
    });

    const monthStart = thisMonthStart();
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Snapshot meta line is visible (so we know forecast data has loaded
    // and the page settled into its post-fetch state) and shows the
    // single account inline.
    const meta = page.getByTestId("text-snapshot-meta");
    await expect(meta).toBeVisible({ timeout: 15_000 });
    await expect(meta).toContainText(/••5526/);

    // The picker is hidden entirely — no dropdown for a single account.
    await expect(page.getByTestId("chase-account-picker")).toHaveCount(0);
    await expect(page.getByTestId("select-chase-account")).toHaveCount(0);

    await context.close();
  });
});
