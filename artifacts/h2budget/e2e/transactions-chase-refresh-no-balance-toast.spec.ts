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
 * End-to-end coverage for task #385.
 *
 * When POST /api/forecast/refresh-bank succeeds at Plaid but the account
 * itself doesn't expose a current/available balance (often the case with
 * brokerage or sub-accounts silently linked under the same item), the
 * server returns a structured 502 body of the shape:
 *   { error, code: "no_balance", account: { name, mask } }
 *
 * The Chase Transactions page's refresh-bank `onError` handler in
 * `transactions.tsx` translates that into an account-aware destructive
 * toast — titled "<name> ••<mask> doesn't have a refreshable balance" —
 * with a "Set manually" ToastAction that navigates to /forecast.
 *
 * Without this spec, a regression in any of:
 *   - the toast title wording / account label (mask + nickname),
 *   - the `code === "no_balance"` branch selection,
 *   - or the action-refresh-bank-set-manual navigation target,
 * would slip through silently.
 *
 * We mock the network call via `page.route` so the test doesn't need a
 * real Plaid item — the client only cares about the response shape.
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

test.describe("Chase refresh-bank no_balance toast (#385)", () => {
  test("a no_balance 502 surfaces an account-aware toast and 'Set manually' jumps to /forecast", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-refresh-no-balance",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // --- Seed: one Chase Plaid item + checking account so the Chase
    // Transactions page renders and the refresh button is enabled. The
    // account name + mask seeded here are what the server-side
    // `account` payload echoes back in the no_balance body, so they're
    // also the strings the toast title must contain.
    const suffix = Math.random().toString(36).slice(2, 8);
    const ACCOUNT_NAME = "Joint Checking";
    const ACCOUNT_MASK = "2222";
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
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
        householdId,
        itemId: item.id,
        accountId: `e2e-acct-${suffix}`,
        name: ACCOUNT_NAME,
        mask: ACCOUNT_MASK,
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor the primary snapshot at this account so the Chase page
    // loads cleanly (no empty-bank-snapshot interstitial) and the
    // Refresh-from-Plaid button is on screen and enabled.
    const today = todayISO();
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1234.56",
      bankSnapshotAt: new Date(`${today}T12:00:00Z`),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acct.id,
      bankSnapshotName: acct.name,
      bankSnapshotMask: acct.mask,
    });

    const monthStart = thisMonthStart();
    const context = await browser.newContext();
    const page = await context.newPage();

    // --- Intercept POST /api/forecast/refresh-bank and respond with the
    // exact structured 502 the server returns for the no_balance case.
    let refreshCalls = 0;
    await page.route("**/api/forecast/refresh-bank", async (route) => {
      refreshCalls++;
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Plaid did not return a balance",
          code: "no_balance",
          account: { name: ACCOUNT_NAME, mask: ACCOUNT_MASK },
        }),
      });
    });

    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Press "Refresh from Plaid". The mocked 502 fires the
    // `onError` no_balance branch; the destructive toast title must
    // contain both the account nickname and ••mask, and the
    // "Set manually" ToastAction must navigate to /forecast.
    const refreshBtn = page.getByTestId("button-refresh-bank");
    await expect(refreshBtn).toBeVisible({ timeout: 10_000 });
    await refreshBtn.click();

    await expect.poll(() => refreshCalls).toBeGreaterThanOrEqual(1);

    // The toast title is rendered as a single string of the form
    // "Joint Checking ••2222 doesn't have a refreshable balance".
    // Asserting both the nickname and the masked-digits chunk catches
    // a regression that drops either piece of the account label.
    // Radix toast renders the title twice — once visibly inside the
    // toast and once inside an aria-live announcement region — so we
    // narrow to the visible ToastTitle node before asserting.
    const toastTitle = page
      .locator('[data-component-name="ToastTitle"]')
      .filter({
        hasText: `${ACCOUNT_NAME} ••${ACCOUNT_MASK} doesn't have a refreshable balance`,
      });
    await expect(toastTitle).toBeVisible({ timeout: 10_000 });

    const setManual = page.getByTestId("action-refresh-bank-set-manual");
    await expect(setManual).toBeVisible();
    await setManual.click();

    await expect(page).toHaveURL(/\/forecast(\?|$)/, { timeout: 10_000 });

    await context.close();
  });
});
