import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the harder mid-re-link variant on the Amex
 * page (task #449, follow-up to #442).
 *
 * #442 locks in the typical mid-re-link window: a duplicate
 * `plaid_accounts` row arrives with a debt linked to it but no
 * transactions yet, so the page's `amexPlaidAccountIds` set (built
 * from transactions) doesn't include the duplicate row id and the
 * duplicate debt is correctly skipped.
 *
 * The harder variant tested here: a sync briefly fires before
 * `dedupePlaidAccountsForUser` collapses the new (institution, mask)
 * groups, so transactions land referencing BOTH the real and the
 * duplicate `plaid_accounts` row id. Now `amexPlaidAccountIds`
 * contains both ids, both linked debts pass the membership filter,
 * and the page's `amexDebt` aggregation would otherwise sum all four
 * debts and inflate the Ending Balance tile by ~2x. The fix from
 * #449 collapses matched debts by (institutionName, mask) — derived
 * from the `/api/plaid/items` payload — before summing, so the tile
 * still equals the sum of the three real debts.
 *
 * Seeding strategy: same mock-the-payload approach as
 * `amex-relink-duplicate-no-double-balance.spec.ts`. The shape
 * differs in one critical respect — we add a fourth transaction
 * whose `plaidAccountId` points at the duplicate's row id
 * (DUP_CARD_ROW_ID) so the duplicate id ends up in
 * `amexPlaidAccountIds`.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const AMEX_ITEM_ROW_ID = "amex-item-row-relink-txn";
const AMEX_ITEM_EXTERNAL_ID = "item-amex-relink-txn";

const CARD_ROW_IDS = [
  "amex-acct-row-card-1001-txn",
  "amex-acct-row-card-2002-txn",
  "amex-acct-row-card-3003-txn",
] as const;

const CARD_MASKS = ["1001", "2002", "3003"] as const;

const DEBT_ROW_IDS = [
  "debt-amex-card-1001-txn",
  "debt-amex-card-2002-txn",
  "debt-amex-card-3003-txn",
] as const;

const DEBT_BALANCES = [500, 750, 1250] as const; // sum: 2500

// Duplicate plaid_accounts row id for the SAME physical card as
// CARD_ROW_IDS[0] (mask 1001). Distinguishing feature of this spec:
// a transaction also references this id, so it ends up in
// `amexPlaidAccountIds` alongside the real row id.
const DUP_CARD_ROW_ID = "amex-acct-row-card-1001-DUP-txn";
const DUP_DEBT_ROW_ID = "debt-amex-card-1001-DUP-txn";
const DUP_DEBT_BALANCE = 500; // would inflate the tile to 3000 if counted

const TXN_ROW_IDS = [
  "txn-amex-card-1001-txn",
  "txn-amex-card-2002-txn",
  "txn-amex-card-3003-txn",
] as const;

const DUP_TXN_ROW_ID = "txn-amex-card-1001-DUP-txn";

const TXN_AMOUNTS = ["10.00", "20.00", "30.00"] as const;
const DUP_TXN_AMOUNT = "5.00";

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

test.describe("Amex page — re-link duplicate window with transactions doesn't double Ending Balance (#449)", () => {
  test("when a duplicate Amex plaid_accounts row briefly has both a debt AND a transaction, the Ending Balance tile still equals the sum of the three real debts (collapsed by institution + mask), and remains unchanged once dedupe collapses to three", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-relink-dup-txn",
      provisionedUserIds,
    );

    const today = todayIso();
    const debtUpdatedIso = `${today}T23:00:00.000Z`;
    // The duplicate's debt is the freshly-arrived row, so it carries
    // a *later* lastBalanceUpdate than the real debts. The dedupe
    // logic in `amexDebt` keeps the most recently updated debt per
    // (institution, mask) — picking the duplicate's $500 over the
    // real card 1001's $500. Since both balances are identical in
    // the mid-re-link shape, either pick yields the correct $2,500
    // total; we set them equal so the assertion is unambiguous.
    const dupDebtUpdatedIso = `${today}T23:30:00.000Z`;

    let duplicatePhase = true;
    let debtsRequestCount = 0;

    // --- /api/plaid/items: one Amex item. We expose all FOUR
    //     plaid_accounts rows (three real survivors + one duplicate
    //     for mask 1001) so the page can map debt.plaidAccountId →
    //     (institution, mask) for both the real and duplicate row
    //     ids and collapse them into a single physical-card group.
    await page.route("**/api/plaid/items", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const accounts = duplicatePhase
        ? [
            ...CARD_ROW_IDS.map((id, i) => ({
              id,
              accountId: `${AMEX_ITEM_EXTERNAL_ID}-acct-${CARD_MASKS[i]}`,
              name: `Amex ··${CARD_MASKS[i]}`,
              mask: CARD_MASKS[i],
              type: "credit",
              subtype: "credit card",
            })),
            {
              id: DUP_CARD_ROW_ID,
              accountId: `${AMEX_ITEM_EXTERNAL_ID}-acct-${CARD_MASKS[0]}-dup`,
              name: `Amex ··${CARD_MASKS[0]}`,
              mask: CARD_MASKS[0],
              type: "credit",
              subtype: "credit card",
            },
          ]
        : CARD_ROW_IDS.map((id, i) => ({
            id,
            accountId: `${AMEX_ITEM_EXTERNAL_ID}-acct-${CARD_MASKS[i]}`,
            name: `Amex ··${CARD_MASKS[i]}`,
            mask: CARD_MASKS[i],
            type: "credit",
            subtype: "credit card",
          }));
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
            accounts,
          },
        ]),
      });
    });

    // --- /api/debts: three real + one duplicate-mask while
    //     `duplicatePhase` is true; three real once it flips. The
    //     duplicate debt's `plaidAccountId` points at DUP_CARD_ROW_ID,
    //     and (critically for this spec) a transaction below also
    //     references that id — so without #449's collapse the
    //     duplicate would pass the `amexPlaidAccountIds` filter and
    //     get summed.
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
        plaidLastSyncedAt: dupDebtUpdatedIso,
        lastBalanceUpdate: dupDebtUpdatedIso,
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

    // --- /api/transactions: three plaid:amex rows for the real
    //     cards plus a fourth row whose `plaidAccountId` points at
    //     DUP_CARD_ROW_ID — exactly the shape that pulls the
    //     duplicate id into `amexPlaidAccountIds` and breaks #442's
    //     transaction-only defense. Once dedupe lands, the duplicate
    //     transaction is repointed onto the real row id, so phase 2
    //     drops it.
    await page.route("**/api/transactions**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const realTxns = TXN_ROW_IDS.map((id, i) => ({
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
      }));
      const duplicateTxn = {
        id: DUP_TXN_ROW_ID,
        occurredOn: today,
        occurredAt: `${today}T12:30:00.000Z`,
        description: `AMEX RELINK TEST — CARD ${CARD_MASKS[0]} DUP PURCHASE`,
        amount: DUP_TXN_AMOUNT,
        account: `Amex ··${CARD_MASKS[0]}`,
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
        plaidTransactionId: `${DUP_TXN_ROW_ID}-ext`,
        plaidAccountId: DUP_CARD_ROW_ID,
        debtId: null,
        matchedRuleId: null,
      };
      const body = duplicatePhase
        ? [...realTxns, duplicateTxn]
        : realTxns;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
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

    // --- Phase 1: duplicate window WITH a transaction referencing
    //     the duplicate row id. Without #449's (institution, mask)
    //     collapse, the tile would read $3,000. With the collapse,
    //     the duplicate debt is folded into card 1001's group and
    //     the tile shows $2,500.
    await expect(tile).toContainText(fmtCurrency(expectedTotal), {
      timeout: 15_000,
    });
    await expect(tile).toContainText("From debt row");
    await expect(tile).not.toContainText(fmtCurrency(inflatedTotal));

    // --- Phase 2: dedupe lands. /api/debts, /api/transactions, and
    //     /api/plaid/items all return the three-real-only shape. We
    //     reload to force a fresh fetch and assert the tile remains
    //     at $2,500 — the duplicate never contributed in phase 1
    //     either, so removing it is a no-op for the user.
    duplicatePhase = false;
    const requestsBeforeReload = debtsRequestCount;
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => debtsRequestCount, { timeout: 15_000 })
      .toBeGreaterThan(requestsBeforeReload);

    await expect(tile).toContainText(fmtCurrency(expectedTotal), {
      timeout: 15_000,
    });
    await expect(tile).toContainText("From debt row");
    await expect(tile).not.toContainText(fmtCurrency(inflatedTotal));
  });
});
