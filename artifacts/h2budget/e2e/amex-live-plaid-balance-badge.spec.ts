import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (#515) End-to-end coverage for the live-from-Plaid Amex tile badge
 * added by Task #498.
 *
 * When the Amex Ending balance tile falls back to the Plaid per-account
 * balance (no linked Amex debt, GET /api/amex/anchor returns
 * `source: "plaid"`), the tile must:
 *   1. Render the populated StatChip with the Plaid balance.
 *   2. Show a "Live from Plaid · Updated …" footer in
 *      `data-testid="stat-ending-balance-footer"`.
 *   3. Render a clickable
 *      `data-testid="button-refresh-plaid-balance"` Refresh affordance.
 *   4. While the resulting POST /api/plaid/sync is in flight, keep the
 *      cached balance visible — never re-introduce the stuck "Loading…"
 *      state Task #483 fixed.
 *
 * The spec mocks the network so it doesn't depend on a real Plaid
 * sandbox item: a single Amex-source transaction wires up the page's
 * Plaid-item scoping (so the Refresh button is enabled), debts is
 * empty (so amexDebt is null and the anchor query branch wins), and
 * /api/amex/anchor returns a populated `source: "plaid"` payload.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const AMEX_ITEM_ROW_ID = "amex-live-item-row-1";
const AMEX_ITEM_EXTERNAL_ID = "item-amex-live-1";
const AMEX_ACCOUNT_ROW_ID = "amex-live-acct-row-1";
const AMEX_ACCOUNT_EXTERNAL_ID = "amex-live-card-ext-acct-1";

test.describe("Amex page — live-from-Plaid balance badge (#515)", () => {
  test("renders 'Live from Plaid · Updated …' footer + Refresh button, and keeps the cached value visible during sync", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-live-plaid-badge",
      provisionedUserIds,
    );

    const today = new Date().toISOString().slice(0, 10);
    // Pick an "asOf" a few minutes in the past so formatRelativeTime
    // produces a deterministic "minutes ago" string in the footer.
    const asOfIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // --- /api/plaid/items: a single Amex-owning Plaid item. The
    // page's `relevantPlaidItemIds` resolver maps the txn's
    // `plaidAccountId` (external) to this item's `accounts[].accountId`,
    // which is what enables the per-item Refresh affordance.
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
            lastSyncedAt: asOfIso,
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparing: false,
            accounts: [
              {
                id: AMEX_ACCOUNT_ROW_ID,
                accountId: AMEX_ACCOUNT_EXTERNAL_ID,
                name: "Amex Gold",
                mask: "1002",
                type: "credit",
                subtype: "credit card",
              },
            ],
          },
        ]),
      });
    });

    // --- /api/debts: empty so `amexDebt` is null and the anchor query
    // branch in `resolvedAnchor` wins.
    await page.route("**/api/debts", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    // --- /api/transactions: one Amex-source transaction so
    // `amexPlaidAccountIds` picks up the external account_id and the
    // page's Plaid scope resolves to AMEX_ITEM_ROW_ID.
    await page.route("**/api/transactions**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "amex-live-txn-1",
            occurredOn: today,
            occurredAt: `${today}T12:00:00.000Z`,
            description: "AMEX LIVE BADGE TEST PURCHASE",
            amount: "42.00",
            account: "Amex Gold ··1002",
            categoryId: null,
            forecastFlag: false,
            weeklyAllowance: false,
            weeklyBucket: null,
            monthlyAllowance: false,
            unplannedAllowance: false,
            reimbursable: false,
            reimbursed: false,
            isTransfer: false,
            notes: null,
            source: "plaid:amex",
            member: null,
            owedBy: null,
            plaidTransactionId: "amex-live-txn-1-ext",
            plaidAccountId: AMEX_ACCOUNT_EXTERNAL_ID,
            debtId: null,
            matchedRuleId: null,
          },
        ]),
      });
    });

    // --- /api/amex/anchor: live Plaid per-account balance fallback.
    let anchorCalls = 0;
    await page.route("**/api/amex/anchor", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      anchorCalls++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          amexEndingBalance: 1234.56,
          asOf: asOfIso,
          source: "plaid",
        }),
      });
    });

    // --- /api/plaid/sync: hold the response open so the Refresh button
    // sits in its "Refreshing…" state long enough for us to assert the
    // cached value never flips to "Loading…". We release it explicitly
    // after the assertions run.
    let releaseSync: (() => void) | null = null;
    const syncReleased = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let syncCalls = 0;
    await page.route("**/api/plaid/sync", async (route) => {
      syncCalls++;
      await syncReleased;
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
              error: null,
              plaidErrorCode: null,
              plaidErrorMessage: null,
              plaidDisplayMessage: null,
              requestId: "req-e2e-amex-live",
              httpStatus: 200,
              kind: null,
            },
          ],
        }),
      });
    });

    await signInAndOpen(page, email, password, "/amex");

    // --- (1) Tile renders the populated Plaid balance.
    const tile = page.getByTestId("stat-ending-balance");
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await expect(tile).toContainText("$1,234.56", { timeout: 15_000 });
    await expect(tile).not.toContainText("Loading…");
    await expect(tile).not.toContainText("Not set");

    // --- (2) Footer carries the Live-from-Plaid badge text in the
    // exact testid the task spec calls out.
    const footer = page.getByTestId("stat-ending-balance-footer");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("Live from Plaid");
    await expect(footer).toContainText(/Updated\s+\d+\s+minutes?\s+ago/);

    // --- (3) Refresh affordance is visible, enabled, and clickable.
    const refreshBtn = page.getByTestId("button-refresh-plaid-balance");
    await expect(refreshBtn).toBeVisible();
    await expect(refreshBtn).toBeEnabled();
    await refreshBtn.click();

    // The mocked /api/plaid/sync route is paused — confirm the click
    // actually reached it before asserting the in-flight UI state.
    await expect.poll(() => syncCalls).toBeGreaterThanOrEqual(1);

    // --- (4) During the in-flight sync the tile keeps the cached
    // value visible — the regression Task #483 fixed (and #498 must
    // not re-introduce) was the chip flipping back to "Loading…"
    // while the refresh ran.
    await expect(refreshBtn).toContainText(/Refreshing…/);
    await expect(tile).toContainText("$1,234.56");
    await expect(tile).not.toContainText("Loading…");
    // The footer text also must not disappear / be replaced by the
    // skeleton placeholder during the in-flight refresh.
    await expect(footer).toContainText("Live from Plaid");

    // Release the held sync response and let the success-path
    // invalidation re-query /api/amex/anchor.
    const initialAnchorCalls = anchorCalls;
    releaseSync?.();

    await expect(refreshBtn).toContainText(/^Refresh$/, { timeout: 10_000 });
    await expect.poll(() => anchorCalls).toBeGreaterThan(initialAnchorCalls);
    // Final state: the tile is still on the cached value and the badge
    // is still the live-from-Plaid one (the mocked anchor response is
    // unchanged), confirming the refresh round-trip didn't blank the
    // chip on the way through.
    await expect(tile).toContainText("$1,234.56");
    await expect(footer).toContainText("Live from Plaid");
  });
});
