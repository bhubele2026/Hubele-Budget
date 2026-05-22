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
 * Regression coverage for task #744.
 *
 * The /amex page virtualizes its day-groups via `VirtualizedDayGroups`.
 * Before the fix, the 24px inter-group gap was rendered with a tailwind
 * `space-y-6` (margin) on the parent — and `getBoundingClientRect`
 * (which `measureElement` uses) does NOT include outer margin in each
 * item's measured height. The virtualizer's `getTotalSize()` therefore
 * undershot the real rendered scroll height by `24 * (groups.length - 1)`
 * pixels. As the user scrolled toward the bottom of a month with many
 * day-groups, the virtualizer believed it had passed end-of-list and
 * stopped revealing items, leaving the oldest several days unrendered.
 *
 * To reliably reproduce that cumulative undercount we need many
 * day-groups in a single month — three rows would still fit inside any
 * viewport regardless of the bug. This spec therefore seeds 25
 * consecutive days in a fixed past month, navigates to /amex with
 * `?month=...` pinned to that month, forces a short viewport, scrolls
 * to the bottom of the list, and asserts that the oldest seeded day's
 * header is in the DOM. Under the pre-fix behaviour it never was.
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

test.describe("/amex shows the full selected month (#744)", () => {
  test("oldest day-group in a 25-day month is rendered after scrolling to the bottom", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "amex-month-not-trimmed-744",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // Use a fixed past month so the seeded day count is deterministic
    // regardless of when this spec runs (current month early in the
    // calendar wouldn't have 25 days yet) and so we never collide with
    // the page's auto-scroll-to-today behaviour.
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const year = target.getFullYear();
    const month0 = target.getMonth();
    const monthIso = `${year}-${pad2(month0 + 1)}-01`;
    const seededDays: number[] = [];
    for (let day = 1; day <= 25; day++) seededDays.push(day);
    const oldestIso = `${year}-${pad2(month0 + 1)}-${pad2(seededDays[0])}`;
    const newestIso = `${year}-${pad2(month0 + 1)}-${pad2(seededDays[seededDays.length - 1])}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    const rows = seededDays.map((day) => {
      const iso = `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
      return {
        userId,
        householdId,
        occurredOn: iso,
        occurredAt: new Date(`${iso}T15:00:00Z`).toISOString(),
        description: `E2E-AMEX-744-${suffix.toUpperCase()}-D${pad2(day)}`,
        amount: `${10 + day}.00`,
        source: "amex" as const,
      };
    });
    await db.insert(transactionsTable).values(rows);

    // Constrained viewport — the virtualizer's behaviour is most
    // visible when the list cannot all fit on screen at once.
    const context = await browser.newContext({
      viewport: { width: 1024, height: 600 },
    });
    const page = await context.newPage();
    await signInAndOpen(page, email, password, `/amex?month=${monthIso}`);

    // Wait for the txn-count chip to confirm the server returned every
    // seeded row (25 rows on 25 distinct days → 25 day-groups).
    await expect(
      page.getByText(/25 of 25 txns/i),
    ).toBeVisible({ timeout: 20_000 });

    // The newest day's header should always be visible on initial load
    // (and the virtualizer's `todayIdx` carve-out doesn't help us here
    // because the selected month is not the current month).
    await expect(
      page.getByText(formatDayHeader(newestIso), { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Scroll the window all the way down so the virtualizer is asked
    // to reveal the oldest day-groups. Loop a few times because each
    // pass triggers `measureElement` on newly rendered items, which
    // updates `getTotalSize()` and unlocks the next batch.
    const oldestHeader = page
      .getByText(formatDayHeader(oldestIso), { exact: false })
      .first();
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() =>
        window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" }),
      );
      await page.waitForTimeout(150);
      if (await oldestHeader.count()) break;
    }

    // The oldest seeded day-group must be present in the DOM after
    // scrolling. Pre-fix, the virtualizer's totalSize undershot the
    // real scroll height by `24 * 24 = 576px`, which silently trimmed
    // the oldest two-to-three day-groups off the bottom of the list
    // no matter how far the user scrolled.
    await expect(oldestHeader).toBeVisible({ timeout: 10_000 });

    // The row-cap banner must NOT be the explanation here — only 25
    // rows were seeded, well below the 1000-row month cap.
    await expect(page.getByTestId("text-month-cap-hit")).toHaveCount(0);

    await context.close();
  });
});
