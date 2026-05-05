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
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #297 (per-account picker added in task #103).
 *
 * The Chase Transactions page renders a `chase-account-picker` whenever the
 * user has more than one linked checking account. Switching accounts re-
 * filters the day groups + the in/out/net chips, gates Starting/Ending
 * balance on the snapshot account (other accounts get the "Unavailable"
 * placeholder chip), and persists the selection via a `?account=` URL
 * param plus localStorage so reloads + new tabs land on the same view.
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

test.describe("Chase per-account picker (#297, covers #103)", () => {
  test("picker re-filters rows + chips, gates balance on the snapshot account, and persists across reload + localStorage", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-chase-account-picker",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // --- Direct DB seed: two linked checking accounts under the same Plaid
    // item, plus four manual rows (two on each account) in the current
    // month so the picker has both day-group rows and chip totals it can
    // re-filter when the user switches.
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
    const [acctA] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
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
        itemId: item.id,
        accountId: `e2e-acct-B-${suffix}`,
        name: "Joint Checking",
        mask: "2222",
        type: "depository",
        subtype: "checking",
      })
      .returning();

    // Anchor the bank snapshot at account A using a balance + date that
    // do NOT match any of seedAprilChase's repair triggers (no historical
    // ending value, not pinned to 2026-04-30) so the on-mount seed leaves
    // our snapshot intact. The "at" timestamp lives inside the current
    // month so anchorMonth == selectedMonth and the Starting/Ending
    // balance chips render real numbers for account A.
    const today = todayISO();
    await db.insert(forecastSettingsTable).values({
      userId,
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

    // --- Sign in and open the Chase page scoped to the current month so
    // every seeded row falls inside `monthScoped`.
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

    const picker = page.getByTestId("chase-account-picker");
    const trigger = page.getByTestId("select-chase-account");
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(trigger).toBeVisible();

    const rowA1 = page.getByTestId(`row-tx-${a1.id}`);
    const rowA2 = page.getByTestId(`row-tx-${a2.id}`);
    const rowB1 = page.getByTestId(`row-tx-${b1.id}`);
    const rowB2 = page.getByTestId(`row-tx-${b2.id}`);

    // --- Initial state: snapshot account (A) is selected, so only A's
    // rows are visible, in/out chips reflect just A's totals, and the
    // Starting/Ending balance chips render real currency values (the
    // "Unavailable" placeholder lives on a sibling branch).
    await expect(rowA1).toBeVisible({ timeout: 15_000 });
    await expect(rowA2).toBeVisible();
    await expect(rowB1).toHaveCount(0);
    await expect(rowB2).toHaveCount(0);

    const moneyIn = page.getByTestId("stat-money-in");
    const moneyOut = page.getByTestId("stat-money-out");
    const netChange = page.getByTestId("stat-net-change");
    const startingBal = page.getByTestId("stat-starting-balance");
    const endingBal = page.getByTestId("stat-ending-balance");

    await expect(moneyIn).toContainText("$200.00");
    await expect(moneyOut).toContainText("$50.00");
    await expect(netChange).toContainText("$150.00");
    await expect(startingBal).toContainText("$");
    await expect(startingBal).not.toContainText("Unavailable");
    await expect(endingBal).toContainText("$");
    await expect(endingBal).not.toContainText("Unavailable");

    // The picker's effect rewrites the URL with `?account=…` for the
    // initial selection too, so by now it should already point at A.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBe(acctA.id);
    await expect
      .poll(() => getStorageValue(page, "h2budget:chase-account"))
      .toBe(acctA.id);

    // --- Switch to account B via the picker. Day groups and chips should
    // re-filter to B-only, and Starting/Ending balance flip to the
    // "Unavailable" placeholder (no anchored balance for non-snapshot
    // accounts).
    await trigger.click();
    await page
      .getByRole("option", { name: /Joint Checking/i })
      .click();

    await expect(rowB1).toBeVisible({ timeout: 5_000 });
    await expect(rowB2).toBeVisible();
    await expect(rowA1).toHaveCount(0);
    await expect(rowA2).toHaveCount(0);

    await expect(moneyIn).toContainText("$77.00");
    await expect(moneyOut).toContainText("$33.00");
    await expect(netChange).toContainText("$44.00");
    await expect(startingBal).toContainText("Unavailable");
    await expect(endingBal).toContainText("Unavailable");

    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBe(acctB.id);
    await expect
      .poll(() => getStorageValue(page, "h2budget:chase-account"))
      .toBe(acctB.id);

    // --- Reload preserves the selection from the `?account=` URL param.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`row-tx-${b1.id}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId(`row-tx-${a1.id}`)).toHaveCount(0);
    await expect(page.getByTestId("stat-money-in")).toContainText("$77.00");
    await expect(page.getByTestId("stat-ending-balance")).toContainText(
      "Unavailable",
    );

    // --- And persists from localStorage when the URL is cleared. Drop
    // the `?account=` param entirely (keep `?month=` so we stay on the
    // same month view) and confirm the picker still lands on B.
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`row-tx-${b1.id}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId(`row-tx-${a1.id}`)).toHaveCount(0);
    // The mount effect rewrites the URL to re-add `?account=` from the
    // restored selection, so the param comes back on its own.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("account"))
      .toBe(acctB.id);

    await context.close();
  });
});
