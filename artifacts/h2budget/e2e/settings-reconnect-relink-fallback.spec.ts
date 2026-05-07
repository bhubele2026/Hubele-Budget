import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (#374) Settings page Reconnect button — 409 → fresh-link fallback.
 *
 * The new vitest coverage from #370 (plaidReconnectButtonRelinkFallback.test.tsx)
 * proves the React component logic, but it stubs `react-plaid-link` and the
 * three Plaid token endpoints. This spec instead drives the real Settings
 * route in a real browser:
 *
 *   1. Mount the Settings page with a single mocked /api/plaid/items entry
 *      whose lastSyncErrorCode === ITEM_LOGIN_REQUIRED so the per-item
 *      "Needs reconnect" badge + PlaidReconnectButton render.
 *   2. Click the Reconnect button. The first POST to
 *      /api/plaid/link-token/update returns 409 + body.action === "relink"
 *      — the server's "this item's stored access_token can't be repaired
 *      via update mode, mint a brand-new one" signal.
 *   3. Assert the component falls through to POST /api/plaid/link-token
 *      (the fresh-link mint) instead of toasting "Could not start
 *      reconnect" — the regression #367 introduced the fallback for, and
 *      the loop the user previously got stuck in.
 *   4. Stub `window.Plaid.create` so its `open()` captures the latest
 *      config; the test then drives `onSuccess` directly with a fake
 *      public_token. That triggers POST /api/plaid/exchange (the
 *      server-side self-heal that clears lastSyncError on the row), then
 *      a silent /api/plaid/sync, then a refetch of /api/plaid/items —
 *      which we flip to a healthy response. The "Needs reconnect" badge
 *      must disappear and no error toast must surface anywhere along
 *      the way.
 *
 * This catches regressions a unit test can't: route mounting under
 * /settings, Toaster placement in App.tsx, the listener wiring of
 * usePlaidLink against a real (stubbed) window.Plaid handler, and the
 * post-success query invalidation that actually clears the chip.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const ITEM_ROW_ID = "settings-relink-item-row-1";
const ITEM_EXTERNAL_ID = "item-settings-relink-1";

test.describe("Settings Reconnect — 409 → fresh-link fallback (#374)", () => {
  test("falls through to /plaid/link-token + /plaid/exchange and clears the chip with no error toast", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "settings-reconnect-relink-fallback",
      provisionedUserIds,
    );

    // Intercept the real Plaid Link CDN script and serve a no-op so the
    // real script can't overwrite our window.Plaid stub. react-plaid-link
    // unconditionally injects the cdn.plaid.com <script> tag via its
    // useScript hook even when window.Plaid is already defined.
    await page.route(
      "**/cdn.plaid.com/link/v2/stable/link-initialize.js",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: "/* stubbed by e2e */",
        });
      },
    );

    // Stub window.Plaid before any app code runs. Capture each
    // `create({...})` config and expose the most recent one so the
    // test can trigger onSuccess by hand — there's no real iframe in
    // CI.
    await page.addInitScript(() => {
      const w = window as unknown as {
        Plaid?: unknown;
        __plaidConfigs?: unknown[];
        __plaidLastConfig?: unknown;
        __plaidOpenCount?: number;
      };
      w.__plaidConfigs = [];
      w.__plaidOpenCount = 0;
      w.Plaid = {
        create: (config: unknown) => {
          w.__plaidConfigs!.push(config);
          return {
            open: () => {
              w.__plaidLastConfig = config;
              w.__plaidOpenCount = (w.__plaidOpenCount ?? 0) + 1;
            },
            exit: (_opts: unknown, cb?: () => void) => {
              if (typeof cb === "function") cb();
            },
            destroy: () => {},
            submit: () => {},
          };
        },
      };
    });

    // /api/plaid/items: serve a single failing item until /plaid/exchange
    // succeeds, then flip to a healthy response so the post-success
    // refetch clears the "Needs reconnect" badge.
    let exchangeSucceeded = false;
    await page.route("**/api/plaid/items", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const failing = {
        id: ITEM_ROW_ID,
        itemId: ITEM_EXTERNAL_ID,
        institutionId: "ins_settings_relink",
        institutionName: "Chase",
        institutionSlug: "chase",
        lastSyncedAt: null,
        lastSyncError: "the login details of this item have changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        stillPreparing: false,
        accounts: [],
      };
      const healthy = {
        ...failing,
        lastSyncError: null,
        lastSyncErrorCode: null,
        lastSyncedAt: new Date().toISOString(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([exchangeSucceeded ? healthy : failing]),
      });
    });

    // /api/plaid/link-token/update: the 409 + action:"relink" signal
    // that the component must transparently fall through (not toast).
    let updateLinkTokenCalls = 0;
    await page.route("**/api/plaid/link-token/update", async (route) => {
      updateLinkTokenCalls += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          action: "relink",
          message:
            "This item's stored access_token can't be repaired via update mode.",
        }),
      });
    });

    // /api/plaid/link-token: the fresh-link mint the fallback uses.
    let freshLinkTokenCalls = 0;
    await page.route("**/api/plaid/link-token", async (route) => {
      // Guard: don't catch /api/plaid/link-token/update — Playwright
      // routes by glob, and `**/api/plaid/link-token` would otherwise
      // also match the /update path on some matchers. Defensive.
      if (route.request().url().endsWith("/link-token/update")) {
        return route.fallback();
      }
      freshLinkTokenCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ linkToken: "link-sandbox-fresh-374" }),
      });
    });

    // /api/plaid/exchange: success flips the items mock to healthy.
    let exchangeBody: { publicToken?: string; institutionName?: string } | null =
      null;
    await page.route("**/api/plaid/exchange", async (route) => {
      exchangeBody = JSON.parse(route.request().postData() ?? "{}");
      exchangeSucceeded = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          itemId: ITEM_EXTERNAL_ID,
          institutionId: "ins_settings_relink",
          institutionName: "Chase",
        }),
      });
    });

    // /api/plaid/sync: the silent post-link sync the onSuccess handler
    // runs to clear the chip. Empty success keeps the test focused on
    // the relink fallback rather than the transactions pipeline.
    await page.route("**/api/plaid/sync", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              itemId: ITEM_EXTERNAL_ID,
              plaidItemRowId: ITEM_ROW_ID,
              institutionName: "Chase",
              added: 0,
              modified: 0,
              removed: 0,
              autoCategorized: 0,
              ruleAttributions: [],
              error: null,
              plaidErrorCode: null,
              plaidErrorMessage: null,
              plaidDisplayMessage: null,
              requestId: null,
              httpStatus: 200,
              kind: "ok",
            },
          ],
        }),
      });
    });

    await signInAndOpen(page, email, password, "/settings");

    // Pre-condition: the failing item rendered with the "Needs reconnect"
    // badge and the per-item Reconnect button.
    const badge = page.getByTestId(`badge-needs-reconnect-${ITEM_ROW_ID}`);
    await expect(badge).toBeVisible({ timeout: 15_000 });
    const reconnectBtn = page.getByTestId(
      `button-plaid-reconnect-${ITEM_ROW_ID}`,
    );
    await expect(reconnectBtn).toBeVisible();

    await reconnectBtn.click();

    // Update-mode token mint hit first (and only once for this click).
    await expect.poll(() => updateLinkTokenCalls).toBe(1);
    // Component fell through to the fresh-link mint instead of toasting
    // — the whole point of the #367 fallback this spec covers.
    await expect
      .poll(() => freshLinkTokenCalls, { timeout: 10_000 })
      .toBe(1);
    await expect(page.getByText(/Could not start reconnect/i)).toHaveCount(0);

    // usePlaidLink must have created a Plaid handler with the fresh
    // token and called open() on it. Wait for our stubbed open() to
    // have run at least once before driving onSuccess.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __plaidOpenCount?: number })
                .__plaidOpenCount ?? 0,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    // Drive the captured onSuccess directly — same shape Plaid Link
    // hands back when the user finishes the popup.
    await page.evaluate(() => {
      const cfg = (
        window as unknown as {
          __plaidLastConfig?: {
            onSuccess?: (
              publicToken: string,
              metadata: {
                institution?: { institution_id?: string; name?: string } | null;
              },
            ) => unknown;
          };
        }
      ).__plaidLastConfig;
      cfg?.onSuccess?.("public-sandbox-374", {
        institution: { institution_id: "ins_settings_relink", name: "Chase" },
      });
    });

    // Exchange must have been called with the fresh public_token —
    // server-side self-heal in /plaid/exchange is what actually clears
    // lastSyncError on the row.
    await expect
      .poll(() => exchangeBody?.publicToken, { timeout: 10_000 })
      .toBe("public-sandbox-374");

    // The post-success "Bank reconnected" toast surfaces, NOT the
    // fallback's destructive "Reconnect failed" / "Could not start
    // reconnect" copy.
    await expect(
      page.getByText(/Bank reconnected/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Reconnect failed/i)).toHaveCount(0);
    await expect(page.getByText(/Could not start reconnect/i)).toHaveCount(0);

    // Chip clears once the post-success refetch picks up the healthy
    // /api/plaid/items payload.
    await expect(badge).toHaveCount(0, { timeout: 15_000 });
  });
});
