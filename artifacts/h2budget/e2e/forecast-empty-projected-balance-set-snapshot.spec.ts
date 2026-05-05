import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #99's empty-state "Set bank snapshot"
 * affordance inside the Projected Balance area chart on /forecast.
 *
 * A fresh user with no Plaid checking, no manual bank snapshot, and no
 * planned items lands in the chart's missing-state branch
 * (`data-testid="empty-projected-balance"`). That branch renders a
 * `Set bank snapshot` button (`button-empty-set-bank-snapshot`) which
 * opens the same snapshot dialog (`input-snapshot` + `button-save-snapshot`)
 * as the bank-balance tile. After saving, the cash-projection refetch
 * must populate `dailySeries`, the empty nudge must disappear, and the
 * AreaChart must render — all without a manual page reload or navigation.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Forecast Projected Balance empty-state set-snapshot (#99)", () => {
  test("clicking the empty-state Set bank snapshot button saves a balance and renders the chart in place", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-empty-projbal-99",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");

    // The Projected Balance card mounts after the GET /api/forecast query
    // resolves. A fresh user has no snapshot + no planned items, so the
    // chart card flips to the empty-state branch.
    const chartCard = page.getByTestId("card-projected-balance-chart");
    await expect(chartCard).toBeVisible({ timeout: 15_000 });

    const emptyState = page.getByTestId("empty-projected-balance");
    await expect(emptyState).toBeVisible({ timeout: 15_000 });
    await expect(emptyState).toContainText(
      /set a bank snapshot or add planned items/i,
    );

    const setBtn = page.getByTestId("button-empty-set-bank-snapshot");
    await expect(setBtn).toBeVisible();
    await expect(setBtn).toHaveText(/Set bank snapshot/);

    // --- Open the snapshot dialog from the empty-state nudge ---
    await setBtn.click();

    const input = page.getByTestId("input-snapshot");
    await expect(input).toBeVisible();
    await input.fill("2500.00");

    await page.getByTestId("button-save-snapshot").click();

    // The dialog closes itself on success.
    await expect(page.getByTestId("input-snapshot")).toHaveCount(0, {
      timeout: 15_000,
    });

    // The chart self-heals in place: the empty nudge unmounts and the
    // AreaChart (a real <svg>) renders inside the same card — no manual
    // reload required.
    await expect(page.getByTestId("empty-projected-balance")).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(chartCard.locator("svg.recharts-surface")).toBeVisible({
      timeout: 15_000,
    });

    // The save must not have navigated away from /forecast.
    expect(new URL(page.url()).pathname).toBe("/forecast");
  });
});
