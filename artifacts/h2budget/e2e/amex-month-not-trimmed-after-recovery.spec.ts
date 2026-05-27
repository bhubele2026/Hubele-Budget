import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * Regression coverage for task #755.
 *
 * Task #754 fixed the regression where /amex truncated mid-month because
 * the window virtualizer's size estimates were too low AND were not
 * invalidated when the underlying transaction set changed mid-session
 * (e.g. a recovery / sync import landed while the user was already on
 * the page). The fix in `VirtualizedDayGroups` calls
 * `virtualizer.measure()` whenever `groups.length` or `totalRowCount`
 * changes, but there is no automated coverage for the mid-session case —
 * a future refactor that removes that effect would silently re-introduce
 * the bug and only show up as user reports of "the bottom of the month
 * disappeared after Plaid synced".
 *
 * This spec covers both halves of the fix end-to-end:
 *   1. Seed a partial month (days 10–25 only) and open /amex pinned to
 *      that month. Scroll the window virtualizer all the way to the
 *      bottom and assert the oldest seeded day-group is reachable.
 *   2. Simulate a recovery batch landing mid-session by inserting days
 *      1–9 of the same month directly into the DB, then forcing the
 *      list query to refetch (without a page reload, which would reset
 *      the virtualizer and hide the bug). Assert the txn-count chip
 *      updates to reflect the new total, and that scrolling to the
 *      bottom now reveals the new oldest day-group (day 1).
 *
 * Pre-fix, the virtualizer would still trust its cached per-item size
 * estimates for the originally-seeded groups, and the freshly-inserted
 * groups at the top wouldn't be enough to shift the bottom into view —
 * the oldest day would silently remain unrendered no matter how far the
 * user scrolled.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, userId));
    } catch {
      // best-effort
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

function formatDayHeader(isoDate: string): string {
  // Matches `formatDayHeader` in
  // artifacts/h2budget/src/components/account-page/day-group.tsx so the
  // assertion below matches the exact text rendered in the DOM.
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// `VirtualizedDayGroups` uses `useWindowVirtualizer`, which reads from
// `window.scrollY` and listens to scroll events on the window. The app
// shell's `<main>` is a `flex-1 min-h-0 overflow-y-auto` scroller and
// its outer wrapper is `h-screen overflow-hidden`, which means the
// document never scrolls in the running app — yet the virtualizer
// only refines its rendered window in response to *window* scroll. To
// reliably drive that virtualizer from a test, neutralize the shell's
// internal scroll container so the document becomes the natural
// scroller for this single test page; `window.scrollTo` then exercises
// the same code path the production virtualizer relies on.
async function makeWindowScrollable(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addStyleTag({
    content: `
      .h-screen { height: auto !important; min-height: 100vh; }
      .overflow-hidden { overflow: visible !important; }
      main { overflow: visible !important; height: auto !important; }
    `,
  });
}

// Loop until the locator we care about lands in the DOM — each pass
// lets `measureElement` correct each rendered group's cached size,
// shrinking the estimated `getTotalSize()` toward the real scroll
// height and bringing the oldest day-group into the virtual window.
async function scrollToBottomUntilVisible(
  page: import("@playwright/test").Page,
  locator: import("@playwright/test").Locator,
  maxIterations: number,
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" }),
    );
    await page.waitForTimeout(200);
    if (await locator.count()) return;
  }
}

test.describe("/amex stays scrollable after a mid-session recovery import (#755)", () => {
  test("oldest day-group remains reachable after new rows land without a page refresh", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "amex-month-not-trimmed-after-recovery-755",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // Use a fixed past month so the seeded day count is deterministic
    // regardless of when this spec runs and so we never collide with
    // the page's auto-scroll-to-today behaviour.
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const year = target.getFullYear();
    const month0 = target.getMonth();
    const monthIso = `${year}-${pad2(month0 + 1)}-01`;

    // Phase 1 seeds days 1–10 (10 single-row groups, oldest half of the
    // month). The virtualizer's per-item size cache will be populated
    // for indices 0–9 against these small groups.
    //
    // Phase 2 then prepends days 11–25 (15 groups, FIVE rows each) at
    // the top of the list — pushing the originally-cached groups down
    // to indices 15–24 and putting freshly-introduced, much taller
    // groups at indices 0–14. This is exactly the index-shifting,
    // height-changing scenario that #755 protects against: without
    // `virtualizer.measure()`, the cached "tiny" sizes from Phase 1
    // would still apply to indices 0–9, making `getTotalSize()` short
    // by thousands of pixels and silently truncating the new oldest
    // day-group (day 1) below the bottom of the rendered window.
    const initialDays: number[] = [];
    for (let day = 1; day <= 10; day++) initialDays.push(day);
    const recoveryDays: number[] = [];
    for (let day = 11; day <= 25; day++) recoveryDays.push(day);

    const suffix = Math.random().toString(36).slice(2, 8);
    const rowsFor = (days: number[], rowsPerDay: number) =>
      days.flatMap((day) =>
        Array.from({ length: rowsPerDay }, (_, i) => {
          const iso = `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
          return {
            userId,
            householdId,
            occurredOn: iso,
            occurredAt: new Date(
              `${iso}T${pad2(8 + i)}:00:00Z`,
            ).toISOString(),
            description: `E2E-AMEX-755-${suffix.toUpperCase()}-D${pad2(day)}-R${i}`,
            amount: `${10 + day + i}.00`,
            source: "amex" as const,
          };
        }),
      );

    // 10 single-row groups (small) → cached sizes are small.
    await db.insert(transactionsTable).values(rowsFor(initialDays, 1));

    // Constrained viewport — the virtualizer's behaviour is most
    // visible when the list cannot all fit on screen at once.
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
    });
    const page = await context.newPage();
    await signInAndOpen(page, email, password, `/amex?month=${monthIso}`);
    await makeWindowScrollable(page);

    // ---- Phase 1: confirm the originally-seeded month renders end-to-end.
    await expect(
      page.getByText(/10 of 10 txns/i),
    ).toBeVisible({ timeout: 20_000 });

    const initialOldestIso = `${year}-${pad2(month0 + 1)}-${pad2(initialDays[0])}`;
    const initialNewestIso = `${year}-${pad2(month0 + 1)}-${pad2(initialDays[initialDays.length - 1])}`;

    await expect(
      page.getByText(formatDayHeader(initialNewestIso), { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });

    const initialOldestHeader = page
      .getByText(formatDayHeader(initialOldestIso), { exact: false })
      .first();
    // The app's scroll container is `<main>` (h-screen + overflow-y-auto
    // in `components/layout.tsx`). Drive `main.scrollTop` *and* dispatch
    // a window scroll event so `useWindowVirtualizer` re-evaluates its
    // visible window — the virtualizer listens to window scroll and
    // computes positions against `window.scrollY`, so moving only main
    // wouldn't unlock the next batch. Looping a few times lets
    // `measureElement` correct each rendered group's cached size, which
    // shrinks the estimated totalSize toward the real scroll height and
    // brings the oldest day-group into the virtual window.
    await scrollToBottomUntilVisible(page, initialOldestHeader, 40);
    await expect(initialOldestHeader).toBeVisible({ timeout: 10_000 });

    // ---- Phase 2: recovery batch lands mid-session.
    //
    // Insert the missing newer half of the month (days 11–25, FIVE
    // rows per day) directly into the DB, then force the already-
    // mounted page's transactions query to refetch via the queryClient
    // exposed on `window`. Crucially we do NOT reload the page — a
    // reload would unmount `VirtualizedDayGroups` and re-create the
    // virtualizer from scratch, which masks the very bug #755 guards
    // against: stale per-item size caches that weren't invalidated
    // when much taller groups were prepended.
    await db.insert(transactionsTable).values(rowsFor(recoveryDays, 5));

    const invalidated = await page.evaluate(() => {
      const qc = (window as unknown as { __qc?: { invalidateQueries: (a: { queryKey: unknown[] }) => Promise<void> } }).__qc;
      if (!qc) return false;
      void qc.invalidateQueries({ queryKey: ["/api/transactions"] });
      return true;
    });
    expect(invalidated).toBe(true);

    // The chip flips to 85 of 85 (10 single-row + 15 five-row groups)
    // once the refetch resolves with the expanded result set — proof
    // that the page actually saw the new rows, not just that the DB
    // was updated.
    await expect(
      page.getByText(/85 of 85 txns/i),
    ).toBeVisible({ timeout: 20_000 });

    // Day 1 (the originally-seeded oldest day, now pushed to the
    // bottom of the list by the prepended taller recovery groups) must
    // still be reachable. Pre-fix, the virtualizer's cached "tiny"
    // sizes from Phase 1 still apply to indices 0–9 — which are now
    // the much taller recovery groups — making `getTotalSize()` short
    // of the real scroll height so the day-1 header never enters the
    // rendered window no matter how far the user scrolls.
    const listOldestIso = `${year}-${pad2(month0 + 1)}-01`;
    const listOldestHeader = page
      .getByText(formatDayHeader(listOldestIso), { exact: false })
      .first();

    await scrollToBottomUntilVisible(page, listOldestHeader, 60);
    await expect(listOldestHeader).toBeVisible({ timeout: 10_000 });

    // The row-cap banner must NOT be the explanation here — 85 rows is
    // well below the 1000-row month cap.
    await expect(page.getByTestId("text-month-cap-hit")).toHaveCount(0);

    await context.close();
  });
});
