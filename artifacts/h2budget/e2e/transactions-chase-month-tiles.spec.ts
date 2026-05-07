import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #443 (#447).
 *
 * Task #443 fixed the Chase Transactions page so the five summary
 * bubbles (Starting balance, Money in, Money out, Ending balance, Net
 * change) only count transactions inside the selected month and ignore
 * duplicate Plaid rows. The unit test in `src/lib/chaseScope.test.ts`
 * exercises the helpers in isolation; this spec drives the rendered
 * page through Playwright so a regression that left the bubble math
 * wired to the wrong scope (or skipped dedupe at render time) actually
 * surfaces in the UI.
 *
 * The duplicate-Plaid case is the regression #443 was actually about,
 * but the `transactions_plaid_txn_uq` unique index on
 * `transactions.plaid_transaction_id` blocks us from inserting two
 * such rows directly via the DB. Instead we mock GET
 * `/api/transactions` with a fixture that contains the duplicate
 * (and a stray April row), which is what the React Query cache would
 * carry into the page anyway.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, userId));
      await db
        .delete(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, userId));
      await db
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, userId));
      await db
        .delete(plaidItemsTable)
        .where(eq(plaidItemsTable.userId, userId));
    } catch {
      // best-effort
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Chase month tiles — May 2026 totals (#447, covers #443)", () => {
  test("dedupes duplicate Plaid rows, ignores cross-month rows, and updates when the user navigates months", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-month-tiles",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // --- Direct DB seed: one Chase checking account that owns the
    // bank snapshot anchor. Keeping it to a single linked account
    // means the chase-account-picker isn't rendered and the bubbles
    // are the only thing under test.
    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        itemId: `e2e-item-${suffix}`,
        accessToken: "e2e-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        itemId: item.id,
        accountId: `e2e-acct-${suffix}`,
        name: "Total Checking",
        mask: "1111",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor the bank snapshot at end-of-April 2026 with the
    // canonical $3,565.09 ending balance from #443. Using the
    // already-correct value sidesteps the seedAprilChase repair path
    // (which would otherwise rewrite balance/source/at on us).
    await db.insert(forecastSettingsTable).values({
      userId,
      bankSnapshotBalance: "3565.09",
      bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acct.id,
      bankSnapshotName: acct.name,
      bankSnapshotMask: acct.mask,
    });

    // Fixture rows on the snapshot account. Mirrors
    // `chaseScope.test.ts`'s "Chase summary bubbles for May 2026"
    // scenario: clean May activity, a duplicate Plaid row that
    // pre-#443 double-counted into Money in, plus an April row that
    // pre-fix leaked into May's bubbles. The list is served via a
    // mocked GET /api/transactions below.
    type FixtureRow = {
      id: string;
      occurredOn: string;
      amount: string;
      plaidTransactionId: string;
      description: string;
    };
    const fixture: FixtureRow[] = [
      // April row — must NOT show up in May's tiles.
      {
        id: `00000000-0000-4000-8000-${suffix}000000a1`,
        occurredOn: "2026-04-29",
        amount: "-123.45",
        plaidTransactionId: `e2e-${suffix}-apr-1`,
        description: `E2E-${suffix} APR-1`,
      },
      // May income.
      {
        id: `00000000-0000-4000-8000-${suffix}0000m001`,
        occurredOn: "2026-05-01",
        amount: "4036.29",
        plaidTransactionId: `e2e-${suffix}-may-ptx-payroll`,
        description: `E2E-${suffix} MAY PAYROLL`,
      },
      {
        id: `00000000-0000-4000-8000-${suffix}0000m002`,
        occurredOn: "2026-05-15",
        amount: "250.00",
        plaidTransactionId: `e2e-${suffix}-may-ptx-bonus`,
        description: `E2E-${suffix} MAY BONUS`,
      },
      // May expenses.
      {
        id: `00000000-0000-4000-8000-${suffix}0000m003`,
        occurredOn: "2026-05-02",
        amount: "-1989.81",
        plaidTransactionId: `e2e-${suffix}-may-ptx-rent`,
        description: `E2E-${suffix} MAY RENT`,
      },
      {
        id: `00000000-0000-4000-8000-${suffix}0000m004`,
        occurredOn: "2026-05-05",
        amount: "-2186.96",
        plaidTransactionId: `e2e-${suffix}-may-ptx-amex`,
        description: `E2E-${suffix} MAY AMEX`,
      },
      {
        id: `00000000-0000-4000-8000-${suffix}0000m005`,
        occurredOn: "2026-05-10",
        amount: "-7.50",
        plaidTransactionId: `e2e-${suffix}-may-ptx-coffee`,
        description: `E2E-${suffix} MAY COFFEE`,
      },
      // Duplicate Plaid payroll row (same plaid_transaction_id as
      // may-payroll). dedupeTransactionsByIdentity must collapse it,
      // so it must NOT inflate Money in by another +$4,036.29.
      {
        id: `00000000-0000-4000-8000-${suffix}0000m006`,
        occurredOn: "2026-05-01",
        amount: "4036.29",
        plaidTransactionId: `e2e-${suffix}-may-ptx-payroll`,
        description: `E2E-${suffix} MAY PAYROLL DUP`,
      },
    ];

    // --- Sign in and open the Chase page directly on May 2026.
    const context = await browser.newContext();
    const page = await context.newPage();

    // Mock GET /api/transactions to return our fixture (with the
    // duplicate row) instead of whatever the DB has. The unique
    // constraint on plaid_transaction_id makes inserting the
    // duplicate via the DB impossible, but the regression #443 was
    // about dedupe-at-render-time when the cached list contains a
    // duplicate row, so a network-level mock is the faithful
    // reproduction.
    await page.route("**/api/transactions**", async (route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.continue();
        return;
      }
      const rows = fixture.map((r) => ({
        id: r.id,
        occurredOn: r.occurredOn,
        occurredAt: `${r.occurredOn}T15:00:00.000Z`,
        description: r.description,
        amount: r.amount,
        account: acct.name,
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
        source: "plaid",
        member: null,
        owedBy: null,
        plaidTransactionId: r.plaidTransactionId,
        plaidAccountId: acct.accountId,
        debtId: null,
        matchedRuleId: null,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      });
    });

    // Suppress the on-mount April 2026 Chase seed. The page fires
    // `useSeedAprilChase` on every initial load, which would happily
    // insert ~95 real April rows into our snapshot account. The
    // listTransactions mock above already shields the page from that
    // pollution, but stubbing the seed too keeps the test a no-op
    // against the seed's repair logic.
    await page.route("**/api/seed/april-chase", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          alreadySeeded: true,
          inserted: 0,
          skipped: 0,
          categorized: 0,
          transfers: 0,
          rulesAdded: 0,
          endingBalance: "3565.09",
          syntheticAccount: false,
          accountId: acct.accountId,
          snapshotRepaired: false,
        }),
      });
    });

    await signInAndOpen(
      page,
      email,
      password,
      "/transactions?month=2026-05-01",
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const startingBal = page.getByTestId("stat-starting-balance");
    const moneyIn = page.getByTestId("stat-money-in");
    const moneyOut = page.getByTestId("stat-money-out");
    const endingBal = page.getByTestId("stat-ending-balance");
    const netChange = page.getByTestId("stat-net-change");
    const monthLabel = page.getByTestId("text-selected-month");

    // Wait for the page to settle on May 2026 (the rent row is the
    // most distinctive May fixture row and won't render until
    // forecastData + the month-scoped txns have loaded).
    await expect(monthLabel).toHaveText("May '26", { timeout: 15_000 });
    await expect(
      page.getByText(`E2E-${suffix} MAY RENT`).first(),
    ).toBeVisible({ timeout: 15_000 });

    // --- May 2026 tile assertions.
    //
    // Expected math (after deduping `may-payroll-dup` against
    // `may-payroll`, and excluding the April row from the
    // month-scoped totals):
    //   in:  4036.29 + 250.00            = 4286.29
    //   out: 1989.81 + 2186.96 + 7.50    = 4184.27
    //   net: 4286.29 - 4184.27           = +102.02
    //   ending = anchor (3565.09) + net  = 3667.11
    //   starting = ending - net          = 3565.09
    await expect(startingBal).toContainText("$3,565.09");
    await expect(startingBal).not.toContainText("Unavailable");
    await expect(moneyIn).toContainText("$4,286.29");
    await expect(moneyOut).toContainText("$4,184.27");
    await expect(endingBal).toContainText("$3,667.11");
    await expect(endingBal).not.toContainText("Unavailable");
    await expect(netChange).toContainText("+$102.02");

    // --- Navigate back to April 2026 and re-assert. The April row
    // (-$123.45) should now show in Money out, May's totals should
    // disappear, and the snapshot-anchored balances should reflect
    // April's net change.
    //
    // Expected math:
    //   in:  0
    //   out: 123.45
    //   net: -123.45
    //   ending = anchor                   = 3565.09
    //   starting = ending - net           = 3688.54
    await page.getByTestId("button-prev-month").click();
    await expect(monthLabel).toHaveText("Apr '26");
    await expect(
      page.getByText(`E2E-${suffix} APR-1`).first(),
    ).toBeVisible({ timeout: 10_000 });

    await expect(startingBal).toContainText("$3,688.54");
    await expect(startingBal).not.toContainText("Unavailable");
    await expect(moneyIn).toContainText("$0.00");
    await expect(moneyOut).toContainText("$123.45");
    await expect(endingBal).toContainText("$3,565.09");
    await expect(endingBal).not.toContainText("Unavailable");
    await expect(netChange).toContainText("-$123.45");

    // None of the May fixture descriptions should be visible in the
    // April day groups.
    await expect(page.getByText(`E2E-${suffix} MAY RENT`)).toHaveCount(0);
    await expect(page.getByText(`E2E-${suffix} MAY PAYROLL`)).toHaveCount(0);

    await context.close();
  });
});
