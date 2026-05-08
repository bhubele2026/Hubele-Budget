import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, recurringItemsTable } from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #538 — the Bills page month picker.
 *
 * The prev/next chevrons re-fetch /bills/summary?month=YYYY-MM-01 and
 * re-scope every row + the per-row "/mo" hint + the group total. There's
 * no automated coverage that paging actually swaps these values, so a
 * regression could silently re-lock the page to today's calendar month.
 *
 * This spec seeds a single biweekly bill anchored at 2026-05-01 (a
 * Friday), which expands deterministically to:
 *   - May 2026:  May 1, 15, 29   → 3 events → $300/mo
 *   - June 2026: Jun 12, 26      → 2 events → $200/mo
 *   - April 2026: 0 events       (anchor is May 1)
 * That gives us a stable per-month delta to assert on. We also exercise:
 *   - URL ?month= round-trip on reload
 *   - The April-2026 floor (Prev disabled)
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
    } catch {
      // best-effort — Clerk teardown below still runs
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Bills month picker (#538)", () => {
  test("paging swaps the group total and per-row /mo hint, URL round-trips, and Prev floors at April 2026", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "bills-month-picker",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    // Single biweekly bill. Per-event = $100, anchored 2026-05-01. The
    // calendar expansion in the API yields 3 events in May and 2 in June,
    // so the monthly hint and group total must change when we page.
    const [bill] = await db
      .insert(recurringItemsTable)
      .values({
        userId,
        name: "E2E Biweekly Bill",
        kind: "bill",
        amount: "100",
        frequency: "biweekly",
        anchorDate: "2026-05-01",
        active: "true",
      })
      .returning();

    const context = await browser.newContext();
    const page = await context.newPage();
    // Anchor the picker explicitly so the spec is independent of the
    // server's wall-clock month.
    await signInAndOpen(page, email, password, "/bills?month=2026-05-01");

    await expect(
      page.getByRole("heading", { name: /^bills$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- May 2026: 3 biweekly events → $300/mo group total + hint.
    await expect(page.getByTestId("text-current-month")).toHaveText(
      "May 2026",
    );
    await expect(page.getByTestId("text-group-total-bill")).toHaveText(
      "−$300.00",
    );
    const row = page.getByTestId(`row-bill-${bill.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("~$300.00/mo");

    // --- Click Next → June 2026: 2 events → $200/mo.
    await page.getByTestId("button-next-month").click();

    await expect(page.getByTestId("text-current-month")).toHaveText(
      "June 2026",
    );
    await expect(page.getByTestId("text-group-total-bill")).toHaveText(
      "−$200.00",
    );
    await expect(row).toContainText("~$200.00/mo");
    // The chevron updates the URL via wouter's setLocation(..., {replace:true}).
    await expect(page).toHaveURL(/[?&]month=2026-06-01\b/);

    // --- URL round-trip: a hard reload must keep us on June 2026 with
    // the same totals (otherwise the picker would silently snap back to
    // today's month on every navigation).
    await page.reload();
    await expect(page.getByTestId("text-current-month")).toHaveText(
      "June 2026",
    );
    await expect(page.getByTestId("text-group-total-bill")).toHaveText(
      "−$200.00",
    );
    await expect(row).toContainText("~$200.00/mo");
    await expect(page).toHaveURL(/[?&]month=2026-06-01\b/);

    // --- Prev × 2 → April 2026 (the floor). Button must be disabled
    // and aria-disabled so keyboard + assistive tech also see the floor.
    const prev = page.getByTestId("button-prev-month");
    await prev.click(); // June → May
    await expect(page.getByTestId("text-current-month")).toHaveText(
      "May 2026",
    );
    await prev.click(); // May → April
    await expect(page.getByTestId("text-current-month")).toHaveText(
      "April 2026",
    );
    await expect(prev).toBeDisabled();
    await expect(prev).toHaveAttribute("aria-disabled", "true");
    await expect(page).toHaveURL(/[?&]month=2026-04-01\b/);

    await context.close();
  });
});
