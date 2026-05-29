import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";
import { seedDebt } from "./helpers/api";

/**
 * Browser-level coverage for the second balance tile atop /reports — the
 * "Amex (Blue Cash + Platinum)" tile introduced in task #839 and computed by
 * `resolveAmexRevolvingBalance` (unit-tested in
 * src/lib/reportsBalances.test.ts). The helper math is well covered, but this
 * spec verifies the tile actually renders against real seeded debt data:
 *
 *   - the combined total when BOTH revolving Amex cards are present,
 *   - the "Blue Cash 1006 + Platinum 1009" sub-line,
 *   - the "(1 card unavailable)" partial-result subnote when exactly one card
 *     has a usable balance, and
 *   - that "Delta SkyMiles Gold" (a charge card that ALSO ends 1009) is never
 *     folded into the value.
 *
 * The HeroTile component has no test id, so the tile is located by its label
 * text inside the rounded card wrapper.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

function amexTile(page: import("@playwright/test").Page) {
  return page
    .locator("div.rounded-2xl")
    .filter({ hasText: "Amex (Blue Cash + Platinum)" });
}

test.describe("Reports — Amex (Blue Cash + Platinum) balance tile", () => {
  test("renders the combined total of both cards and excludes Delta SkyMiles Gold", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "reports-amex-both",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/sign-in");

    // Seed both revolving Amex cards plus the Delta charge card (which also
    // ends 1009) to prove the helper distinguishes them by name, not mask.
    await seedDebt(page, {
      name: "Amex Blue Cash Preferred",
      balance: "100.00",
    });
    await seedDebt(page, { name: "Amex Platinum Card", balance: "250.50" });
    await seedDebt(page, {
      name: "Amex Delta SkyMiles Gold",
      balance: "9999.00",
    });

    await page.goto("/reports");

    const tile = amexTile(page);
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await expect(tile).toContainText("Amex (Blue Cash + Platinum)");

    // 100.00 + 250.50 = 350.50; Delta's 9999.00 must NOT be folded in.
    await expect(tile).toContainText("$350.50");
    await expect(tile).not.toContainText("9,999");
    await expect(tile).not.toContainText("$10,099.50");

    // Both cards present → plain sub-line with no partial-result subnote.
    await expect(tile).toContainText("Blue Cash 1006 + Platinum 1009");
    await expect(tile).not.toContainText("1 card unavailable");
  });

  test("shows the '(1 card unavailable)' subnote when only one card has a usable balance", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "reports-amex-partial",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/sign-in");

    // Only the Platinum card has a usable balance; Blue Cash is absent, so the
    // tile should show Platinum's balance and flag one card as unavailable.
    // Delta is seeded again to confirm it is never mistaken for Platinum.
    await seedDebt(page, { name: "Amex Platinum Card", balance: "420.00" });
    await seedDebt(page, {
      name: "Amex Delta SkyMiles Gold",
      balance: "500.00",
    });

    await page.goto("/reports");

    const tile = amexTile(page);
    await expect(tile).toBeVisible({ timeout: 15_000 });

    // Only Platinum is available → its balance is shown, Delta excluded.
    await expect(tile).toContainText("$420.00");
    await expect(tile).not.toContainText("$500.00");

    // Exactly one usable card → partial-result subnote appears.
    await expect(tile).toContainText(
      "Blue Cash 1006 + Platinum 1009 (1 card unavailable)",
    );
  });
});
