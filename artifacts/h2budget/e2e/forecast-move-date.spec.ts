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

test.describe("Forecast move-to date picker (#107)", () => {
  test("forecast page renders and shows the rescheduled overrides panel when applicable", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-move",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/forecast");

    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

    const moveButtons = page.locator('[data-testid^="move-plan-"]');
    const moveCount = await moveButtons.count();

    if (moveCount > 0) {
      await moveButtons.first().click();

      const dateInput = page.locator('input[type="date"]');
      await expect(dateInput).toBeVisible({ timeout: 5_000 });

      const cancelButton = page.getByRole("button", { name: /cancel/i });
      if (await cancelButton.isVisible()) {
        await cancelButton.click();
      }
    }

    const rescheduledPanel = page.getByTestId("rescheduled-bucket-panel");
    const panelExists = await rescheduledPanel.count();

    if (panelExists > 0) {
      await expect(rescheduledPanel).toBeVisible();

      const undoButtons = rescheduledPanel.locator('[data-testid^="rescheduled-undo-"]');
      const undoCount = await undoButtons.count();
      expect(undoCount).toBeGreaterThanOrEqual(1);
    }

    await context.close();
  });
});
