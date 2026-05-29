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
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #797 (scope the Chase "View account"
 * dropdown to Chase only).
 *
 * The forecast API's `listCheckingAccounts` filters purely by
 * subtype/type, so any depository account from another institution
 * (PayPal, etc.) leaks into `plaidCheckingAccounts`. The Chase page now
 * filters that list to Chase-only before rendering the picker and driving
 * all account scoping. This test seeds two Chase checking accounts plus a
 * non-Chase (PayPal) depository account and asserts:
 *   - The picker lists ONLY the two Chase accounts.
 *   - The PayPal account never appears as an option.
 *   - The dead "Manual entries" pseudo-account option is gone entirely.
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

test.describe("Chase account picker is Chase-only (#797)", () => {
  test("dropdown lists only Chase accounts — PayPal and Manual entries never appear", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-only-picker",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const suffix = Math.random().toString(36).slice(2, 8);

    // --- Two Chase checking accounts under a Chase Plaid item.
    const [chaseItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `e2e-chase-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [chaseA] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: chaseItem.id,
        accountId: `e2e-chase-A-${suffix}`,
        name: "Total Checking",
        mask: "1111",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    const [chaseB] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: chaseItem.id,
        accountId: `e2e-chase-B-${suffix}`,
        name: "Joint Checking",
        mask: "2222",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // --- A non-Chase (PayPal) depository account under a separate item.
    // This is the row that previously leaked into the Chase dropdown
    // because it passes the subtype/type-only API filter.
    const [paypalItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `e2e-paypal-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "PayPal",
        institutionSlug: "paypal",
      })
      .returning();
    const [paypalAcct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: paypalItem.id,
        accountId: `e2e-paypal-${suffix}`,
        name: "PayPal Balance",
        mask: "9999",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor the bank snapshot at Chase account A so the page lands on a
    // Chase account by default.
    const today = todayISO();
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1234.56",
      bankSnapshotAt: new Date(`${today}T12:00:00Z`),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: chaseA.id,
      bankSnapshotName: chaseA.name,
      bankSnapshotMask: chaseA.mask,
    });

    // A manual row (no plaidAccountId) — previously this would have
    // enabled the now-removed "Manual entries" picker option.
    await db.insert(transactionsTable).values({
      userId,
      householdId,
      occurredOn: today,
      occurredAt: new Date(`${today}T15:00:00Z`).toISOString(),
      description: `E2E-${suffix} manual`,
      amount: "10.00",
      account: "Cash",
      source: "manual",
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

    // The picker shows because there are 2+ Chase accounts.
    const picker = page.getByTestId("chase-account-picker");
    const trigger = page.getByTestId("select-chase-account");
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await trigger.click();

    // Both Chase accounts are listed.
    await expect(
      page.getByTestId(`option-chase-account-${chaseA.id}`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId(`option-chase-account-${chaseB.id}`),
    ).toBeVisible();

    // The PayPal account never leaks into the Chase dropdown.
    await expect(
      page.getByTestId(`option-chase-account-${paypalAcct.id}`),
    ).toHaveCount(0);

    // The dead "Manual entries" pseudo-account option is gone.
    await expect(
      page.getByTestId("option-chase-account-manual"),
    ).toHaveCount(0);

    // Exactly two options total — the two Chase accounts and nothing else.
    await expect(
      page.getByTestId("chase-account-options").getByRole("option"),
    ).toHaveCount(2);

    await context.close();
  });

  test("legacy persisted account=manual self-heals to the Chase account now that the manual option is gone", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-manual-selfheal",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const suffix = Math.random().toString(36).slice(2, 8);
    const [chaseItem] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `e2e-chase-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [chaseAcct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: chaseItem.id,
        accountId: `e2e-chase-${suffix}`,
        name: "Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    const today = todayISO();
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1234.56",
      bankSnapshotAt: new Date(`${today}T12:00:00Z`),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: chaseAcct.id,
      bankSnapshotName: chaseAcct.name,
      bankSnapshotMask: chaseAcct.mask,
    });

    const [chaseRow] = await db
      .insert(transactionsTable)
      .values({
        userId,
        householdId,
        occurredOn: today,
        occurredAt: new Date(`${today}T15:00:00Z`).toISOString(),
        description: `E2E-${suffix} chase`,
        amount: "100.00",
        account: "Total Checking",
        source: "plaid",
        plaidTransactionId: `e2e-${suffix}-chase`,
        plaidAccountId: chaseAcct.accountId,
      })
      .returning();

    // Open the page with a legacy persisted `account=manual` selection.
    // With the manual picker option removed and a Chase account present,
    // the page must self-heal back to the Chase account.
    const monthStart = thisMonthStart();
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}&account=manual`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The Chase row renders (we landed on the Chase account, not a stuck
    // manual-only view).
    await expect(page.getByTestId(`row-tx-${chaseRow.id}`)).toBeVisible({
      timeout: 15_000,
    });

    // The stale `manual` selection was cleared from persistence.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .not.toBe("manual");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem("h2budget:chase-account"),
        ),
      )
      .not.toBe("manual");

    // Single Chase account → picker stays hidden.
    await expect(page.getByTestId("chase-account-picker")).toHaveCount(0);

    await context.close();
  });
});
