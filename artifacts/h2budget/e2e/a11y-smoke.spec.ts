import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (Phase 6) Accessibility smoke test. For a freshly provisioned user we sign
 * in, open each of the app's key pages, and run axe-core against the rendered
 * DOM. The contract is intentionally narrow: zero *critical* and *serious*
 * violations on each page. We do not gate on "moderate"/"minor" findings
 * (color-contrast on muted captions, decorative landmarks, etc.) so the smoke
 * test stays a high-signal regression guard rather than a noisy lint.
 *
 * Pages are scanned with an empty household — every page renders its shell,
 * headings, and primary controls without seeded data, which is exactly the
 * surface a11y regressions (missing accessible names, untitled dialogs,
 * unlabeled inputs) show up on. We wait for the shared <main> landmark plus a
 * network-idle settle so axe scans steady-state DOM rather than a loading
 * shell.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const PAGES = [
  "/home",
  "/reports",
  "/transactions",
  "/mapping-rules",
  "/budget",
  "/bills",
  "/debts",
];

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  // Surface a readable summary on failure: rule id, impact, and the first
  // offending selectors for each blocking violation.
  const summary = blocking
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help} (${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(", ")})`,
    )
    .join("\n");
  expect(blocking, summary || "no critical/serious violations").toEqual([]);
}

test.describe("a11y smoke (Phase 6)", () => {
  test("key pages have zero critical/serious axe violations", async ({
    browser,
  }) => {
    test.slow();
    const { email, password } = await createTestUser(
      "a11y-smoke-phase6",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    // First navigation also performs the Clerk sign-in handshake.
    await signInAndOpen(page, email, password, PAGES[0]);

    for (const path of PAGES) {
      await page.goto(path);
      // The shared app shell renders a single <main> landmark on every
      // protected route; waiting on it proves the page component mounted.
      await expect(page.locator("main")).toBeVisible({ timeout: 20_000 });
      // Let post-mount async chrome (skeleton swaps, query resolution,
      // toasts) settle so we scan the steady-state DOM.
      await page.waitForLoadState("networkidle").catch(() => {});
      await scan(page);
    }

    await context.close();
  });
});
