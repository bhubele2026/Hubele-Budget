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
 * End-to-end coverage for task #453 (the rendered-page guarantee for #448).
 *
 * Task #448 tightened the Chase Transactions page so that, when no
 * Plaid checking account is linked, only Chase + manual rows fall
 * through the source-based fallback. The unit test in
 * `chaseScope.test.ts` pins `isChaseFallbackSource` directly, but no
 * spec yet renders `pages/transactions.tsx` against a mixed-source
 * cache to prove the page itself doesn't sweep in Amex / debt rows.
 *
 * Scenario: a fresh user with no linked Plaid checking, whose
 * GET /api/transactions returns a mixed payload of Amex, Chase,
 * manual, and an unrelated debt-card row — none of them carrying a
 * `plaidAccountId`. The Chase page must render only the Chase + manual
 * rows in the table, and the Money in / Money out bubble math must
 * exclude Amex/debt amounts.
 *
 * The fixture's amounts are chosen so the pre-#448 fallback (which
 * keyed on `!t.plaidAccountId` and would have included every row) and
 * the current fallback (Chase + manual only) produce DIFFERENT bubble
 * totals. That way a regression to the old behavior fails this spec
 * loudly instead of silently.
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

test.describe("Chase Transactions page — Amex/debt rows stay off the page when no Plaid checking is linked (#453, covers #448)", () => {
  test("only Chase + manual rows reach the table and the Money in/out bubbles", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-hides-amex",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // No plaidItemsTable / plaidAccountsTable / forecastSettingsTable
    // seeding on purpose: this is the "no Plaid checking linked"
    // fallback the helper guards. The Starting / Ending balance tiles
    // will render in their Unavailable state, which is expected.

    const suffix = Math.random().toString(36).slice(2, 8);

    // Distinctive descriptions per row so the assertions below can
    // pin the visible text and fail loudly if a future refactor
    // changes the row testid format.
    const CHASE_INCOME_DESC = `E2E-${suffix} CHASE PAYROLL`;
    const CHASE_EXPENSE_DESC = `E2E-${suffix} CHASE GROCERIES`;
    const MANUAL_EXPENSE_DESC = `E2E-${suffix} MANUAL CASH`;
    const AMEX_EXPENSE_DESC = `E2E-${suffix} AMEX RESTAURANT`;
    const PLAID_AMEX_EXPENSE_DESC = `E2E-${suffix} PLAID AMEX TRAVEL`;
    const OTHER_DEBT_EXPENSE_DESC = `E2E-${suffix} CAPITAL ONE DEBT`;

    type FixtureRow = {
      id: string;
      description: string;
      amount: string;
      source: string;
      plaidTransactionId: string | null;
    };

    // Amounts are chosen so:
    //   Correct (#448) — Chase + manual only:
    //     Money in  = 200.00          (Chase payroll)
    //     Money out =  30.00 + 10.00  (Chase groceries + manual cash) = 40.00
    //   Regression (pre-#448 `!t.plaidAccountId` fallback) would
    //   include Amex + plaid:amex + plaid:capitalone too:
    //     Money in  = 200.00
    //     Money out = 30.00 + 10.00 + 50.00 + 70.00 + 25.00 = 185.00
    // The Money out delta (40 vs 185) is the regression tripwire.
    const fixture: FixtureRow[] = [
      {
        id: `00000000-0000-4000-8000-${suffix}0000c001`,
        description: CHASE_INCOME_DESC,
        amount: "200.00",
        source: "plaid:chase",
        plaidTransactionId: `e2e-${suffix}-chase-in`,
      },
      {
        id: `00000000-0000-4000-8000-${suffix}0000c002`,
        description: CHASE_EXPENSE_DESC,
        amount: "-30.00",
        source: "chase",
        plaidTransactionId: null,
      },
      {
        id: `00000000-0000-4000-8000-${suffix}0000c003`,
        description: MANUAL_EXPENSE_DESC,
        amount: "-10.00",
        source: "manual",
        plaidTransactionId: null,
      },
      {
        id: `00000000-0000-4000-8000-${suffix}0000c004`,
        description: AMEX_EXPENSE_DESC,
        amount: "-50.00",
        source: "amex",
        plaidTransactionId: null,
      },
      {
        id: `00000000-0000-4000-8000-${suffix}0000c005`,
        description: PLAID_AMEX_EXPENSE_DESC,
        amount: "-70.00",
        source: "plaid:amex",
        plaidTransactionId: `e2e-${suffix}-amex-out`,
      },
      {
        id: `00000000-0000-4000-8000-${suffix}0000c006`,
        description: OTHER_DEBT_EXPENSE_DESC,
        amount: "-25.00",
        source: "plaid:capitalone",
        plaidTransactionId: `e2e-${suffix}-capone-out`,
      },
    ];

    const context = await browser.newContext();
    const page = await context.newPage();

    // Mock GET /api/transactions to return the mixed-source payload
    // with no plaidAccountId on any row. This is the exact cache shape
    // that, pre-#448, would have rendered Amex/debt rows on the Chase
    // page because the fallback only checked `!t.plaidAccountId`.
    await page.route("**/api/transactions**", async (route) => {
      const req = route.request();
      if (req.method() !== "GET") {
        await route.continue();
        return;
      }
      const rows = fixture.map((r) => ({
        id: r.id,
        occurredOn: "2026-05-10",
        occurredAt: "2026-05-10T15:00:00.000Z",
        description: r.description,
        amount: r.amount,
        account: r.source.startsWith("plaid:") ? r.source.slice(6) : r.source,
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
        source: r.source,
        member: null,
        owedBy: null,
        plaidTransactionId: r.plaidTransactionId,
        plaidAccountId: null,
        debtId: null,
        matchedRuleId: null,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows),
      });
    });

    // Suppress the on-mount April Chase seed so it can't insert real
    // April rows that would muddy the May totals under test.
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
          endingBalance: "0.00",
          syntheticAccount: false,
          accountId: null,
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
    await expect(page.getByTestId("text-selected-month")).toHaveText(
      "May '26",
      { timeout: 15_000 },
    );

    // Wait for the mocked Chase income row to appear — that's the
    // signal the chaseTransactions memo has run against our payload.
    await expect(page.getByText(CHASE_INCOME_DESC).first()).toBeVisible({
      timeout: 15_000,
    });

    // --- The core guarantee: only Chase + manual rows are rendered. ---
    //
    // (1) Per-row testids: the Chase + manual rows are present, the
    //     Amex / plaid:amex / plaid:capitalone rows are not.
    await expect(page.getByTestId(`row-tx-${fixture[0].id}`)).toBeVisible();
    await expect(page.getByTestId(`row-tx-${fixture[1].id}`)).toBeVisible();
    await expect(page.getByTestId(`row-tx-${fixture[2].id}`)).toBeVisible();
    await expect(page.getByTestId(`row-tx-${fixture[3].id}`)).toHaveCount(0);
    await expect(page.getByTestId(`row-tx-${fixture[4].id}`)).toHaveCount(0);
    await expect(page.getByTestId(`row-tx-${fixture[5].id}`)).toHaveCount(0);

    // (2) Belt-and-braces text assertions: the Amex/debt descriptions
    //     never appear on the page at all. If the regression returns
    //     and the fallback re-includes Amex rows, these would each
    //     match exactly once.
    await expect(page.getByText(AMEX_EXPENSE_DESC)).toHaveCount(0);
    await expect(page.getByText(PLAID_AMEX_EXPENSE_DESC)).toHaveCount(0);
    await expect(page.getByText(OTHER_DEBT_EXPENSE_DESC)).toHaveCount(0);

    // (3) Filtered row counter — "{filtered} of {monthScoped} txns".
    //     Three Chase + manual rows survive scoping; if the regression
    //     hit, this would read "6 of 6 txns".
    await expect(page.getByTestId("text-row-count")).toHaveText(
      /3 of 3 txns/,
      { timeout: 15_000 },
    );

    // (4) Money in / Money out bubble math reflects only the Chase +
    //     manual rows. The pre-#448 fallback would have produced
    //     Money out = $185.00 because it would have summed the Amex
    //     and Capital One outflows too — that's the user-visible
    //     regression symptom this spec locks in.
    await expect(page.getByTestId("stat-money-in")).toContainText("$200.00");
    await expect(page.getByTestId("stat-money-out")).toContainText("$40.00");
    await expect(page.getByTestId("stat-money-in")).not.toContainText("$0.00");
    await expect(page.getByTestId("stat-money-out")).not.toContainText(
      "$185.00",
    );

    await context.close();
  });
});
