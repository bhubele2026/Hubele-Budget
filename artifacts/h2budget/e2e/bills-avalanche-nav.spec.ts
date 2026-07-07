import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";
import { seedDebt } from "./helpers/api";

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Bills → Avalanche navigation (#76)", () => {
  test("Bills page loads and debt-min rows link to /avalanche?focus=", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "bills-ava-nav",
      provisionedUserIds,
    );

    // Sign in first so `page.request` carries the Clerk session cookie,
    // then seed a debt via API so the Bills page is guaranteed to render
    // a debt-min row to click. Without this the spec would degrade into
    // a no-op for fresh users with no data.
    await signInAndOpen(page, email, password, "/bills");
    const debt = await seedDebt(page);

    // Re-open Bills so the freshly-seeded debt is included in the page's
    // initial query payload (the page only refetches on its own clock).
    await page.goto("/bills");

    await expect(
      page.getByRole("heading", { name: /bills/i }),
    ).toBeVisible({ timeout: 15_000 });

    expect(new URL(page.url()).pathname).toBe("/bills");

    const row = page.getByTestId(`row-debt-min-${debt.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.click();

    await page.waitForURL(/\/avalanche\?focus=/, { timeout: 10_000 });

    const url = new URL(page.url());
    expect(url.pathname).toBe("/avalanche");
    expect(url.searchParams.get("focus")).toBe(debt.id);

    await expect(
      page.getByRole("heading", { name: /^future goal$/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
