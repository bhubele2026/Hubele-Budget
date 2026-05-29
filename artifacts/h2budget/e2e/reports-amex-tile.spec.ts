import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * Browser-level coverage for the second balance tile atop /reports — the
 * "Amex (Blue Cash + Platinum)" tile computed by
 * `resolveAmexRevolvingBalance` (unit-tested in
 * src/lib/reportsBalances.test.ts).
 *
 * (#875) The tile used to sum card balances from the household DEBTS list
 * by name, so a "Capital One Platinum" debt (••4321, $6,560.84) matched
 * the `/platinum/i` matcher and was reported as the Amex total. The fix
 * repoints the tile at the actual Amex card accounts (the Plaid
 * liability-accounts source) with an Amex issuer guard. This spec seeds
 * that new source directly in the DB and verifies the browser tile:
 *
 *   - equals the sum of the two revolving Amex cards (Blue Cash ••1006 +
 *     Platinum ••1009), and is NOT the $6,560.84 Capital One balance,
 *   - derives its sub-line from the real cards/masks found,
 *   - never folds in "Delta SkyMiles Gold" (a charge card that also ends
 *     1009) nor the Capital One Platinum row, and
 *   - still leaves the Capital One Platinum debt untouched on /debts.
 *
 * The HeroTile component has no test id, so the tile is located by its
 * label text inside the rounded card wrapper.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db.delete(debtsTable).where(eq(debtsTable.userId, userId));
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

function amexTile(page: import("@playwright/test").Page) {
  return page
    .locator("div.rounded-2xl")
    .filter({ hasText: "Amex (Blue Cash + Platinum)" });
}

type SeedAcct = {
  name: string;
  mask: string;
  balance: string | null;
};

// Insert a set of Amex credit-card liability accounts under a single
// "American Express" Plaid item. Setting `liabilityLastFetchedAt` keeps
// the GET /plaid/liability-accounts route from attempting a live Plaid
// refresh (it only fetches when no cached liability rows exist).
async function seedAmexLiabilityAccounts(
  userId: string,
  householdId: string,
  accts: SeedAcct[],
): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId,
      householdId,
      itemId: `e2e-amex-item-${suffix}`,
      accessToken: "e2e-no-access",
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  for (const [idx, a] of accts.entries()) {
    await db.insert(plaidAccountsTable).values({
      userId,
      householdId,
      itemId: item.id,
      accountId: `e2e-amex-acct-${suffix}-${idx}`,
      name: a.name,
      mask: a.mask,
      type: "credit",
      subtype: "credit card",
      liabilityKind: "credit_card",
      liabilityBalance: a.balance,
      liabilityLastFetchedAt: new Date(),
    });
  }
}

test.describe("Reports — Amex (Blue Cash + Platinum) balance tile", () => {
  test("sums the two Amex cards, excludes Delta + Capital One Platinum, and is not $6,560.84", async ({
    page,
  }) => {
    const { userId, email, password } = await createTestUser(
      "reports-amex-both",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // Seed the two revolving Amex cards plus the Delta charge card (also
    // ending 1009) in the Amex-scoped account source.
    await seedAmexLiabilityAccounts(userId, householdId, [
      { name: "Blue Cash Preferred Card", mask: "1006", balance: "100.00" },
      { name: "Platinum Card", mask: "1009", balance: "250.50" },
      { name: "Delta SkyMiles Gold Card", mask: "1009", balance: "9999.00" },
    ]);

    // The historical bug source: a Capital One "Platinum" DEBT worth
    // $6,560.84. It must stay on /debts and NEVER reach the Amex tile.
    await db.insert(debtsTable).values({
      userId,
      householdId,
      name: "Capital One Platinum",
      balance: "6560.84",
      status: "active",
      apr: "0.2499",
      minPayment: "120.00",
    });

    await signInAndOpen(page, email, password, "/sign-in");
    await page.goto("/reports");

    const tile = amexTile(page);
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await expect(tile).toContainText("Amex (Blue Cash + Platinum)");

    // 100.00 + 250.50 = 350.50; neither Delta's 9999 nor Capital One's
    // 6,560.84 may be folded in.
    await expect(tile).toContainText("$350.50");
    await expect(tile).not.toContainText("9,999");
    await expect(tile).not.toContainText("6,560.84");
    await expect(tile).not.toContainText("$10,099.50");

    // Sub-line is derived from the real cards/masks actually found.
    await expect(tile).toContainText("Blue Cash ••1006 + Platinum ••1009");
    await expect(tile).not.toContainText("card unavailable");

    // The Capital One Platinum debt is untouched on /debts.
    await page.goto("/debts");
    await expect(
      page.getByText("Capital One Platinum", { exact: false }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("shows the '(1 card unavailable)' subnote when only one card has a usable balance", async ({
    page,
  }) => {
    const { userId, email, password } = await createTestUser(
      "reports-amex-partial",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // Both Amex cards exist in the account source, but Blue Cash has no
    // usable balance → it is "present but unavailable". Delta is seeded
    // again to confirm it is never mistaken for Platinum.
    await seedAmexLiabilityAccounts(userId, householdId, [
      { name: "Blue Cash Preferred Card", mask: "1006", balance: null },
      { name: "Platinum Card", mask: "1009", balance: "420.00" },
      { name: "Delta SkyMiles Gold Card", mask: "1009", balance: "500.00" },
    ]);

    await signInAndOpen(page, email, password, "/sign-in");
    await page.goto("/reports");

    const tile = amexTile(page);
    await expect(tile).toBeVisible({ timeout: 15_000 });

    // Only Platinum is available → its balance is shown, Delta excluded.
    await expect(tile).toContainText("$420.00");
    await expect(tile).not.toContainText("$500.00");

    // Blue Cash is present but has no usable balance → partial subnote.
    await expect(tile).toContainText(
      "Blue Cash ••1006 + Platinum ••1009 (1 card unavailable)",
    );
  });
});
