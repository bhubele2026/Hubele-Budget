import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the harder mid-re-link variant on the Chase
 * Transactions page (task #462, Chase analogue of Amex #449 / amex-
 * relink-duplicate-with-transactions-no-double-balance.spec.ts).
 *
 * #450 locks in the typical mid-re-link window on Chase: a duplicate
 * `plaid_accounts` row arrives with a per-account snapshot entry but
 * no transactions yet — the existing per-account snapshot resolution
 * never sums entries, so the user's selected real account still shows
 * its own anchored balance.
 *
 * The harder variant tested here: a sync briefly fires before
 * `dedupePlaidAccountsForUser` collapses the new (institution, mask)
 * groups, so transactions land referencing the duplicate
 * `plaid_accounts` row's external account_id. Without the (#462)
 * fix, the Chase page's per-account scoping (`scopeChaseTransactions`)
 * filters those rows out — and the Ending Balance tile would lose any
 * net change those rows represent until dedupe collapses the pair and
 * repoints the rows. With the fix, the page collapses duplicate
 * `plaid_accounts` rows by (institutionName, mask) when computing the
 * scope set, so transactions on either id contribute to the real
 * account's rolling balance immediately.
 *
 * Seeding strategy: same mock-the-payload approach as the Amex spec.
 * We add a fourth Chase transaction whose external account_id points
 * at the duplicate row's external id (DUP_ACCT_EXTERNAL_ID), and
 * assert the Ending Balance tile reflects the snapshot + ALL four
 * post-anchor rows in phase 1 (duplicate active) and remains
 * unchanged once dedupe lands (phase 2).
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const CHASE_ITEM_ROW_ID = "chase-item-row-relink-txn";
const CHASE_ITEM_EXTERNAL_ID = "item-chase-relink-txn";

const ACCT_ROW_IDS = [
  "chase-acct-row-A-txn",
  "chase-acct-row-B-txn",
  "chase-acct-row-C-txn",
] as const;

const ACCT_NAMES = ["Total Checking", "Joint Checking", "Savings"] as const;
const ACCT_MASKS = ["1111", "2222", "3333"] as const;
const ACCT_BALANCES = [1000, 500, 300] as const;

// External Plaid account_id for each row. Chase transactions store
// the external account_id (not the internal row uuid) in
// `plaidAccountId`, which is what `scopeChaseTransactions` filters on.
const ACCT_EXTERNAL_IDS = ACCT_MASKS.map(
  (m) => `${CHASE_ITEM_EXTERNAL_ID}-acct-${m}`,
) as readonly [string, string, string];

// The duplicate's plaid_accounts row id — a different uuid for the
// same physical account A (mask 1111). Distinguishing feature of
// this spec: a transaction also references the duplicate's EXTERNAL
// account id, so without #462's collapse those rows would be filtered
// out of the real account's scope.
const DUP_ACCT_ROW_ID = "chase-acct-row-A-DUP-txn";
const DUP_ACCT_EXTERNAL_ID = `${CHASE_ITEM_EXTERNAL_ID}-acct-${ACCT_MASKS[0]}-DUP`;

// Post-anchor activity. Three rows referencing the three real
// accounts plus a fourth row whose external account_id points at
// the duplicate row. All occur on the same day, after the snapshot
// time, so the rolling balance just sums them on top of the
// snapshot value for account A.
const TXN_AMOUNTS_REAL = ["-25.00", "-50.00", "-75.00"] as const;
const DUP_TXN_AMOUNT = "-10.00";

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// One calendar day before today, in the same UTC month wherever possible.
// `computeBalanceAtEndOf` skips post-anchor txns whose date string is not
// strictly greater than the snapshot's `anchorAt.slice(0,10)`, so the
// snapshot must sit on an earlier day than the activity rows for the
// rolling-balance assertion to hold. Falling back to "today" on the 1st
// of the month keeps the test in a single anchor-month even though
// same-day rows would then be treated as pre-snapshot — flaky on the
// 1st only, which is acceptable as a known caveat documented inline.
function snapshotDayIso(): string {
  const d = new Date();
  if (d.getDate() === 1) return todayIso();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate() - 1).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function thisMonthStart(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

test.describe("Chase page — re-link duplicate window with transactions doesn't drop activity from the Ending Balance (#462)", () => {
  test("when a duplicate Chase plaid_accounts row briefly carries a transaction, the Ending Balance tile still includes that activity (collapsed by institution + mask), and remains unchanged once dedupe collapses to three", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "chase-relink-dup-txn",
      provisionedUserIds,
    );

    const today = todayIso();
    const snapshotDay = snapshotDayIso();
    const monthStart = thisMonthStart();
    // Anchor the snapshot at noon on the day BEFORE the activity rows
    // so `computeBalanceAtEndOf` actually folds the post-anchor txns
    // into the rolling end-of-anchor-month balance — same-day rows
    // are deliberately treated as already reflected in the snapshot
    // (see accountBalance.ts), which would otherwise mask this fix.
    const snapshotAt = `${snapshotDay}T12:00:00.000Z`;
    const txnAt = (i: number) =>
      `${today}T${String(9 + i).padStart(2, "0")}:00:00.000Z`;

    let duplicatePhase = true;
    let forecastRequestCount = 0;

    // --- /api/plaid/items: one Chase item, three or four checking
    //     accounts depending on the phase. Both phases expose the
    //     real survivors; phase 1 also exposes the duplicate row
    //     for mask 1111 with its own external id.
    await page.route("**/api/plaid/items", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const realAccounts = ACCT_ROW_IDS.map((id, i) => ({
        id,
        accountId: ACCT_EXTERNAL_IDS[i],
        name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
        mask: ACCT_MASKS[i],
        type: "depository",
        subtype: i === 2 ? "savings" : "checking",
      }));
      const duplicateAccount = {
        id: DUP_ACCT_ROW_ID,
        accountId: DUP_ACCT_EXTERNAL_ID,
        name: `${ACCT_NAMES[0]} ··${ACCT_MASKS[0]}`,
        mask: ACCT_MASKS[0],
        type: "depository",
        subtype: "checking",
      };
      const accounts = duplicatePhase
        ? [...realAccounts, duplicateAccount]
        : realAccounts;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: CHASE_ITEM_ROW_ID,
            itemId: CHASE_ITEM_EXTERNAL_ID,
            institutionId: "ins_chase",
            institutionName: "Chase",
            institutionSlug: "chase",
            lastSyncedAt: snapshotAt,
            lastSyncError: null,
            lastSyncErrorCode: null,
            stillPreparing: false,
            accounts,
          },
        ]),
      });
    });

    // --- /api/forecast: bank snapshot anchored at A, plaidCheckingAccounts
    //     (3 or 4), accountSnapshots map (3 entries always — the
    //     duplicate row never has its own snapshot in this scenario,
    //     this is the transactions-only variant).
    await page.route("**/api/forecast**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") return route.fallback();
      if (!/\/api\/forecast(?:\?|$)/.test(url.pathname + url.search)) {
        return route.fallback();
      }
      forecastRequestCount += 1;

      const realCheckingAccounts = ACCT_ROW_IDS.map((id, i) => ({
        id,
        accountId: ACCT_EXTERNAL_IDS[i],
        name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
        mask: ACCT_MASKS[i],
        subtype: i === 2 ? "savings" : "checking",
        institutionName: "Chase",
      }));
      const duplicateChecking = {
        id: DUP_ACCT_ROW_ID,
        accountId: DUP_ACCT_EXTERNAL_ID,
        name: `${ACCT_NAMES[0]} ··${ACCT_MASKS[0]}`,
        mask: ACCT_MASKS[0],
        subtype: "checking",
        institutionName: "Chase",
      };
      const plaidCheckingAccounts = duplicatePhase
        ? [...realCheckingAccounts, duplicateChecking]
        : realCheckingAccounts;

      const accountSnapshots: Record<
        string,
        {
          balance: string;
          at: string;
          source: "plaid" | "manual";
          name: string | null;
          mask: string | null;
        }
      > = {};
      ACCT_ROW_IDS.forEach((id, i) => {
        accountSnapshots[id] = {
          balance: ACCT_BALANCES[i].toFixed(2),
          at: snapshotAt,
          source: "plaid",
          name: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
          mask: ACCT_MASKS[i],
        };
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          fromDate: today,
          toDate: today,
          events: [],
          transactions: [],
          resolutions: [],
          closedMonths: [],
          settings: {},
          bankSnapshot: {
            balance: ACCT_BALANCES[0].toFixed(2),
            at: snapshotAt,
            source: "plaid",
            accountId: ACCT_ROW_IDS[0],
            name: `${ACCT_NAMES[0]} ··${ACCT_MASKS[0]}`,
            mask: ACCT_MASKS[0],
          },
          cashSignal: null,
          plaidCheckingAccounts,
          monthSnapshots: {},
          accountSnapshots,
        }),
      });
    });

    // --- /api/transactions: three real-account rows plus a fourth row
    //     pinned to the DUPLICATE's external account_id. Phase 2
    //     drops the duplicate row (dedupe repoints it onto the real
    //     id; we just remove it for the test since the assertion is
    //     about the real account's rolling total either way).
    await page.route("**/api/transactions**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const baseTxn = {
        occurredOn: today,
        categoryId: null,
        forecastFlag: false,
        weeklyAllowance: false,
        weeklyBucket: null,
        monthlyAllowance: false,
        unplannedAllowance: false,
        reimbursable: false,
        reimbursed: false,
        // (#462 spec) `reviewed` + `isTransferUserOverridden` are
        // required booleans on `ListTransactionsResponseItem`; missing
        // either drops the whole array on schema parse, leaving the
        // page with no chase transactions and an anchor-only ending
        // balance — which silently masked the fix this spec is meant
        // to verify.
        reviewed: false,
        isTransfer: false,
        isTransferUserOverridden: false,
        notes: null,
        member: null,
        owedBy: null,
        debtId: null,
        matchedRuleId: null,
        source: "plaid:chase" as const,
      };
      const realTxns = ACCT_ROW_IDS.map((id, i) => ({
        ...baseTxn,
        id: `txn-chase-${ACCT_MASKS[i]}-txn`,
        occurredAt: txnAt(i),
        description: `CHASE RELINK TEST — ${ACCT_NAMES[i]} ${ACCT_MASKS[i]} ACTIVITY`,
        amount: TXN_AMOUNTS_REAL[i],
        account: `${ACCT_NAMES[i]} ··${ACCT_MASKS[i]}`,
        plaidTransactionId: `txn-chase-${ACCT_MASKS[i]}-txn-ext`,
        plaidAccountId: ACCT_EXTERNAL_IDS[i],
      }));
      const duplicateTxn = {
        ...baseTxn,
        id: "txn-chase-1111-DUP-txn",
        occurredAt: txnAt(3),
        description: `CHASE RELINK TEST — DUP ${ACCT_MASKS[0]} ACTIVITY`,
        amount: DUP_TXN_AMOUNT,
        account: `${ACCT_NAMES[0]} ··${ACCT_MASKS[0]}`,
        plaidTransactionId: "txn-chase-1111-DUP-txn-ext",
        plaidAccountId: DUP_ACCT_EXTERNAL_ID,
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

    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const trigger = page.getByTestId("select-chase-account");
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    const endingBal = page.getByTestId("stat-ending-balance");

    // --- Phase 1: duplicate window. The default-selected account is
    //     the snapshot account (A) since `selectedAccountKey` starts
    //     unset and falls back to bankSnapshot.accountId. With the
    //     #462 collapse, the duplicate row's transaction (-$10.00)
    //     is included in A's rolling total: $1,000 (snapshot) + the
    //     real A transaction (-$25.00) + the duplicate-row
    //     transaction (-$10.00) = $965.00.
    const expectedA =
      ACCT_BALANCES[0] +
      Number(TXN_AMOUNTS_REAL[0]) +
      Number(DUP_TXN_AMOUNT);
    // Without the collapse, the duplicate row's transaction would be
    // dropped from A's scope and the tile would read $975.00.
    const droppedTotal = ACCT_BALANCES[0] + Number(TXN_AMOUNTS_REAL[0]);
    await expect(endingBal).toContainText(fmtCurrency(expectedA), {
      timeout: 15_000,
    });
    await expect(endingBal).not.toContainText(fmtCurrency(droppedTotal));

    // Switch to B → tile shows snapshot + B's row only ($500 - $50 = $450).
    // Confirms the collapse only folds in same-(institution, mask) siblings.
    await trigger.click();
    const optionB = page.getByTestId(`option-chase-account-${ACCT_ROW_IDS[1]}`);
    await expect(optionB).toBeVisible({ timeout: 10_000 });
    await optionB.click();
    const expectedB = ACCT_BALANCES[1] + Number(TXN_AMOUNTS_REAL[1]);
    await expect(endingBal).toContainText(fmtCurrency(expectedB), {
      timeout: 10_000,
    });

    // Switch to C → tile shows snapshot + C's row only ($300 - $75 = $225).
    await trigger.click();
    const optionC = page.getByTestId(`option-chase-account-${ACCT_ROW_IDS[2]}`);
    await expect(optionC).toBeVisible({ timeout: 10_000 });
    await optionC.click();
    const expectedC = ACCT_BALANCES[2] + Number(TXN_AMOUNTS_REAL[2]);
    await expect(endingBal).toContainText(fmtCurrency(expectedC), {
      timeout: 10_000,
    });

    // --- Phase 2: dedupe lands. Both `/api/forecast` and
    //     `/api/transactions` return the three-real-only shape
    //     (the previously duplicate-pinned transaction is gone —
    //     in production it would be repointed onto the real id).
    duplicatePhase = false;
    const requestsBeforeReload = forecastRequestCount;
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => forecastRequestCount, { timeout: 15_000 })
      .toBeGreaterThan(requestsBeforeReload);

    // The picker selection (last set to C in Phase 1) persists via
    // `?account=` URL + localStorage across the reload. Switch back
    // to A and assert its tile has dropped the duplicate row's
    // contribution and now reads snapshot + the real A row only —
    // i.e. the user sees $975.00 once dedupe has collapsed the
    // accounts, because the duplicate's transaction has been
    // repointed away.
    await trigger.click();
    await expect(
      page.getByTestId(`option-chase-account-${DUP_ACCT_ROW_ID}`),
    ).toHaveCount(0);
    await page
      .getByTestId(`option-chase-account-${ACCT_ROW_IDS[0]}`)
      .click();
    await expect(endingBal).toContainText(fmtCurrency(droppedTotal), {
      timeout: 10_000,
    });
  });
});
