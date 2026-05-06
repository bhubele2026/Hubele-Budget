import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (#357) When `/api/plaid/sync` returns a per-item ITEM_LOGIN_REQUIRED
 * failure, the header SyncButton must render a toast that
 *   * NEVER includes the raw axios "Request failed with status code 400"
 *     string,
 *   * names the institution ("Chase: …"), and
 *   * surfaces a Reconnect ToastAction that opens Plaid Link in update
 *     mode for the failing item (POST /api/plaid/link-token/update),
 *     instead of bouncing the user to /settings.
 *
 * The spec mocks the `/api/plaid/items` and `/api/plaid/sync` responses
 * via `page.route` so we can drive the exact server payload without
 * provisioning a real Plaid sandbox item.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Plaid sync error toast — #357", () => {
  test("shows '<Institution>: <plain reason>' + Reconnect CTA on ITEM_LOGIN_REQUIRED, not 'status code 400'", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "plaid-sync-error-toast",
      provisionedUserIds,
    );

    // Mock the Plaid items list so SyncButton renders (it short-circuits
    // when the user has zero items).
    await page.route("**/api/plaid/items", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "fake-item-row-1",
            itemId: "item-chase-1",
            institutionId: "ins_1",
            institutionName: "Chase",
            institutionSlug: "chase",
            lastSyncedAt: null,
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparing: false,
            accounts: [],
          },
        ]),
      });
    });

    // Mock the sync response with a structured ITEM_LOGIN_REQUIRED
    // failure that carries plaidErrorCode/plaidErrorMessage/
    // plaidDisplayMessage/requestId/httpStatus/kind=reauth.
    await page.route("**/api/plaid/sync", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              itemId: "item-chase-1",
              plaidItemRowId: "fake-item-row-1",
              institutionName: "Chase",
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
                "Please reconnect your account to continue syncing.",
              requestId: "req-e2e-abc",
              httpStatus: 400,
              kind: "reauth",
            },
          ],
        }),
      });
    });

    // Land on the Amex page — it renders SyncButton unfiltered, so the
    // mocked Chase item is in scope. (The Transactions page filters
    // SyncButton by the currently-viewed account's owning Plaid item.)
    await signInAndOpen(page, email, password, "/amex");

    const syncBtn = page.getByTestId("button-sync-plaid");
    await expect(syncBtn).toBeVisible({ timeout: 15_000 });
    await syncBtn.click();

    // Toast description must include the institution + Plaid's
    // display_message — and MUST NOT include the bare axios string.
    // The same string is rendered both inside the visible Toast
    // description and the screen-reader live region, so locate via
    // the testid'd ToastDescription specifically.
    const toastDesc = page
      .locator('[data-component-name="ToastDescription"]')
      .filter({ hasText: /Chase:\s*Please reconnect your account/i })
      .first();
    await expect(toastDesc).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/status code 400/i)).toHaveCount(0);

    // Reconnect CTA must open Plaid Link in update mode for the
    // *failing* item — capture the POST so we can assert the itemId
    // was threaded through, instead of asserting a /settings nav (the
    // pre-#357 behavior we explicitly replaced).
    let updateTokenItemId: string | null = null;
    await page.route("**/api/plaid/link-token/update", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      updateTokenItemId = body.itemId ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ linkToken: "link-sandbox-mocked" }),
      });
    });

    const reconnect = page.getByTestId("button-toast-plaid-reconnect");
    await expect(reconnect).toBeVisible();
    await reconnect.click();

    await expect
      .poll(() => updateTokenItemId, { timeout: 10_000 })
      .toBe("fake-item-row-1");

    // The page must NOT navigate to /settings — the whole point of
    // #357's CTA is inline reconnect via Plaid Link.
    await expect(page).not.toHaveURL(/\/settings$/);
  });
});
