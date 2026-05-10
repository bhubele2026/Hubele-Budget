import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, recurringItemsTable } from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #413's per-paycheck row display on the
 * Bills page. The unit test on `formatBillRowAmount` (billsRowAmount.ts)
 * already pins the helper, but nothing asserts that the rendered row
 * actually shows the per-event amount + frequency suffix instead of the
 * older smoothed monthly figure. A regression here would be visible only
 * to a user opening Bills, so we lock the rendered text + the group
 * header total in one spec.
 *
 * Anchor: a biweekly $4,050 income at 2026-05-01 (Friday). May 2026
 * expands to three paydays (5/01, 5/15, 5/29), so the API's
 * calendar-expanded monthlyAmount is $12,150 — the same figure the
 * Income group header sums and (since #492) the per-row "/mo" hint.
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

test.describe("Bills per-paycheck row display (#413)", () => {
  test("biweekly income row shows the per-event amount + frequency, the /mo hint, and the Income group total stays the calendar-expanded monthly projection", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "bills-per-paycheck-row",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const [income] = await db
      .insert(recurringItemsTable)
      .values({
        userId,
        householdId,
        name: "E2E Biweekly Paycheck",
        kind: "income",
        amount: "4050",
        frequency: "biweekly",
        anchorDate: "2026-05-01",
        active: "true",
      })
      .returning();

    const context = await browser.newContext();
    const page = await context.newPage();
    // Anchor the picker explicitly so the spec is independent of the
    // server's wall-clock month — May 2026 is the deterministic
    // 3-paycheck month for this anchor.
    await signInAndOpen(page, email, password, "/bills?month=2026-05-01");

    await expect(
      page.getByRole("heading", { name: /^bills$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("text-current-month")).toHaveText(
      "May 2026",
    );

    // --- The per-event amount text + frequency suffix renders on the
    // row (not the smoothed monthly figure).
    const row = page.getByTestId(`row-bill-${income.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText("+$4,050.00 biweekly");

    // --- The "/mo" hint shows the calendar-expanded monthly total for
    // the viewed month (3 × $4,050 = $12,150).
    await expect(row).toContainText("~$12,150.00/mo");

    // --- And the row text never collapses back to the smoothed 26/12
    // figure ($4,050 × 26 / 12 = $8,775) for either the per-event line
    // or the hint.
    await expect(row).not.toContainText("$8,775");

    // --- The Income group header total still equals the monthly
    // projection so that distinction (per-event row text vs. summed
    // monthly group total) doesn't regress.
    await expect(page.getByTestId("text-group-total-income")).toHaveText(
      "+$12,150.00",
    );

    await context.close();
  });
});
