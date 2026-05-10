import { test, expect, type Page } from "@playwright/test";
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
 * End-to-end coverage for task #316.
 *
 * The Chase Transactions page has a self-healing effect (transactions.tsx
 * ~lines 316-323) that drops the persisted `?account=` / localStorage
 * selection when the linked account it points at no longer exists
 * (bank disconnected, account closed). The picker spec from #297 covers
 * the happy path but never exercises this fallback, so a regression
 * that left the picker stuck on a deleted account — rendering an empty
 * value and zeroed chips — wouldn't be caught.
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function thisMonthStart(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

async function getStorageValue(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

test.describe("Chase per-account picker — stale selection self-heal (#316)", () => {
  test("after the persisted account is deleted, reload falls back to the snapshot account and clears ?account= + localStorage", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-account-stale",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // --- Direct DB seed: two linked checking accounts under the same
    // Plaid item, with rows on each so the picker is visible and the
    // chip totals differ between the two accounts. Mirrors the fixture
    // shape from the #297 picker spec.
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
    const [acctA] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: item.id,
        accountId: `e2e-acct-A-${suffix}`,
        name: "Total Checking",
        mask: "1111",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    const [acctB] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: item.id,
        accountId: `e2e-acct-B-${suffix}`,
        name: "Joint Checking",
        mask: "2222",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor the bank snapshot at account A using a balance + date that
    // do NOT match any of seedAprilChase's repair triggers, so the
    // on-mount seed leaves our snapshot intact and the snapshot account
    // remains the picker's default fallback.
    const today = todayISO();
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1234.56",
      bankSnapshotAt: new Date(`${today}T12:00:00Z`),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acctA.id,
      bankSnapshotName: acctA.name,
      bankSnapshotMask: acctA.mask,
    });

    const seedRow = async (
      plaidAccountId: string,
      tag: "A" | "B",
      idx: number,
      amount: string,
    ) => {
      const [row] = await db
        .insert(transactionsTable)
        .values({
          userId,
          householdId,
          occurredOn: today,
          occurredAt: new Date(`${today}T15:00:00Z`).toISOString(),
          description: `E2E-${suffix} ${tag}${idx}`,
          amount,
          account: tag === "A" ? "Total Checking" : "Joint Checking",
          source: "plaid",
          plaidTransactionId: `e2e-${suffix}-${tag}-${idx}`,
          plaidAccountId,
        })
        .returning();
      return row;
    };
    const a1 = await seedRow(acctA.accountId, "A", 1, "200.00");
    const a2 = await seedRow(acctA.accountId, "A", 2, "-50.00");
    const b1 = await seedRow(acctB.accountId, "B", 1, "77.00");
    const b2 = await seedRow(acctB.accountId, "B", 2, "-33.00");

    // --- Sign in and open the Chase page; switch the picker to B so
    // the selection persists into both `?account=` and localStorage.
    const monthStart = thisMonthStart();
    const context = await browser.newContext();
    const page = await context.newPage();
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

    // Wait for the snapshot-account default to render before switching,
    // so we know forecastData has loaded and the picker has its options.
    await expect(page.getByTestId(`row-tx-${a1.id}`)).toBeVisible({
      timeout: 15_000,
    });

    // Open the picker and switch to account B. Wait for the option to
    // be visible after the trigger click — Radix Select renders
    // SelectContent inside a portal, so options appear asynchronously
    // after the trigger opens.
    await trigger.click();
    const optionB = page.getByTestId(`option-chase-account-${acctB.id}`);
    await expect(optionB).toBeVisible({ timeout: 10_000 });
    await optionB.click();

    await expect(page.getByTestId(`row-tx-${b1.id}`)).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId(`row-tx-${a1.id}`)).toHaveCount(0);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBe(acctB.id);
    await expect
      .poll(() => getStorageValue(page, "h2budget:chase-account"))
      .toBe(acctB.id);

    // --- Simulate the bank-disconnect / account-closed path by
    // deleting account B's rows + the account itself directly in the
    // DB. The persisted selection is now stale.
    await db
      .delete(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, acctB.accountId));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.id, acctB.id));

    // --- Reload. The self-heal effect should notice the persisted
    // selection no longer exists in `forecastData.plaidCheckingAccounts`,
    // drop it back to null, and the persistence effect should clear
    // both `?account=` and the localStorage entry. The page should
    // render the snapshot account (A) instead of an empty/zeroed view.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Account A's rows come back…
    await expect(page.getByTestId(`row-tx-${a1.id}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId(`row-tx-${a2.id}`)).toBeVisible();
    // …and the (now-deleted) B rows are gone.
    await expect(page.getByTestId(`row-tx-${b1.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`row-tx-${b2.id}`)).toHaveCount(0);

    // Chips reflect A's totals (not zeros, not B's), and the
    // Starting/Ending balance chips render real currency again because
    // we're back on the snapshot account.
    await expect(page.getByTestId("stat-money-in")).toContainText("$200.00");
    await expect(page.getByTestId("stat-money-out")).toContainText("$50.00");
    await expect(page.getByTestId("stat-net-change")).toContainText("$150.00");
    await expect(page.getByTestId("stat-starting-balance")).toContainText("$");
    await expect(page.getByTestId("stat-starting-balance")).not.toContainText(
      "Unavailable",
    );
    await expect(page.getByTestId("stat-ending-balance")).toContainText("$");
    await expect(page.getByTestId("stat-ending-balance")).not.toContainText(
      "Unavailable",
    );

    // Both persistence channels are cleared so a future reload / new
    // tab won't resurrect the stale id.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBeNull();
    await expect
      .poll(() => getStorageValue(page, "h2budget:chase-account"))
      .toBeNull();

    await context.close();
  });
});
