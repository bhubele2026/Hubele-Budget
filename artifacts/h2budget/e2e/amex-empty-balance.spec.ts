import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the empty Amex balance self-heal flow on /amex
 * (task #143). A user with no linked Amex debt and no saved anchor sees
 * the missing-state Ending balance tile with:
 *   - "Set Amex balance" popover trigger (data-testid="button-set-amex-balance")
 *   - Numeric input (data-testid="input-actual-balance")
 *   - Save button (data-testid="button-save-actual-balance")
 *   - Secondary link to /debts (data-testid="link-amex-debts")
 *
 * After saving a value, the chip must self-heal in-place to the populated
 * StatChip with footer "From saved anchor", and the secondary link must
 * navigate to /debts.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Amex page — empty balance self-heal flow", () => {
  test("shows missing-state tile, saves an anchor, and re-renders the chip in place with 'From saved anchor'", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "amex-self-heal",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/amex");

    // Wait for the GET /api/amex/anchor query to resolve so the tile flips
    // from the loading skeleton to the missing-state variant.
    const tile = page.getByTestId("stat-ending-balance");
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await expect(tile).toContainText("Not set");

    const setBtn = page.getByTestId("button-set-amex-balance");
    await expect(setBtn).toBeVisible();

    const link = page.getByTestId("link-amex-debts");
    await expect(link).toBeVisible();
    await expect(link).toHaveText(/or link an Amex debt in Debts/);

    // --- Primary self-heal flow ---
    await setBtn.click();

    const input = page.getByTestId("input-actual-balance");
    await expect(input).toBeVisible();
    await input.fill("1234.56");

    await page.getByTestId("button-save-actual-balance").click();

    // The chip re-renders in place — without leaving /amex — as the
    // populated StatChip variant carrying the typed value and the
    // "From saved anchor" footer.
    const populatedTile = page.getByTestId("stat-ending-balance");
    await expect(populatedTile).toContainText("$1,234.56", {
      timeout: 15_000,
    });
    await expect(populatedTile).toContainText("From saved anchor");
    await expect(populatedTile).not.toContainText("Not set");
    await expect(page.getByTestId("button-set-amex-balance")).toHaveCount(0);
    await expect(page.getByTestId("link-amex-debts")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/amex");

    await context.close();
  });

  test("the secondary 'or link an Amex debt in Debts' link navigates to /debts", async ({
    browser,
  }) => {
    // A fresh user is needed because the first test's save flips the
    // tile out of the missing state, hiding the secondary link.
    const { email, password } = await createTestUser(
      "amex-self-heal",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/amex");

    const link = page.getByTestId("link-amex-debts");
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute("href", "/debts");

    await link.click();

    await page.waitForURL("**/debts", { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe("/debts");
    // Sanity check the Debts page actually rendered (not a 404 / blank shell).
    await expect(page.locator("body")).toContainText(/debt/i);

    await context.close();
  });
});
