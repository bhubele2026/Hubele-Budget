import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (#373) Amex page parity for the #357/#367 Plaid reconnect flow that
 * already ships on Chase / Transactions.
 *
 * The Amex page must:
 *   1. Render the page-top re-auth banner ONLY when the failing item
 *      is the Amex-owning item — a Chase-only failure must NOT surface.
 *   2. Surface the SyncButton's inline error chip / Reconnect popover
 *      for the failing Amex item, naming the institution.
 *   3. Reconnect inline via Plaid Link (POST /api/plaid/link-token/update)
 *      threading the failing item id, instead of bouncing to /settings.
 *   4. Render the per-item "Refresh from Plaid" header button, scoped to
 *      the Amex item.
 *
 * Mocks `/api/plaid/items` and `/api/plaid/sync` so we can drive the
 * exact server payload without a real Plaid sandbox item, and seed at
 * least one Amex-source transaction whose `plaidAccountId` matches the
 * mocked Amex item's account so the page-scoping helper hooks resolve.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const AMEX_ITEM_ROW_ID = "amex-item-row-1";
const AMEX_ITEM_EXTERNAL_ID = "item-amex-1";
const AMEX_ACCOUNT_ROW_ID = "amex-acct-row-1";
const AMEX_ACCOUNT_EXTERNAL_ID = "amex-card-ext-acct-1";
const CHASE_ITEM_ROW_ID = "chase-item-row-1";
const CHASE_ITEM_EXTERNAL_ID = "item-chase-1";

test.describe("Amex page — Plaid reconnect parity (#373)", () => {
  test("Amex-only ITEM_LOGIN_REQUIRED surfaces the Amex item, ignores Chase, and reconnects inline", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-page-reconnect",
      provisionedUserIds,
    );

    await page.route("**/api/plaid/items", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: AMEX_ITEM_ROW_ID,
            itemId: AMEX_ITEM_EXTERNAL_ID,
            institutionId: "ins_amex",
            institutionName: "American Express",
            institutionSlug: "amex",
            lastSyncedAt: null,
            lastSyncError: "the login details of this item have changed",
            lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
            stillPreparing: false,
            accounts: [
              {
                id: AMEX_ACCOUNT_ROW_ID,
                accountId: AMEX_ACCOUNT_EXTERNAL_ID,
                name: "Amex Gold",
                type: "credit",
                subtype: "credit card",
              },
            ],
          },
          {
            // A healthy Chase item that must NOT bleed onto the Amex page.
            id: CHASE_ITEM_ROW_ID,
            itemId: CHASE_ITEM_EXTERNAL_ID,
            institutionId: "ins_chase",
            institutionName: "Chase",
            institutionSlug: "chase",
            lastSyncedAt: null,
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparing: false,
            accounts: [
              {
                id: "chase-acct-row-1",
                accountId: "chase-checking-ext",
                name: "Chase Checking",
                type: "depository",
                subtype: "checking",
              },
            ],
          },
        ]),
      });
    });

    await page.route("**/api/plaid/sync", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              itemId: AMEX_ITEM_EXTERNAL_ID,
              plaidItemRowId: AMEX_ITEM_ROW_ID,
              institutionName: "American Express",
              added: 0,
              modified: 0,
              removed: 0,
              autoCategorized: 0,
              ruleAttributions: [],
              error: "the login details of this item have changed",
              plaidErrorCode: "ITEM_LOGIN_REQUIRED",
              plaidErrorMessage:
                "the login details of this item have changed",
              plaidDisplayMessage:
                "Please reconnect your Amex account to continue syncing.",
              requestId: "req-e2e-amex",
              httpStatus: 400,
              kind: "reauth",
            },
          ],
        }),
      });
    });

    // Mock the debts list with a linked Amex debt — this gives the
    // Amex page's debt-derived scope signal a hit even before any
    // synced Amex transactions exist, so the per-item "Refresh from
    // Plaid" button + scoped re-auth banner render in this test.
    await page.route("**/api/debts", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "debt-amex-1",
            name: "Amex Gold",
            balance: "1234.56",
            plaidAccountId: AMEX_ACCOUNT_ROW_ID,
            plaidLastSyncError: "the login details of this item have changed",
            plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
          },
        ]),
      });
    });

    await signInAndOpen(page, email, password, "/amex");

    // Header sync button must render and the inline error chip / Reconnect
    // popover must surface the Amex item once we click it.
    const syncBtn = page.getByTestId("button-sync-plaid");
    await expect(syncBtn).toBeVisible({ timeout: 15_000 });
    await syncBtn.click();

    const toastDesc = page
      .locator('[data-component-name="ToastDescription"]')
      .filter({ hasText: /American Express:\s*Please reconnect your Amex/i })
      .first();
    await expect(toastDesc).toBeVisible({ timeout: 10_000 });

    // Chase failure must never surface here — we never sent one, but
    // double-check Chase isn't named in the toast.
    await expect(page.getByText(/Chase:/)).toHaveCount(0);
    await expect(page.getByText(/status code 400/i)).toHaveCount(0);

    // Per-item "Refresh from Plaid" header button must be present
    // (#373's parity addition with the Chase header).
    await expect(page.getByTestId("button-refresh-amex")).toBeVisible();

    // Reconnect CTA must thread the failing item id into
    // POST /api/plaid/link-token/update — NOT navigate to /settings.
    let updateTokenItemId: string | null = null;
    await page.route("**/api/plaid/link-token/update", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      updateTokenItemId = body.itemId ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ linkToken: "link-sandbox-mocked-amex" }),
      });
    });

    const reconnect = page.getByTestId("button-toast-plaid-reconnect");
    await expect(reconnect).toBeVisible();
    await reconnect.click();

    await expect
      .poll(() => updateTokenItemId, { timeout: 10_000 })
      .toBe(AMEX_ITEM_ROW_ID);
    await expect(page).not.toHaveURL(/\/settings$/);
  });
});
