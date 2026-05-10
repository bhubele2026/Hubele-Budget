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
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #459 (browser-level guarantee for #452).
 *
 * Task #452 added thorough server-side dedupe coverage
 * (`dedupeTransactions.integration.test.ts`,
 * `plaidFirstSyncCutoff.integration.test.ts`,
 * `plaidAmexResyncNoDuplicates.integration.test.ts`) but none of those
 * specs drive the actual rendered Transactions page. The Chase page's
 * client-side dedupe (`dedupeTransactionsByIdentity` in
 * `src/lib/chaseScope.ts`, applied inside the `chaseTransactions` memo
 * on `src/pages/transactions.tsx`) is the last line of defense when a
 * Plaid sync briefly leaves a twin row in the React Query cache — for
 * example, when the dedupe report repointed forecast resolutions and
 * deleted the loser server-side but the client list hasn't yet been
 * invalidated, or when a re-sync delivers the survivor's row a second
 * time before the loser is GC'd.
 *
 * What we want to lock in here: when GET /api/transactions returns two
 * rows that share a `plaidTransactionId` (the historical Chase
 * duplicate shape), the rendered Transactions page MUST show that
 * Chase row exactly once. No duplicate `row-tx-*` for the survivor's
 * description, no doubled day-net, and the "{filtered} of
 * {monthScoped}" counter must read "1 of 1".
 *
 * Seeding strategy mirrors `transactions-chase-month-tiles.spec.ts`
 * (#447): a single linked Chase checking account anchors the bank
 * snapshot (so the chase-account-picker is hidden and the page surfaces
 * the snapshot account by default), and GET /api/transactions is mocked
 * to return the duplicate-bearing payload. The DB's
 * `transactions_plaid_txn_uq` unique index would block inserting the
 * duplicate via the real insert path, but the regression #452 was about
 * a duplicate sitting in the cached list at render time, so a
 * network-level mock is the faithful reproduction.
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

test.describe("Chase Transactions page — no duplicate rows after sync (#459, covers #452)", () => {
  test("a Chase row that previously twinned now renders exactly once on /transactions", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-no-dup",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // --- Direct DB seed: one Chase checking account that owns the
    // bank snapshot anchor. Keeping it to a single linked account
    // means the chase-account-picker isn't rendered and the duplicate
    // assertion below is the only thing under test.
    const suffix = Math.random().toString(36).slice(2, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
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
        householdId,
        itemId: item.id,
        accountId: `e2e-acct-${suffix}`,
        name: "Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Pre-populate the bank snapshot so the snapshot-anchored balance
    // tiles render (otherwise the page falls back to the "Unavailable"
    // placeholder). Using the canonical April-end value sidesteps the
    // seedAprilChase repair path on first mount.
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "3565.09",
      bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acct.id,
      bankSnapshotName: acct.name,
      bankSnapshotMask: acct.mask,
    });

    // The "twin" — two rows with different DB ids but the same
    // `plaidTransactionId`. This is the cache shape that pre-#452
    // would have rendered as TWO rows on the Chase page (one per
    // distinct id). After #452's `dedupeTransactionsByIdentity` runs
    // inside the `chaseTransactions` memo, only the first one survives.
    const SHARED_PTX = `e2e-${suffix}-may-ptx-exact`;
    const TWIN_DESCRIPTION = `E2E-${suffix} EXACT SCIENCES`;
    const SOLO_DESCRIPTION = `E2E-${suffix} STARBUCKS`;

    type FixtureRow = {
      id: string;
      occurredOn: string;
      amount: string;
      plaidTransactionId: string;
      description: string;
    };
    const fixture: FixtureRow[] = [
      // Survivor (older row, hand-categorized in real life — here we
      // just need it to win the dedupe by virtue of insertion order).
      {
        id: `00000000-0000-4000-8000-${suffix}0000d001`,
        occurredOn: "2026-05-08",
        amount: "-12.34",
        plaidTransactionId: SHARED_PTX,
        description: TWIN_DESCRIPTION,
      },
      // Loser — same plaid_transaction_id, different DB id. Pre-#452
      // this would render as a second `row-tx-*` and double the
      // day-net for 2026-05-08.
      {
        id: `00000000-0000-4000-8000-${suffix}0000d002`,
        occurredOn: "2026-05-08",
        amount: "-12.34",
        plaidTransactionId: SHARED_PTX,
        description: TWIN_DESCRIPTION,
      },
      // An unrelated solo row on a different day, so we can prove the
      // page is rendering rows at all and that the dedupe didn't
      // accidentally collapse non-twins together.
      {
        id: `00000000-0000-4000-8000-${suffix}0000d003`,
        occurredOn: "2026-05-09",
        amount: "-4.50",
        plaidTransactionId: `e2e-${suffix}-may-ptx-coffee`,
        description: SOLO_DESCRIPTION,
      },
    ];

    const context = await browser.newContext();
    const page = await context.newPage();

    // Mock GET /api/transactions to return the twin-bearing payload.
    // The real insert path's unique index on plaid_transaction_id makes
    // it impossible to seed this shape via the DB, but the regression
    // #452 was about dedupe-at-render-time when the cached list
    // contains a twin, so a network-level mock is the faithful
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
        source: "plaid:chase",
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

    // Suppress the on-mount April Chase seed — same reason as in
    // `transactions-chase-month-tiles.spec.ts`: it would otherwise
    // insert ~95 real April rows into our snapshot account.
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

    // Wait for the page to settle on May 2026 with the solo row
    // visible — that's the most distinctive marker that the
    // chaseTransactions memo has run against our mocked payload.
    await expect(page.getByTestId("text-selected-month")).toHaveText(
      "May '26",
      { timeout: 15_000 },
    );
    await expect(page.getByText(SOLO_DESCRIPTION).first()).toBeVisible({
      timeout: 15_000,
    });

    // --- The core guarantee: the twinned row appears EXACTLY ONCE. ---
    //
    // (1) The survivor's `row-tx-*` is rendered. The loser's id is
    //     present in the cache but `dedupeTransactionsByIdentity`
    //     dropped it before the memo emitted, so the loser's
    //     `row-tx-*` testid must NOT exist in the DOM at all.
    await expect(
      page.getByTestId(`row-tx-${fixture[0].id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`row-tx-${fixture[1].id}`),
    ).toHaveCount(0);

    // (2) The visible description text appears exactly once across the
    //     rendered table. Belt-and-braces against a future refactor
    //     that swaps the row testid format — if the user ever sees
    //     "EXACT SCIENCES" twice on the page, this assertion trips.
    await expect(page.getByText(TWIN_DESCRIPTION)).toHaveCount(1);

    // (3) The "{filtered} of {monthScoped}" counter must reflect a
    //     single Chase row for the twinned date plus the solo row.
    //     If the dedupe ever regresses, this would read "3 of 3".
    await expect(page.getByTestId("text-row-count")).toHaveText(
      /2 of 2 txns/,
      { timeout: 15_000 },
    );

    // (4) The day-net for 2026-05-08 must be the single-row total
    //     (-$12.34), not the doubled (-$24.68) sum a regression would
    //     produce. This is the user-visible math symptom of the bug.
    await expect(page.getByTestId("day-net-2026-05-08")).toHaveText(
      /^-\$12\.34$/,
    );

    await context.close();
  });
});
