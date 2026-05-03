import { test, expect, type Page } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

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

const clerkSecret = process.env.CLERK_SECRET_KEY!;
const clerkPub = process.env.CLERK_PUBLISHABLE_KEY!;
const clerkBackend = createClerkClient({
  secretKey: clerkSecret,
  publishableKey: clerkPub,
});

// Tracks every Clerk user we provision so afterAll can clean up.
const provisionedUserIds: string[] = [];

async function createTestUser(): Promise<{
  userId: string;
  email: string;
  password: string;
}> {
  // The "+clerk_test" suffix triggers Clerk's deterministic test-mode email
  // verification (any code submission is accepted as "424242"), which lets us
  // satisfy the new-device verification step Clerk shows after the password
  // step in test instances.
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `amex-self-heal-${suffix}+clerk_test@example.com`;
  const password = `Pw-${suffix}-${Math.random().toString(36).slice(2, 8)}!A1`;
  const user = await clerkBackend.users.createUser({
    emailAddress: [email],
    password,
    skipPasswordChecks: true,
    skipPasswordRequirement: false,
  });
  provisionedUserIds.push(user.id);
  return { userId: user.id, email, password };
}

async function signInAndOpen(
  page: Page,
  email: string,
  password: string,
  path: string,
): Promise<void> {
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[console.error]", msg.text());
  });
  await setupClerkTestingToken({ page });
  await page.goto("/sign-in");
  // Wait for Clerk.js to fully load on the SignIn page.
  await page.waitForFunction(
    () => typeof (window as unknown as { Clerk?: { loaded: boolean } }).Clerk !==
      "undefined" &&
      (window as unknown as { Clerk: { loaded: boolean } }).Clerk.loaded === true,
    null,
    { timeout: 30_000 },
  );
  // Drive the Clerk-hosted SignIn form directly. The clerk.signIn helper
  // silently no-ops against this custom-routed instance, so we use the visible
  // form fields (which carry stable accessible names) instead.
  await page
    .getByRole("textbox", { name: /email address/i })
    .fill(email);
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.getByRole("textbox", { name: /password/i }).fill(password);
  await page.getByRole("button", { name: /^continue$/i }).click();
  // Clerk test instances may insert a new-device email verification step.
  // For "+clerk_test" emails, "424242" is the deterministic accepted code.
  const codeBox = page.getByRole("textbox", {
    name: /enter verification code/i,
  });
  try {
    await codeBox.waitFor({ state: "visible", timeout: 5_000 });
    await codeBox.fill("424242");
    // Some Clerk variants auto-submit on the 6th digit; others need Continue.
    const cont = page.getByRole("button", { name: /^continue$/i });
    if (await cont.isVisible().catch(() => false)) {
      await cont.click();
    }
  } catch {
    // No verification step shown — sign-in completed in one shot.
  }
  // Wait for an active session to exist before navigating away.
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session,
      ),
    null,
    { timeout: 30_000 },
  );
  await page.goto(path);
}

test.afterAll(async () => {
  for (const id of provisionedUserIds) {
    try {
      await clerkBackend.users.deleteUser(id);
    } catch {
      // Best-effort cleanup; CI prod environment may strip the user already.
    }
  }
});

test.describe("Amex page — empty balance self-heal flow", () => {
  test("shows missing-state tile, saves an anchor, and re-renders the chip in place with 'From saved anchor'", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser();
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
    const { email, password } = await createTestUser();
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
