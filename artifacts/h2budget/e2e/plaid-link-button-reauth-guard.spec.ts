import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (#706) "Connect a bank" guard for duplicate-link spawning.
 *
 * Reproduces the exact production scenario that left the user's Chase
 * transactions stranded: a Chase plaid_item is in INVALID_ACCESS_TOKEN
 * state (cursor + history live on it, auth dead). If the user clicks
 * "Link a Bank or Card" on Settings, the button must NOT silently mint
 * a fresh link token (which would spawn a duplicate Chase item with no
 * cursor). Instead it must open a confirmation dialog steering the user
 * into update mode for the dead item.
 *
 * The dialog must:
 *   1. List the institution(s) currently needing reauth.
 *   2. Offer a Reconnect button per row that triggers
 *      POST /api/plaid/link-token/update with that item's row id.
 *   3. Offer an explicit "Link a different bank anyway" escape hatch
 *      that proceeds with the original fresh-link flow.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const DEAD_CHASE_ITEM_ROW_ID = "chase-dead-row-1";
const DEAD_CHASE_ITEM_EXTERNAL_ID = "item-chase-dead-1";

test.describe("PlaidLinkButton — fresh-link guard (#706)", () => {
  test("intercepts Link click when an existing item is in INVALID_ACCESS_TOKEN, opens update-mode for that item", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "plaid-link-button-reauth-guard",
      provisionedUserIds,
    );

    await page.route("**/api/plaid/items", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: DEAD_CHASE_ITEM_ROW_ID,
            itemId: DEAD_CHASE_ITEM_EXTERNAL_ID,
            institutionId: "ins_chase",
            institutionName: "Chase",
            institutionSlug: "chase",
            lastSyncedAt: null,
            lastSyncError:
              "This bank's saved login is no longer valid — reconnect to bring in new transactions.",
            lastSyncErrorCode: "INVALID_ACCESS_TOKEN",
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

    // Capture any fresh-link or update-mode calls so we can assert the
    // button took the right path. The fresh route must NOT be hit on the
    // guarded click.
    let freshLinkTokenCalled = false;
    await page.route("**/api/plaid/link-token", async (route) => {
      if (route.request().method() === "POST") {
        freshLinkTokenCalled = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ linkToken: "link-sandbox-mocked-fresh" }),
        });
        return;
      }
      await route.fallback();
    });

    let updateTokenItemId: string | null = null;
    await page.route(
      "**/api/plaid/link-token/update",
      async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        updateTokenItemId = body.itemId ?? null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ linkToken: "link-sandbox-mocked-update" }),
        });
      },
    );

    await signInAndOpen(page, email, password, "/settings");

    const linkBtn = page.getByTestId("button-link-bank").first();
    await expect(linkBtn).toBeVisible({ timeout: 15_000 });
    await linkBtn.click();

    // Guard dialog must surface, naming the dead Chase item.
    const dialog = page.getByTestId("dialog-reauth-guard");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId(`row-reauth-guard-${DEAD_CHASE_ITEM_ROW_ID}`),
    ).toBeVisible();
    await expect(dialog).toContainText("Chase");

    // Fresh link-token endpoint must NOT have been called yet — the
    // guard interrupted before reaching it.
    expect(freshLinkTokenCalled).toBe(false);

    // Click the in-dialog Reconnect button — it must trigger update
    // mode threading the dead item's row id, never a fresh link.
    // Scope to the dialog row because the same reconnect button also
    // renders on the Settings Linked Accounts list below.
    const reconnect = dialog
      .getByTestId(`row-reauth-guard-${DEAD_CHASE_ITEM_ROW_ID}`)
      .getByTestId(`button-plaid-reconnect-${DEAD_CHASE_ITEM_ROW_ID}`);
    await expect(reconnect).toBeVisible();
    await reconnect.click();

    await expect
      .poll(() => updateTokenItemId, { timeout: 10_000 })
      .toBe(DEAD_CHASE_ITEM_ROW_ID);
    expect(freshLinkTokenCalled).toBe(false);
  });

  test("reproduces the dead-Chase + orphan-Chase duplicate pair: the dashboard banner surfaces the dead item, and the Connect-a-bank guard still blocks a third duplicate from being minted", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "plaid-link-button-reauth-guard-dupe",
      provisionedUserIds,
    );

    // The production scenario this task fixes: a stale Chase item is
    // in INVALID_ACCESS_TOKEN AND a freshly-linked duplicate already
    // exists for the same institution. Even with the duplicate present
    // the guard must still steer the user toward update-mode on the
    // dead item — and the dashboard banner must surface that dead item
    // by name.
    await page.route("**/api/plaid/items", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: DEAD_CHASE_ITEM_ROW_ID,
            itemId: DEAD_CHASE_ITEM_EXTERNAL_ID,
            institutionId: "ins_chase",
            institutionName: "Chase",
            institutionSlug: "chase",
            lastSyncedAt: null,
            lastSyncError:
              "This bank's saved login is no longer valid — reconnect to bring in new transactions.",
            lastSyncErrorCode: "INVALID_ACCESS_TOKEN",
            stillPreparing: false,
            accounts: [
              {
                id: "chase-acct-row-1",
                accountId: "chase-checking-ext-dead",
                name: "Chase Checking",
                type: "depository",
                subtype: "checking",
              },
            ],
          },
          {
            id: "chase-orphan-row-1",
            itemId: "item-chase-orphan-1",
            institutionId: "ins_chase",
            institutionName: "Chase",
            institutionSlug: "chase",
            lastSyncedAt: new Date().toISOString(),
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparing: false,
            accounts: [
              {
                id: "chase-acct-row-2",
                accountId: "chase-checking-ext-orphan",
                name: "Chase Checking",
                type: "depository",
                subtype: "checking",
              },
            ],
          },
        ]),
      });
    });

    let freshLinkTokenCalled = false;
    await page.route("**/api/plaid/link-token", async (route) => {
      if (route.request().method() === "POST") {
        freshLinkTokenCalled = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ linkToken: "link-sandbox-mocked-fresh-2" }),
        });
        return;
      }
      await route.fallback();
    });

    let updateTokenItemId: string | null = null;
    await page.route(
      "**/api/plaid/link-token/update",
      async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        updateTokenItemId = body.itemId ?? null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ linkToken: "link-sandbox-mocked-update-2" }),
        });
      },
    );

    // Land on the dashboard — the banner is the primary surface for
    // dead items, not a Settings-only detail. It must call out Chase
    // by name and offer an inline Reconnect button targeting the
    // dead item's row id.
    await signInAndOpen(page, email, password, "/dashboard");
    const banner = page.getByTestId("banner-plaid-reauth");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("Chase");

    // Now exercise the Connect-a-bank guard from Settings. Even with
    // a healthy orphan-duplicate Chase item already in the list, the
    // guard must still block a third fresh link and steer the user
    // back to update-mode on the original dead item.
    await page.goto("/settings");
    const linkBtn = page.getByTestId("button-link-bank").first();
    await expect(linkBtn).toBeVisible({ timeout: 15_000 });
    await linkBtn.click();

    const dialog = page.getByTestId("dialog-reauth-guard");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId(`row-reauth-guard-${DEAD_CHASE_ITEM_ROW_ID}`),
    ).toBeVisible();
    expect(freshLinkTokenCalled).toBe(false);

    // "Link a different bank anyway" escape hatch must be present and
    // explicit. We don't click it here — the point of this assertion
    // is that the destructive path stays a deliberate, named choice.
    await expect(
      page.getByTestId("button-reauth-guard-proceed"),
    ).toBeVisible();

    // Reconnect via the in-dialog button → must call update mode with
    // the DEAD item's row id, never the orphan's.
    const reconnect = dialog
      .getByTestId(`row-reauth-guard-${DEAD_CHASE_ITEM_ROW_ID}`)
      .getByTestId(`button-plaid-reconnect-${DEAD_CHASE_ITEM_ROW_ID}`);
    await reconnect.click();
    await expect
      .poll(() => updateTokenItemId, { timeout: 10_000 })
      .toBe(DEAD_CHASE_ITEM_ROW_ID);
    expect(freshLinkTokenCalled).toBe(false);
  });
});
