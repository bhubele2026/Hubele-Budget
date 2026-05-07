import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the brief mid-re-link window on the Amex
 * page (task #442, follow-up to #430 which locked the *steady-state*
 * three-card aggregation).
 *
 * Scenario: the user already has three Amex cards under one Plaid item
 * (three `plaid_accounts` rows, three debts, one debt linked to each
 * card row). They re-link the same Amex login. For a brief window
 * before `dedupePlaidAccountsForUser` collapses the new rows onto the
 * existing survivors, the server can return *four* `plaid_accounts`
 * rows for that login: the three original survivors plus one duplicate
 * row for one card (same institution + mask, different `id`). If a
 * debt happens to land linked to the duplicate row, `/api/debts`
 * temporarily returns four debts: three real + one duplicate-mask.
 *
 * Regression class we lock in: the page's `amexDebt` aggregation must
 * NOT double-count the duplicate. The existing `amexDebt` memo
 * filters debts by membership in `amexPlaidAccountIds`, which is
 * built from the *transactions* feeding the page — so a duplicate
 * `plaid_accounts` row with no transactions yet (the typical mid-
 * re-link shape) has its id absent from the set and its debt is
 * skipped. The Ending Balance tile therefore shows the sum of the
 * three real debts, NOT the four-debt total. Once dedupe lands and
 * `/api/debts` returns three again, the tile is unchanged.
 *
 * Seeding strategy: same mock-the-payload approach as
 * `amex-three-cards-aggregation.spec.ts`. We mutate the mocked
 * `/api/debts` response between the duplicate phase and the post-
 * dedupe phase via a flip flag.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const AMEX_ITEM_ROW_ID = "amex-item-row-relink";
const AMEX_ITEM_EXTERNAL_ID = "item-amex-relink";

const CARD_ROW_IDS = [
  "amex-acct-row-card-1001",
  "amex-acct-row-card-2002",
  "amex-acct-row-card-3003",
] as const;

const CARD_MASKS = ["1001", "2002", "3003"] as const;

const DEBT_ROW_IDS = [
  "debt-amex-card-1001",
  "debt-amex-card-2002",
  "debt-amex-card-3003",
] as const;

const DEBT_BALANCES = [500, 750, 1250] as const; // sum: 2500

// The duplicate's plaid_accounts row id — a *different* uuid for the
// *same physical card* (mask 1001). This is the shape the brief
// mid-re-link window produces before `dedupePlaidAccountsForUser`
// collapses (institutionName, mask) groups onto a single survivor.
const DUP_CARD_ROW_ID = "amex-acct-row-card-1001-DUP";
const DUP_DEBT_ROW_ID = "debt-amex-card-1001-DUP";
const DUP_DEBT_BALANCE = 500; // would inflate the tile to 3000 if counted

const TXN_ROW_IDS = [
  "txn-amex-card-1001",
  "txn-amex-card-2002",
  "txn-amex-card-3003",
] as const;

const TXN_AMOUNTS = ["10.00", "20.00", "30.00"] as const;

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

test.describe("Amex page — re-link duplicate window doesn't double Ending Balance (#442)", () => {
  test("with a duplicate Amex debt landing during re-link, the Ending Balance tile equals the sum of the three real debts (not four), and remains unchanged once dedupe collapses to three", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-relink-dup",
      provisionedUserIds,
    );

    const today = todayIso();
    const debtUpdatedIso = `${today}T23:00:00.000Z`;

    // Phase flag: when true, `/api/debts` returns four debts (three
    // real + one duplicate-mask). When false, three debts (post-
    // dedupe steady state).
    let duplicatePhase = true;
    // Track every served `/api/debts` GET so Phase 2 can prove a
    // second fetch actually happened (otherwise an "unchanged tile"
    // assertion could pass vacuously if React Query never refetched).
    let debtsRequestCount = 0;

    // --- /api/plaid/items: one Amex item, three card accounts.
    //     We deliberately do NOT include the duplicate plaid_accounts
    //     row in this payload — the dedupe window's distinguishing
    //     feature is that a stray `debts.plaidAccountId` points at a
    //     row id that the page's transactions never reference, which
    //     is exactly what `amexPlaidAccountIds` is meant to guard
    //     against.
    await page.route("**/api/plaid/items", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
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
            lastSyncedAt: debtUpdatedIso,
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparing: false,
            accounts: CARD_ROW_IDS.map((id, i) => ({
              id,
              accountId: `${AMEX_ITEM_EXTERNAL_ID}-acct-${CARD_MASKS[i]}`,
              name: `Amex ··${CARD_MASKS[i]}`,
              mask: CARD_MASKS[i],
              type: "credit",
              subtype: "credit card",
            })),
          },
        ]),
      });
    });

    // --- /api/debts: three real + one duplicate-mask while
    //     `duplicatePhase` is true; three real once it flips. The
    //     duplicate debt has the same name/mask as card 1001 but its
    //     `plaidAccountId` points at a brand-new `plaid_accounts.id`
    //     (DUP_CARD_ROW_ID) — exactly the mid-re-link shape.
    await page.route("**/api/debts", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      debtsRequestCount += 1;
      const realDebts = DEBT_ROW_IDS.map((id, i) => ({
        id,
        name: `Amex ··${CARD_MASKS[i]}`,
        balance: DEBT_BALANCES[i].toFixed(2),
        apr: "0.1999",
        minPayment: "25.00",
        dueDay: 15,
        status: "active",
        sortOrder: i + 1,
        originalBalance: DEBT_BALANCES[i].toFixed(2),
        balanceSource: "plaid",
        minPaymentSource: "plaid",
        plaidAccountId: CARD_ROW_IDS[i],
        plaidLastSyncedAt: debtUpdatedIso,
        lastBalanceUpdate: debtUpdatedIso,
        plaidLastSyncError: null,
        plaidLastSyncErrorCode: null,
        consentExpirationAt: null,
        consentExpirationLastRefreshError: null,
        pendingPayment: null,
      }));
      const duplicateDebt = {
        id: DUP_DEBT_ROW_ID,
        name: `Amex ··${CARD_MASKS[0]}`,
        balance: DUP_DEBT_BALANCE.toFixed(2),
        apr: "0.1999",
        minPayment: "25.00",
        dueDay: 15,
        status: "active",
        sortOrder: 99,
        originalBalance: DUP_DEBT_BALANCE.toFixed(2),
        balanceSource: "plaid",
        minPaymentSource: "plaid",
        plaidAccountId: DUP_CARD_ROW_ID,
        plaidLastSyncedAt: debtUpdatedIso,
        lastBalanceUpdate: debtUpdatedIso,
        plaidLastSyncError: null,
        plaidLastSyncErrorCode: null,
        consentExpirationAt: null,
        consentExpirationLastRefreshError: null,
        pendingPayment: null,
      };
      const body = duplicatePhase
        ? [...realDebts, duplicateDebt]
        : realDebts;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    // --- /api/transactions: three plaid:amex rows, one per card,
    //     each carrying its real card's `plaidAccountId`. Critically,
    //     no transaction references DUP_CARD_ROW_ID — that's what
    //     keeps it out of `amexPlaidAccountIds` and is the exact
    //     shape the page's filter is designed to ignore.
    await page.route("**/api/transactions**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          TXN_ROW_IDS.map((id, i) => ({
            id,
            occurredOn: today,
            occurredAt: `${today}T${String(9 + i).padStart(2, "0")}:00:00.000Z`,
            description: `AMEX RELINK TEST — CARD ${CARD_MASKS[i]} PURCHASE`,
            amount: TXN_AMOUNTS[i],
            account: `Amex ··${CARD_MASKS[i]}`,
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
            plaidTransactionId: `${id}-ext`,
            plaidAccountId: CARD_ROW_IDS[i],
            debtId: null,
            matchedRuleId: null,
          })),
        ),
      });
    });

    // --- /api/amex/anchor: missing → debt-derived branch wins.
    await page.route("**/api/amex/anchor", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          amexEndingBalance: null,
          asOf: new Date(0).toISOString(),
          source: "missing",
        }),
      });
    });

    await signInAndOpen(page, email, password, "/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    const expectedTotal = DEBT_BALANCES.reduce((s, n) => s + n, 0); // 2500
    const inflatedTotal = expectedTotal + DUP_DEBT_BALANCE; // 3000
    const tile = page.getByTestId("stat-ending-balance");

    // --- Phase 1: duplicate window. Tile must equal the sum of the
    //     three REAL debts (2500), not the inflated four-debt total
    //     (3000). The "From debt row" footer confirms we're on the
    //     debt-derived aggregation branch (the regression target).
    await expect(tile).toContainText(fmtCurrency(expectedTotal), {
      timeout: 15_000,
    });
    await expect(tile).toContainText("From debt row");
    await expect(tile).not.toContainText(fmtCurrency(inflatedTotal));

    // --- Phase 2: dedupe lands. Flip the mock so `/api/debts` now
    //     returns the three real debts only, then force the page to
    //     refetch by reloading. A reload is the most deterministic
    //     way to guarantee a fresh `/api/debts` GET against the
    //     mocked route — React Query's `invalidateQueries` requires
    //     access to the QueryClient and `dispatchEvent('focus')`
    //     only refetches when `refetchOnWindowFocus` is enabled.
    duplicatePhase = false;
    const requestsBeforeReload = debtsRequestCount;
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });
    // Prove a second `/api/debts` fetch actually happened against
    // the now-three-debts mock so the "unchanged tile" assertion
    // below isn't vacuous.
    await expect
      .poll(() => debtsRequestCount, { timeout: 15_000 })
      .toBeGreaterThan(requestsBeforeReload);

    // Tile is unchanged — the duplicate never contributed in the
    // first place, so removing it leaves the value at 2500 and the
    // "From debt row" branch label intact.
    await expect(tile).toContainText(fmtCurrency(expectedTotal), {
      timeout: 15_000,
    });
    await expect(tile).toContainText("From debt row");
    await expect(tile).not.toContainText(fmtCurrency(inflatedTotal));
  });
});
