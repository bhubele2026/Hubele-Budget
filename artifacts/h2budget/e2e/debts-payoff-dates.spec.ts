import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  avalancheSettingsTable,
  recurringItemsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the projected payoff dates on the Debts cards
 * page (task #424). Seeds a fresh user with a mix of solvable debts and
 * one underwater debt (monthly interest > minPayment), then asserts:
 *
 *   - Each debt card renders `debt-card-payoff-date` keyed by debt id.
 *   - Solvable cards render a real "Mon YYYY" date.
 *   - The highest-APR solvable card is the avalanche Target and renders
 *     `debt-card-target-payoff-date` with the same value as its main row.
 *   - The underwater card's payoff cell shows "—" and the tooltip /
 *     aria-label includes "Underwater".
 *
 * A regression in the simulation wiring (e.g. losing the killById map or
 * mis-classifying underwater debts) would silently break the dates without
 * this lock.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
      await db
        .delete(avalancheSettingsTable)
        .where(eq(avalancheSettingsTable.userId, userId));
      await db.delete(debtsTable).where(eq(debtsTable.userId, userId));
    } catch {
      // best-effort — Clerk teardown still attempts user removal.
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

const MONTH_YEAR_RE = /^[A-Z][a-z]{2} \d{4}$/;

test.describe("Debts cards page — projected payoff dates (Task #424)", () => {
  test("renders payoff dates for solvable debts, the Target card mirror, and the underwater fallback", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "debts-payoff-dates",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // Solvable, highest APR — should be the avalanche Target.
    const [solvableHigh] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Visa Quick Kill",
        balance: "1500",
        apr: "0.2299",
        minPayment: "200",
        payment: "200",
        status: "active",
        dueDay: 15,
        minPaymentSource: "manual",
      })
      .returning();
    // Solvable, lower APR — should render a payoff date but not be Target.
    const [solvableLow] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Discover Small",
        balance: "500",
        apr: "0.0999",
        minPayment: "100",
        payment: "100",
        status: "active",
        dueDay: 22,
        minPaymentSource: "manual",
      })
      .returning();
    // Underwater: monthly interest (~$333) far exceeds minPayment ($20).
    const [underwater] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Drowning Card",
        balance: "10000",
        apr: "0.3999",
        minPayment: "20",
        payment: "20",
        status: "active",
        dueDay: 5,
        minPaymentSource: "manual",
      })
      .returning();

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/debts");

    await expect(
      page.getByRole("heading", { name: /debt avalanche/i }),
    ).toBeVisible({ timeout: 15_000 });

    // All three cards (and their payoff cells) must render.
    const payoffHigh = page.locator(
      `[data-testid="debt-card-payoff-date"][data-debt-id="${solvableHigh.id}"]`,
    );
    const payoffLow = page.locator(
      `[data-testid="debt-card-payoff-date"][data-debt-id="${solvableLow.id}"]`,
    );
    const payoffUnderwater = page.locator(
      `[data-testid="debt-card-payoff-date"][data-debt-id="${underwater.id}"]`,
    );
    await expect(payoffHigh).toBeVisible({ timeout: 15_000 });
    await expect(payoffLow).toBeVisible();
    await expect(payoffUnderwater).toBeVisible();

    // Solvable cards render a real "Mon YYYY" date.
    const highText = (await payoffHigh.textContent())?.trim() ?? "";
    const lowText = (await payoffLow.textContent())?.trim() ?? "";
    expect(highText).toMatch(MONTH_YEAR_RE);
    expect(lowText).toMatch(MONTH_YEAR_RE);

    // Underwater card shows the em-dash fallback and the "Underwater"
    // hint shows up in both the tooltip (title) and aria-label.
    await expect(payoffUnderwater).toHaveText("—");
    await expect(payoffUnderwater).toHaveAttribute(
      "title",
      /Underwater/i,
    );
    await expect(payoffUnderwater).toHaveAttribute(
      "aria-label",
      /Underwater/i,
    );

    // The highest-APR solvable debt is the planner's current target, so
    // its card mirrors the payoff date in `debt-card-target-payoff-date`.
    const targetPayoff = page.locator(
      `[data-testid="debt-card-target-payoff-date"][data-debt-id="${solvableHigh.id}"]`,
    );
    await expect(targetPayoff).toBeVisible();
    await expect(targetPayoff).toHaveText(highText);

    // No other card should render a target-payoff cell.
    await expect(
      page.locator(`[data-testid="debt-card-target-payoff-date"]`),
    ).toHaveCount(1);

    await context.close();
  });
});
