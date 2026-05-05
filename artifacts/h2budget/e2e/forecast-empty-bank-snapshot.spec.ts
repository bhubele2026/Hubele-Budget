import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the empty bank-snapshot self-heal flow on /forecast
 * (task #151). A fresh user with no linked Plaid checking and no manual
 * snapshot sees the missing-state Bank balance tile with:
 *   - "No snapshot — using starting balance" subtext
 *     (data-testid="text-bank-snapshot-meta")
 *   - "Set manually" button (data-testid="button-set-bank-snapshot")
 *   - Dialog with numeric input (data-testid="input-snapshot")
 *   - Save button (data-testid="button-save-snapshot")
 *
 * After saving a value, the bank-balance chip must self-heal in-place
 * (without navigation) to the populated state — the typed amount renders
 * in `text-bank-balance` and the meta line flips to "Manual · …".
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Forecast page — empty bank snapshot self-heal flow", () => {
  test("shows missing-state Bank balance tile, saves a snapshot, and re-renders in place with 'Manual · …'", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-bank-self-heal",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");

    // Wait for the GET /api/forecast query to resolve so the card flips
    // from the loading skeleton to the missing-state variant.
    const card = page.getByTestId("card-bank-snapshot");
    await expect(card).toBeVisible({ timeout: 15_000 });

    const meta = page.getByTestId("text-bank-snapshot-meta");
    await expect(meta).toBeVisible();
    await expect(meta).toHaveText(/No snapshot — using starting balance/);

    const setBtn = page.getByTestId("button-set-bank-snapshot");
    await expect(setBtn).toBeVisible();
    await expect(setBtn).toHaveText(/Set manually/);

    // --- Primary self-heal flow ---
    await setBtn.click();

    const input = page.getByTestId("input-snapshot");
    await expect(input).toBeVisible();
    await input.fill("4321.99");

    await page.getByTestId("button-save-snapshot").click();

    // The same card re-renders in place — without leaving /forecast — with
    // the typed value and the "Manual · …" meta line. The Save dialog
    // closes itself on success.
    await expect(page.getByTestId("input-snapshot")).toHaveCount(0, {
      timeout: 15_000,
    });

    const populatedCard = page.getByTestId("card-bank-snapshot");
    await expect(populatedCard).toContainText("$4,321.99", {
      timeout: 15_000,
    });

    const populatedMeta = page.getByTestId("text-bank-snapshot-meta");
    await expect(populatedMeta).toContainText("Manual");
    await expect(populatedMeta).not.toContainText(
      "No snapshot — using starting balance",
    );

    // Self-heal must not have navigated away.
    expect(new URL(page.url()).pathname).toBe("/forecast");

    // The "Set manually" trigger remains available so the user can edit
    // the saved value later — that's the same affordance, but the chip
    // is now populated rather than missing-state.
    await expect(page.getByTestId("button-set-bank-snapshot")).toBeVisible();
  });
});
