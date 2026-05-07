import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the Amex page when a single Plaid login owns
 * three physical cards (task #430, follow-up to #416 which landed the
 * server-side `dedupePlaidAccountsForUser` collapse + multi-card debt
 * aggregation in the page's `amexDebt` memo).
 *
 * What we want to lock in on /amex when the user has one Amex Plaid
 * item with three `plaid_accounts` rows (one per card) and three Amex
 * debts each linked to its own card row:
 *   1. The register shows every Amex-source transaction in ONE list —
 *      no per-card splitting / scoping.
 *   2. The Ending Balance tile equals the SUM of the three debt
 *      balances. This exercises the linked-account aggregation branch
 *      in the page's `amexDebt` memo:
 *          if (amexPlaidAccountIds.size > 0) matches = debts.filter(
 *            d => d.plaidAccountId && amexPlaidAccountIds.has(d.plaidAccountId)
 *          )
 *          ...
 *          totalBalance = matches.reduce((acc, d) => acc + parseSigned(d.balance), 0)
 *      i.e. the post-#416 dedupe shape: three real cards, three debts,
 *      one combined liability tile.
 *   3. There is no per-card picker / scope chip rendered. The page's
 *      header surfaces a single "American Express" identity, not one
 *      tab/chip per card.
 *
 * Seeding strategy: `POST /api/transactions` doesn't accept
 * `plaidAccountId`, and there is no public seed endpoint for
 * `plaid_accounts` rows, so we mock the four API surfaces the page
 * reads on first paint:
 *   - GET /api/plaid/items     — one Amex item with three accounts
 *   - GET /api/debts           — three debts, one per card, linked via
 *                                `plaidAccountId` to each account row id
 *   - GET /api/transactions    — three `plaid:amex` rows, one per card,
 *                                each carrying the matching plaidAccountId
 *   - GET /api/amex/anchor     — missing (so the debt-derived branch
 *                                wins; otherwise the saved-anchor branch
 *                                would short-circuit aggregation)
 * This is the same mock-the-payload pattern used by
 * `amex-page-reconnect.spec.ts` (#373) and gives us a deterministic,
 * Plaid-realistic shape without depending on a real Plaid sandbox item.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const AMEX_ITEM_ROW_ID = "amex-item-row-3card";
const AMEX_ITEM_EXTERNAL_ID = "item-amex-3card";

// Three plaid_accounts row ids — one per physical card. These are the
// ids the page's `amexPlaidAccountIds` set is populated from (via the
// transactions' `plaidAccountId` field) AND that the debts'
// `plaidAccountId` field points at, so the linked-account aggregation
// branch lights up.
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

test.describe("Amex page — three linked cards under one Plaid item (#430)", () => {
  test("aggregates three linked Amex debts into one Ending Balance and shows every card's txns in one register with no per-card picker", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-three-cards",
      provisionedUserIds,
    );

    const today = todayIso();
    // Pin lastBalanceUpdate to today's date for every debt so the
    // page's `anchorMonth` equals the current selected month and the
    // ending-balance helper returns the anchor sum verbatim (no
    // roll-forward / roll-backward via `netChangeByMonth`). The
    // `T23:00:00.000Z` time keeps every same-day txn earlier than the
    // anchor, so `computeBalanceAtEndOf` adds zero post-anchor txns.
    const debtUpdatedIso = `${today}T23:00:00.000Z`;

    // --- /api/plaid/items: one Amex item, three card accounts. ---
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

    // --- /api/debts: three debts, one per card, each linked via
    //     `plaidAccountId` to its card's plaid_accounts row id. This is
    //     the post-#416 shape that the page must aggregate. ---
    await page.route("**/api/debts", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          DEBT_ROW_IDS.map((id, i) => ({
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
          })),
        ),
      });
    });

    // --- /api/transactions: three plaid:amex rows, one per card,
    //     each carrying the matching `plaidAccountId` so the page's
    //     `amexPlaidAccountIds` set picks all three up. The Amex page
    //     issues this GET with various from/to/source combinations as
    //     the user navigates months — the same mocked payload satisfies
    //     every variant for this test. ---
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
            description: `AMEX 3-CARD TEST — CARD ${CARD_MASKS[i]} PURCHASE`,
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

    // --- /api/amex/anchor: missing, so the debt-derived branch in
    //     `resolvedAnchor` wins. (A populated saved-anchor would
    //     short-circuit the multi-debt aggregation we're testing.) ---
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

    // --- (2) Ending Balance tile equals SUM of the three linked debts. ---
    const expectedTotal = DEBT_BALANCES.reduce((s, n) => s + n, 0); // 2500
    const tile = page.getByTestId("stat-ending-balance");
    await expect(tile).toContainText(fmtCurrency(expectedTotal), {
      timeout: 15_000,
    });
    // "From debt row" footer label confirms the value came out of the
    // debt-derived aggregation branch (NOT the saved-anchor or the
    // computed fallback branches) — i.e. the linked-account path.
    await expect(tile).toContainText("From debt row");

    // --- (1) Register shows transactions from all three cards in ONE list. ---
    // The page renders both desktop and mobile layouts simultaneously
    // (Tailwind `md:hidden` / `hidden md:block`); each row's testid is
    // `row-amex-mobile-${id}` for the mobile copy and the desktop copy
    // appears in the same DayGroup. We assert both per-id mobile
    // rows are attached AND each description is visible at least once
    // in the rendered DOM, which together prove every card's txn made
    // it into the unified register.
    for (let i = 0; i < TXN_ROW_IDS.length; i += 1) {
      await expect(
        page.getByTestId(`row-amex-mobile-${TXN_ROW_IDS[i]}`),
      ).toBeAttached({ timeout: 15_000 });
      // Description nodes are rendered in both the desktop and mobile
      // layouts but each is hidden by Tailwind responsive utilities at
      // any given viewport (`hidden md:block` / `md:hidden`); assert
      // attached rather than visible so the test is viewport-agnostic.
      await expect(
        page
          .getByText(`AMEX 3-CARD TEST — CARD ${CARD_MASKS[i]} PURCHASE`)
          .first(),
      ).toBeAttached();
    }

    // The "{filtered} of {monthScoped} txns" counter must reflect all
    // three rows from the mocked payload — no per-card scoping is
    // dropping any of them.
    await expect(page.getByTestId("text-row-count")).toHaveText(
      /3 of 3 txns/,
      { timeout: 15_000 },
    );

    // --- (3) No per-card picker / scope chip; single "American Express"
    //     identity in the header. ---
    await expect(
      page.getByRole("heading", { name: "American Express" }),
    ).toHaveCount(1);

    // Defensive: no element with a per-card scope-chip / card-picker
    // testid exists on the page. If a future refactor introduces one
    // (e.g. a per-mask filter chip when multiple cards are linked),
    // this assertion will trip and force the test author to revisit
    // the "one register" guarantee above.
    await expect(
      page.locator(
        '[data-testid^="chip-amex-card-"], [data-testid^="button-card-"], [data-testid="select-amex-card"]',
      ),
    ).toHaveCount(0);
  });
});
