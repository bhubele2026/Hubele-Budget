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
 * (#360) Locks the Manual-view suppression contract added in #357.
 *
 * When the user is viewing the Manual account on /transactions, the global
 * Plaid re-auth banner is hidden and SyncButton is scoped to an empty
 * allow-list of items so the inline error chip + per-item Reconnect popover
 * stay quiet — even if a different linked bank (e.g. Chase) is in
 * ITEM_LOGIN_REQUIRED state. This is currently only enforced by code review;
 * this spec adds an automated lock so a future refactor can't silently bring
 * the noisy chip / banner back on the Manual view.
 *
 * The companion path — switching back to the Plaid-linked account — must
 * re-show both the banner and the inline reauth popover, since on that view
 * the broken Plaid item *is* this view's data.
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

test.describe("Transactions Manual view suppresses reauth noise (#360)", () => {
  test("hides the PlaidReauthBanner + Reconnect popover on Manual; re-shows both on the Plaid-linked account", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-manual-suppresses-reauth",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // Seed a single Plaid item for "Chase" stuck in ITEM_LOGIN_REQUIRED so
    // both the global banner and SyncButton's reauth popover would normally
    // fire. The picker is only rendered when at least one Plaid checking
    // account exists, so we attach one.
    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        itemId: `e2e-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
        lastSyncError: "the login details of this item have changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        itemId: item.id,
        accountId: `e2e-acct-${suffix}`,
        name: "Total Checking",
        mask: "1111",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor the bank snapshot at the Plaid account so it's the default
    // landing view (matches the existing picker spec's seeding pattern).
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

    // One Plaid-linked txn + one Manual txn so each view has at least
    // one row to confirm the picker actually switched.
    await db.insert(transactionsTable).values({
      userId,
      occurredOn: today,
      occurredAt: new Date(`${today}T15:00:00Z`).toISOString(),
      description: `E2E-${suffix} plaid`,
      amount: "12.34",
      account: "Total Checking",
      source: "plaid",
      plaidTransactionId: `e2e-${suffix}-plaid-1`,
      plaidAccountId: acct.accountId,
    });
    await db.insert(transactionsTable).values({
      userId,
      occurredOn: today,
      occurredAt: new Date(`${today}T16:00:00Z`).toISOString(),
      description: `E2E-${suffix} manual`,
      amount: "-9.99",
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

    const banner = page.getByTestId("banner-plaid-reauth");
    const reconnectTrigger = page.getByTestId(
      "button-plaid-reconnect-trigger",
    );
    const syncErrorChip = page.getByTestId("text-sync-error");
    const trigger = page.getByTestId("select-chase-account");

    // --- Default landing view = the Plaid-linked snapshot account.
    // Both the page-top reauth banner and the SyncButton's per-bank
    // Reconnect popover trigger must be visible (the broken Chase item
    // IS this view's data here).
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(reconnectTrigger).toBeVisible();

    // --- Switch to the Manual account via the picker.
    await trigger.click();
    const optionManual = page.getByTestId("option-chase-account-manual");
    await expect(optionManual).toBeVisible({ timeout: 10_000 });
    await optionManual.click();

    // The Manual row should be visible to confirm the switch landed.
    await expect(
      page.getByText(`E2E-${suffix} manual`),
    ).toBeVisible({ timeout: 10_000 });

    // The whole point of #357: on Manual, the global banner is gone,
    // the SyncButton's inline error chip is gone, and the Reconnect
    // popover trigger is gone — the broken Chase item must not bleed
    // into a Manual account view.
    await expect(banner).toHaveCount(0);
    await expect(reconnectTrigger).toHaveCount(0);
    await expect(syncErrorChip).toHaveCount(0);

    // SyncButton itself stays mounted (global Sync remains a click
    // away even when the filter excludes everything).
    await expect(page.getByTestId("button-sync-plaid")).toBeVisible();

    // --- Switch back to the Plaid-linked account: banner + Reconnect
    // popover must reappear.
    await trigger.click();
    const optionPlaid = page.getByTestId(`option-chase-account-${acct.id}`);
    await expect(optionPlaid).toBeVisible({ timeout: 10_000 });
    await optionPlaid.click();

    await expect(
      page.getByText(`E2E-${suffix} plaid`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(reconnectTrigger).toBeVisible();

    await context.close();
  });
});
