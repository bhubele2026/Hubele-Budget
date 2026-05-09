import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #540 — the right-side "Per month" summary
 * card and the "Actual this month" tile on the Bills page.
 *
 * Task #538 already asserts that the month picker swaps the per-row "/mo"
 * hint and the BillGroupCard total. The right-side tiles also re-scope to
 * the picked month, but neither is asserted yet — a regression that left
 * those pinned to today's calendar month would slip through.
 *
 * Seeds, anchored at 2026-05-01:
 *   - Biweekly income $200/event   → May: 3 events ($600), June: 2 ($400)
 *   - Biweekly bill   $100/event   → May: 3 events ($300), June: 2 ($200)
 *   - May 2026 transactions:
 *       +500 income, -200 spend, +50 transfer (excluded)
 *   - June 2026 transactions:
 *       +800 income, -120 spend
 *
 * Per-month (planned) on the right tile:
 *   May  → Income +$600.00, Bills −$300.00, Net +$300.00
 *   June → Income +$400.00, Bills −$200.00, Net +$200.00
 *
 * Actual this month:
 *   May  → Income +$500.00, Spend −$200.00, Net +$300.00, "May so far"
 *   June → Income +$800.00, Spend −$120.00, Net +$680.00, "June so far"
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
    try {
      await db
        .delete(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
    } catch {
      // best-effort
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

test.describe("Bills month picker — right-side summaries (#540)", () => {
  test("paging swaps the Per-month tile and Actual-this-month tile", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "bills-month-summary",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    await db.insert(recurringItemsTable).values([
      {
        userId,
        name: "E2E Biweekly Income",
        kind: "income",
        amount: "200",
        frequency: "biweekly",
        anchorDate: "2026-05-01",
        active: "true",
      },
      {
        userId,
        name: "E2E Biweekly Bill",
        kind: "bill",
        amount: "100",
        frequency: "biweekly",
        anchorDate: "2026-05-01",
        active: "true",
      },
    ]);

    await db.insert(transactionsTable).values([
      {
        userId,
        occurredOn: "2026-05-03",
        occurredAt: new Date("2026-05-03T15:00:00Z").toISOString(),
        description: "E2E May income",
        amount: "500.00",
        source: "manual",
      },
      {
        userId,
        occurredOn: "2026-05-10",
        occurredAt: new Date("2026-05-10T15:00:00Z").toISOString(),
        description: "E2E May spend",
        amount: "-200.00",
        source: "manual",
      },
      {
        userId,
        occurredOn: "2026-05-15",
        occurredAt: new Date("2026-05-15T15:00:00Z").toISOString(),
        description: "E2E May transfer (excluded)",
        amount: "50.00",
        source: "manual",
        isTransfer: true,
      },
      {
        userId,
        occurredOn: "2026-06-04",
        occurredAt: new Date("2026-06-04T15:00:00Z").toISOString(),
        description: "E2E June income",
        amount: "800.00",
        source: "manual",
      },
      {
        userId,
        occurredOn: "2026-06-08",
        occurredAt: new Date("2026-06-08T15:00:00Z").toISOString(),
        description: "E2E June spend",
        amount: "-120.00",
        source: "manual",
      },
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/bills?month=2026-05-01");

    await expect(
      page.getByRole("heading", { name: /^bills$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- May 2026 — Per month (planned)
    await expect(page.getByTestId("text-current-month")).toHaveText(
      "May 2026",
    );
    await expect(page.getByTestId("text-summary-income")).toHaveText(
      "+$600.00",
    );
    await expect(page.getByTestId("text-summary-bills")).toHaveText(
      "-$300.00",
    );
    await expect(page.getByTestId("text-net-monthly")).toHaveText(
      "+$300.00",
    );

    // --- May 2026 — Actual this month
    await expect(page.getByTestId("text-actual-month-label")).toHaveText(
      "May so far",
    );
    await expect(page.getByTestId("text-actual-income")).toHaveText(
      "+$500.00",
    );
    await expect(page.getByTestId("text-actual-spend")).toHaveText(
      "-$200.00",
    );
    await expect(page.getByTestId("text-actual-net")).toHaveText("+$300.00");

    // --- Page → June 2026
    await page.getByTestId("button-next-month").click();

    await expect(page.getByTestId("text-current-month")).toHaveText(
      "June 2026",
    );

    // Per month re-scopes
    await expect(page.getByTestId("text-summary-income")).toHaveText(
      "+$400.00",
    );
    await expect(page.getByTestId("text-summary-bills")).toHaveText(
      "-$200.00",
    );
    await expect(page.getByTestId("text-net-monthly")).toHaveText(
      "+$200.00",
    );

    // Actual this month re-scopes (subtitle + values)
    await expect(page.getByTestId("text-actual-month-label")).toHaveText(
      "June so far",
    );
    await expect(page.getByTestId("text-actual-income")).toHaveText(
      "+$800.00",
    );
    await expect(page.getByTestId("text-actual-spend")).toHaveText(
      "-$120.00",
    );
    await expect(page.getByTestId("text-actual-net")).toHaveText("+$680.00");

    await context.close();
  });
});
