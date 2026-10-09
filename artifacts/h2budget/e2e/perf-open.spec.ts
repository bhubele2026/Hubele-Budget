import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * Fast-open guard: opening the app must not pull the charts vendor bundle
 * before the document has loaded, and must not pull a transaction LEDGER.
 *
 * (C11, 2026-10-09) THE LANDING IS NOW THE DASHBOARD. The old landing was a door
 * that rendered from one aggregate and requested no transactions at all. The
 * dashboard's Spending and Activity panels read two BOUNDED transaction windows
 * (CLAUDE.md section 2: `from`/`to` and a small `limit`, never the banned
 * `limit=5000` pull), and its forecast panel lazy-loads the chart chunk once the
 * cash signal answers. So the contract changes with the page, and keeps its
 * point:
 *
 * - vendor-charts-*.js must NOT be requested during the open window
 *   (navigation -> app shell interactive -> document `load`). It may load right
 *   after, when the forecast panel's data arrives: that is lazy by design.
 * - /api/transactions may fire on /home, but only as bounded list reads: every
 *   request carries `from`, `to` and a `limit` of at most 100, and there are no
 *   more than two of them (Spending, Activity). Idle warming still only imports
 *   route chunks.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("perf: app open stays light", () => {
  test("/home requests no vendor-charts chunk during open and only bounded /api/transactions reads", async ({
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

    // Let idle prefetch and any straggler fetches settle, then confirm the only
    // transaction reads were the dashboard's two bounded windows.
    await page.waitForLoadState("networkidle");
    expect(
      transactionRequests.length,
      `at most two bounded /api/transactions reads on /home; saw:\n${transactionRequests.join("\n")}`,
    ).toBeLessThanOrEqual(2);
    for (const url of transactionRequests) {
      const q = new URL(url).searchParams;
      expect(q.get("from"), `unbounded read (no from): ${url}`).toBeTruthy();
      expect(q.get("to"), `unbounded read (no to): ${url}`).toBeTruthy();
      expect(Number(q.get("limit")), `unbounded read (limit): ${url}`).toBeGreaterThan(0);
      expect(Number(q.get("limit")), `read too large: ${url}`).toBeLessThanOrEqual(100);
    }

    await context.close();
  });
});
