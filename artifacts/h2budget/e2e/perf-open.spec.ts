import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (PR A2) Fast-open guard: opening the app must not pull the charts vendor
 * bundle or any transaction rows.
 *
 * - vendor-charts-*.js must NOT be requested during the open window
 *   (navigation → app shell interactive). After the shell is up, the layout's
 *   requestIdleCallback route-warming deliberately prefetches /forecast and
 *   /avalanche chunks — which DO import vendor-charts — so the assertion is
 *   scoped to the open window, not "ever". That background prefetch is the
 *   design (instant first click into charts), not a regression.
 * - /api/transactions must not fire AT ALL on /home, including through
 *   network-idle: the landing renders from aggregates, and idle warming only
 *   imports route chunks, never transaction data.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("perf: app open stays light", () => {
  test("/home requests no vendor-charts chunk and no /api/transactions", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "perf-open",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    const chartChunkRequests: string[] = [];
    const transactionRequests: string[] = [];
    let openWindowClosed = false;
    page.on("request", (request) => {
      const url = request.url();
      if (!openWindowClosed && /vendor-charts-[^/]*\.js/.test(url)) {
        chartChunkRequests.push(url);
      }
      if (new URL(url).pathname.startsWith("/api/transactions")) {
        transactionRequests.push(url);
      }
    });

    // Sign in and land on /home (listener is attached before any navigation,
    // so the sign-in pages are covered by the no-charts window too).
    await signInAndOpen(page, email, password, "/home");

    // Open window = until the shared app shell's <main> landmark is visible
    // and the document has fired `load`.
    await expect(page.getByRole("main")).toBeVisible();
    await page.waitForLoadState("load");
    openWindowClosed = true;

    expect(
      chartChunkRequests,
      `vendor-charts must not load during app open; saw:\n${chartChunkRequests.join("\n")}`,
    ).toEqual([]);

    // Let idle prefetch and any straggler fetches settle, then confirm no
    // transaction pull happened at any point.
    await page.waitForLoadState("networkidle");
    expect(
      transactionRequests,
      `/api/transactions must never fire on /home; saw:\n${transactionRequests.join("\n")}`,
    ).toEqual([]);

    await context.close();
  });
});
