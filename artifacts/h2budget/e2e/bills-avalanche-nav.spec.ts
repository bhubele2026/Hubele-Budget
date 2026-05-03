import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Bills → Avalanche navigation (#76)", () => {
  test("Bills page loads and debt-min rows link to /avalanche?focus=", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "bills-ava-nav",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/bills");

    await expect(
      page.getByRole("heading", { name: /bills/i }),
    ).toBeVisible({ timeout: 15_000 });

    expect(new URL(page.url()).pathname).toBe("/bills");

    const debtRows = page.locator('[data-testid^="row-debt-min-"]');
    const count = await debtRows.count();

    if (count > 0) {
      const firstRow = debtRows.first();
      const testId = await firstRow.getAttribute("data-testid");
      const debtId = testId?.replace("row-debt-min-", "") ?? "";

      await firstRow.click();

      await page.waitForURL(/\/avalanche\?focus=/, { timeout: 10_000 });

      const url = new URL(page.url());
      expect(url.pathname).toBe("/avalanche");
      expect(url.searchParams.get("focus")).toBe(debtId);

      await expect(
        page.getByRole("heading", { name: /debt avalanche/i }),
      ).toBeVisible({ timeout: 15_000 });
    }

    await context.close();
  });
});
