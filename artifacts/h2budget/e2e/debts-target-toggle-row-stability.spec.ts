import { test, expect, type Page } from "@playwright/test";
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
 * End-to-end coverage for task #639's debts-side reserved-slot
 * pattern, the Debts page analogue of
 * `amex-wk-toggle-row-stability.spec.ts` (#626) and
 * `chase-bubble-toggle-row-stability.spec.ts` (#639 Chase half).
 *
 * The Debts page renders one Card per debt in a CSS grid. Two card
 * rows are conditional on `isTarget`: the "Target payoff" row and
 * (when the avalanche planner spills extra onto that debt) the
 * "Extra this month" row. Before #639's reserved-slot fix these
 * were `isTarget && (...)` short-circuits, so changing the avalanche
 * `manualExtra` (which flips which debts are this month's targets)
 * grew/shrank the affected cards and shifted every card below them
 * in the stacked single-column mobile grid.
 *
 * Strategy:
 *   1. Seed three small solvable debts so:
 *      - With $0 manualExtra only the highest-APR card is a target
 *        (avalanche fallback when no extra is available).
 *      - With $5000 manualExtra all three debts die in month 0, so
 *        all three are targets and all three carry an
 *        "Extra this month" row.
 *   2. Sign in at a 1-column mobile viewport (390px) so cards stack
 *      vertically and any card-height change in a card above shifts
 *      the cards below it.
 *   3. With $0 extra, record the document-relative top of the
 *      lowest-APR debt's payoff cell (the bottom card).
 *   4. PUT /api/avalanche/settings to set manualExtra=5000, reload,
 *      and re-record the same card's top.
 *   5. PUT manualExtra back to 0, reload, and re-record again.
 *   6. Assert the bottom card's top stays within ~1px across both
 *      transitions. Without the reserved-slot fix the upper cards
 *      would have grown by ~1.5 rows of card content when they
 *      flipped to target, pushing the bottom card visibly down.
 *
 * The 1px tolerance matches the Amex/Chase specs — sub-pixel jitter
 * from focus-ring or pressed-state styling can nudge layout by a
 * fraction of a pixel without indicating a real reflow.
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
      // best-effort
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: unknown };

async function apiCall<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await page.evaluate(
    async (args): Promise<ApiResult<T>> => {
      const res = await fetch(args.path, {
        method: args.method,
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: args.body == null ? undefined : JSON.stringify(args.body),
      });
      let parsed: unknown = null;
      const text = await res.text();
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        return { ok: false, status: res.status, body: parsed };
      }
      return { ok: true, status: res.status, body: parsed as T };
    },
    { method, path, body },
  );
  if (!result.ok) {
    throw new Error(
      `API ${method} ${path} failed (${result.status}): ${JSON.stringify(result.body)}`,
    );
  }
  return result.body;
}

const MAX_DRIFT_PX = 1;

async function payoffTop(page: Page, debtId: string): Promise<number> {
  return page
    .locator(
      `[data-testid="debt-card-payoff-date"][data-debt-id="${debtId}"]`,
    )
    .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
}

async function setManualExtraAndReload(
  page: Page,
  manualExtra: string,
): Promise<void> {
  await apiCall(page, "PUT", "/api/avalanche/settings", {
    manualExtra,
    extraSource: "manual",
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /debt avalanche/i }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("Debts page row stability under target toggle (#639)", () => {
  // 1-column mobile viewport so every card stacks vertically and a
  // height change in any upper card propagates as a measurable shift
  // in every card below it. The desktop md:grid-cols-2 / lg:grid-cols-3
  // layout would let cards in the same row stretch together, masking
  // the regression.
  test.use({ viewport: { width: 390, height: 844 } });

  test("toggling avalanche extra keeps the bottom card in place", async ({
    page,
  }) => {
    const { userId, email, password } = await createTestUser(
      "debts-target-toggle-stability-639",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    // Three small, solvable debts. APR descending so the page sorts
    // them top→bottom in the same APR order. Balances are tiny
    // enough that $5000 extra wipes all three in month 0 (every
    // card becomes a target with extraPaid > 0); $0 extra leaves
    // only the top card as the avalanche fallback target.
    const [debtTop] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Card A (highest APR)",
        balance: "300",
        apr: "0.2899",
        minPayment: "30",
        payment: "30",
        status: "active",
        dueDay: 10,
        minPaymentSource: "manual",
      })
      .returning();
    const [debtMid] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Card B (mid APR)",
        balance: "400",
        apr: "0.1999",
        minPayment: "40",
        payment: "40",
        status: "active",
        dueDay: 12,
        minPaymentSource: "manual",
      })
      .returning();
    const [debtBottom] = await db
      .insert(debtsTable)
      .values({
        userId,
        householdId,
        name: "Card C (lowest APR)",
        balance: "500",
        apr: "0.0999",
        minPayment: "50",
        payment: "50",
        status: "active",
        dueDay: 14,
        minPaymentSource: "manual",
      })
      .returning();

    await signInAndOpen(page, email, password, "/debts");
    await expect(
      page.getByRole("heading", { name: /debt avalanche/i }),
    ).toBeVisible({ timeout: 15_000 });

    // All three payoff cells must be present before we measure.
    for (const id of [debtTop.id, debtMid.id, debtBottom.id]) {
      await expect(
        page.locator(
          `[data-testid="debt-card-payoff-date"][data-debt-id="${id}"]`,
        ),
      ).toBeVisible({ timeout: 15_000 });
    }

    // --- Baseline: $0 manualExtra. Only the highest-APR card is the
    // strategy's fallback target (its Target-payoff row is visible);
    // mid and bottom cards render their reserved-slot placeholders.
    await setManualExtraAndReload(page, "0");
    await expect(
      page.locator(
        `[data-testid="debt-card-target-payoff-date"]`,
      ),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const bottomTopBefore = await payoffTop(page, debtBottom.id);

    // --- Flip: $5000 manualExtra. All three debts die in month 0,
    // so all three become targets and pick up the "Extra this
    // month" row too. With the reserved-slot fix in place the
    // upper cards' heights don't change, so the bottom card's
    // document-relative top should stay within 1px.
    await setManualExtraAndReload(page, "5000");
    await expect(
      page.locator(
        `[data-testid="debt-card-target-payoff-date"]`,
      ),
    ).toHaveCount(3, { timeout: 15_000 });
    await expect(
      page.locator(`[data-testid="debt-card-target-extra"]`),
    ).toHaveCount(3, { timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const bottomTopAfterOn = await payoffTop(page, debtBottom.id);

    expect(
      Math.abs(bottomTopAfterOn - bottomTopBefore),
    ).toBeLessThanOrEqual(MAX_DRIFT_PX);

    // --- Flip back: $0 manualExtra again. Bottom card top should
    // return to its original position.
    await setManualExtraAndReload(page, "0");
    await expect(
      page.locator(
        `[data-testid="debt-card-target-payoff-date"]`,
      ),
    ).toHaveCount(1, { timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const bottomTopAfterOff = await payoffTop(page, debtBottom.id);

    expect(
      Math.abs(bottomTopAfterOff - bottomTopBefore),
    ).toBeLessThanOrEqual(MAX_DRIFT_PX);
  });
});
