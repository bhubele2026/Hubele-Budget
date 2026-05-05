import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the empty Chase ending-balance tile on the
 * Dashboard (task #151). A fresh user with no linked Chase checking sees
 * the `tile-chase-ending-balance` card render the placeholder dash + the
 * "Link Chase checking to see this" hint. The secondary navigation back
 * to a self-heal surface lives on /forecast — this spec locks the
 * missing-state copy contract so a refactor can't silently change it.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Dashboard — empty Chase ending-balance tile", () => {
  test("renders the dash placeholder and the 'Link Chase checking to see this' hint for a fresh user", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "dashboard-empty-chase",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/");

    const tile = page.getByTestId("tile-chase-ending-balance");
    await expect(tile).toBeVisible({ timeout: 15_000 });

    const empty = page.getByTestId("text-chase-ending-balance-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText("—");

    const hint = page.getByTestId("text-chase-ending-balance-empty-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText("Link Chase checking to see this");

    // The populated text is hidden in the missing state so we can be sure
    // the empty branch — not a transient skeleton — is what's rendered.
    await expect(page.getByTestId("text-chase-ending-balance")).toHaveCount(0);

    // The dashboard route is mounted at "/" but wouter rewrites the URL to
    // "/dashboard" — accept either so the spec doesn't lock the routing
    // detail.
    expect(["/", "/dashboard"]).toContain(new URL(page.url()).pathname);
  });
});
