import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the empty /debts page contract (task #151). A
 * fresh user with no debts sees the "No debts recorded. You're debt free!"
 * empty state. /debts is also the secondary navigation target referenced
 * by /amex's "or link an Amex debt in Debts" link (covered in
 * amex-empty-balance.spec.ts), so this spec locks the destination's
 * empty-state UX contract so that link can't land on a broken or blank
 * shell after a refactor.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Debts page — empty-state contract", () => {
  test("renders the page heading and the 'No debts recorded. You're debt free!' empty state for a fresh user", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "debts-empty",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/debts");

    await expect(
      page.getByRole("heading", { name: /debt avalanche/i }),
    ).toBeVisible({ timeout: 15_000 });

    const empty = page.getByTestId("text-debts-empty-state");
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText("No debts recorded. You're debt free!");

    expect(new URL(page.url()).pathname).toBe("/debts");

    await context.close();
  });
});
