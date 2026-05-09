import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (#446) Toast-driven Reconnect — 409 → fresh-link fallback via the
 * App-mounted PlaidReconnectListener.
 *
 * The Settings spec (settings-reconnect-relink-fallback.spec.ts) covers
 * the per-item PlaidReconnectButton on /settings. The same 409 →
 * /plaid/link-token → /plaid/exchange fallback also lives in
 * PlaidReconnectListener, which fires whenever any caller dispatches a
 * `plaid:reconnect` CustomEvent — most importantly the Reconnect
 * ToastAction inside the sync-error toast (use-plaid-sync.tsx). That
 * listener path was only covered by a vitest unit test; this spec
 * proves the listener mounted in App.tsx wires up the same fallback
 * end-to-end from a non-Settings page (/amex), so a regression that
 * unmounts the listener or breaks the global event bridge fails CI.
 *
 * Flow:
 *   1. Land on /amex with a single mocked failing Plaid item.
 *   2. Click the header SyncButton → mocked /api/plaid/sync responds
 *      ITEM_LOGIN_REQUIRED, surfacing the sync-error toast + Reconnect
 *      ToastAction (covered by plaid-sync-error-toast.spec.ts).
 *   3. Click the toast Reconnect button. The listener POSTs
 *      /api/plaid/link-token/update which returns 409 + action:"relink"
 *      — the listener must fall through to POST /api/plaid/link-token
 *      and open Plaid Link with the fresh token, instead of toasting
 *      "Could not start reconnect".
 *   4. Drive the captured onSuccess; /api/plaid/exchange must run, the
 *      "Bank reconnected" toast must surface, and no error toast may
 *      appear.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const ITEM_ROW_ID = "toast-relink-item-row-1";
const ITEM_EXTERNAL_ID = "item-toast-relink-1";

test.describe("Toast Reconnect — 409 → fresh-link fallback (#446)", () => {
  test("listener falls through to /plaid/link-token + /plaid/exchange when toast Reconnect is clicked from /amex", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "toast-reconnect-relink-fallback",
      provisionedUserIds,
    );

    // Stub the Plaid Link CDN script so it can't overwrite our
    // window.Plaid stub. react-plaid-link's useScript hook always
    // injects the <script> tag.
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

    // Stub window.Plaid before any app code runs and capture the
    // latest create() config so we can drive onSuccess by hand —
    // there's no real iframe in CI.
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

    // /api/plaid/items: serve a single failing item so SyncButton
    // renders. Flip to a healthy response after /plaid/exchange so
    // any post-success refetch sees the chip clear.
    let exchangeSucceeded = false;
    await page.route("**/api/plaid/items", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const failing = {
        id: ITEM_ROW_ID,
        itemId: ITEM_EXTERNAL_ID,
        institutionId: "ins_toast_relink",
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

    // First /api/plaid/sync (from the header SyncButton click) returns
    // a structured ITEM_LOGIN_REQUIRED failure → sync-error toast.
    // Subsequent calls (the silent post-reconnect re-sync the listener
    // fires) return clean.
    let syncCalls = 0;
    await page.route("**/api/plaid/sync", async (route) => {
      syncCalls += 1;
      if (syncCalls === 1) {
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
                error: "the login details of this item have changed",
                plaidErrorCode: "ITEM_LOGIN_REQUIRED",
                plaidErrorMessage:
                  "the login details of this item have changed",
                plaidDisplayMessage:
                  "Please reconnect your account to continue syncing.",
                requestId: "req-e2e-toast-relink",
                httpStatus: 400,
                kind: "reauth",
              },
            ],
          }),
        });
        return;
      }
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

    // /api/plaid/link-token/update: 409 + action:"relink" forces the
    // listener's fresh-link fallback (the regression #367 added).
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
      // Defensive: don't catch /api/plaid/link-token/update on
      // matchers that overshare.
      if (route.request().url().endsWith("/link-token/update")) {
        return route.fallback();
      }
      freshLinkTokenCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ linkToken: "link-sandbox-toast-446" }),
      });
    });

    // /api/plaid/exchange: success flips items to healthy.
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
          institutionId: "ins_toast_relink",
          institutionName: "Chase",
        }),
      });
    });

    // Land on /amex — a non-Settings page that renders SyncButton
    // unfiltered, exercising the App.tsx-mounted listener rather than
    // the per-item PlaidReconnectButton.
    await signInAndOpen(page, email, password, "/amex");

    const syncBtn = page.getByTestId("button-sync-plaid");
    await expect(syncBtn).toBeVisible({ timeout: 15_000 });
    await syncBtn.click();

    // Sync-error toast surfaces with its Reconnect ToastAction (the
    // dispatch site for the plaid:reconnect event).
    const reconnect = page.getByTestId("button-toast-plaid-reconnect");
    await expect(reconnect).toBeVisible({ timeout: 10_000 });
    await reconnect.click();

    // The listener hits update mode first, then falls through to the
    // fresh-link mint instead of toasting "Could not start reconnect".
    await expect
      .poll(() => updateLinkTokenCalls, { timeout: 10_000 })
      .toBe(1);
    await expect
      .poll(() => freshLinkTokenCalls, { timeout: 10_000 })
      .toBe(1);
    await expect(page.getByText(/Could not start reconnect/i)).toHaveCount(0);

    // usePlaidLink must have created a handler and called open() on
    // it with the fresh token — wait for the stub to record at least
    // one open() before driving onSuccess.
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
      cfg?.onSuccess?.("public-sandbox-toast-446", {
        institution: { institution_id: "ins_toast_relink", name: "Chase" },
      });
    });

    // Exchange called with the fresh public_token — server-side
    // self-heal in /plaid/exchange clears lastSyncError on the row.
    await expect
      .poll(() => exchangeBody?.publicToken, { timeout: 10_000 })
      .toBe("public-sandbox-toast-446");

    // The listener's success path surfaces "Bank reconnected", not
    // any of the destructive error toasts.
    await expect(
      page.getByText(/Bank reconnected/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Reconnect failed/i)).toHaveCount(0);
    await expect(page.getByText(/Could not start reconnect/i)).toHaveCount(0);

    // Page must not have navigated away from /amex — the whole point
    // of the listener is inline reconnect on the current route.
    await expect(page).toHaveURL(/\/amex(\?|$|#|\/)/);
  });
});
