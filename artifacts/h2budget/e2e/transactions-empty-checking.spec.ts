import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the missing-checking tile contract on
 * /transactions (task #151). A fresh user with no linked checking sees the
 * Starting balance and Ending balance chips render in the
 * `StatChipUnavailable` variant with the "Connect a checking account to see
 * the balance." hint, alongside the secondary "Connect a bank" Plaid action
 * in the page header.
 *
 * No save action exists for this tile yet — saving lives on /forecast — so
 * this spec locks the missing-state controls and the secondary navigation
 * affordance per the task brief, leaving room for a future save-in-place
 * flow to extend it.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Transactions page — empty checking missing-state tiles", () => {
  test("renders Unavailable Starting/Ending balance chips with the connect-checking hint and a secondary 'Connect a bank' action", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-empty-checking",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/transactions");

    const startingTile = page.getByTestId("stat-starting-balance");
    await expect(startingTile).toBeVisible({ timeout: 15_000 });
    await expect(startingTile).toContainText("Unavailable");
    await expect(startingTile).toContainText(
      "Connect a checking account to see the balance.",
    );

    const endingTile = page.getByTestId("stat-ending-balance");
    await expect(endingTile).toBeVisible();
    await expect(endingTile).toContainText("Unavailable");
    await expect(endingTile).toContainText(
      "Connect a checking account to see the balance.",
    );

    // Secondary navigation: the "Connect a bank" Plaid action must remain
    // visible in the page header so users can self-heal by linking an
    // account, even though the in-tile self-heal save flow lives on
    // /forecast (covered by forecast-empty-bank-snapshot.spec.ts).
    await expect(
      page.getByRole("button", { name: /connect a bank/i }),
    ).toBeVisible();

    expect(new URL(page.url()).pathname).toBe("/transactions");

    await context.close();
  });
});
