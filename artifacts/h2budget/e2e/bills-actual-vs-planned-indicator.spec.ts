import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  forecastResolutionsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #166's per-row planned-vs-actual indicator
 * on the Bills page. The API path (matched forecast resolutions →
 * actualAmount) is already locked by billsDebtMin.integration.test.ts;
 * this spec verifies that the green-check "paid" and amber "so far"
 * label/colors actually render on the corresponding `text-actual-<id>`
 * element so we'd catch UI regressions if the label or color logic ever
 * drifted from the API contract.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(forecastResolutionsTable)
        .where(eq(forecastResolutionsTable.userId, userId));
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, userId));
      await db
        .delete(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
    } catch {
      // best-effort — Clerk teardown below still runs
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

function thisMonthStartISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

test.describe("Bills planned-vs-actual indicator (#166)", () => {
  test("renders the 'paid' (green check) and 'partial' (amber 'so far') row labels from matched forecast resolutions", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "bills-actual-indicator",
      provisionedUserIds,
    );
    seededUserIds.push(userId);

    const monthStart = thisMonthStartISO();

    // --- Two unrelated monthly bills. Both have dayOfMonth=1 so each
    // expands to exactly one in-month event with its full amount, making
    // `planned` deterministic regardless of when in the month the test
    // runs. The third bill has no matched resolution so we can confirm
    // no indicator renders for it.
    const [paidBill] = await db
      .insert(recurringItemsTable)
      .values({
        userId,
        name: "E2E Rent (paid)",
        kind: "bill",
        amount: "1200",
        frequency: "monthly",
        dayOfMonth: 1,
        active: "true",
      })
      .returning();
    const [partialBill] = await db
      .insert(recurringItemsTable)
      .values({
        userId,
        name: "E2E Electric (partial)",
        kind: "bill",
        amount: "300",
        frequency: "monthly",
        dayOfMonth: 1,
        active: "true",
      })
      .returning();
    const [unmatchedBill] = await db
      .insert(recurringItemsTable)
      .values({
        userId,
        name: "E2E Internet (none)",
        kind: "bill",
        amount: "75",
        frequency: "monthly",
        dayOfMonth: 1,
        active: "true",
      })
      .returning();

    // --- Matching bank transactions. Plaid sync is the only writer for
    // these in production, so seed the rows directly the same way the
    // existing chase-account-picker spec does.
    const [paidTxn] = await db
      .insert(transactionsTable)
      .values({
        userId,
        occurredOn: monthStart,
        description: "Rent payment",
        amount: "-1200",
        source: "plaid:bank",
      })
      .returning();
    const [partialTxn] = await db
      .insert(transactionsTable)
      .values({
        userId,
        occurredOn: monthStart,
        description: "Electric partial",
        amount: "-140",
        source: "plaid:bank",
      })
      .returning();

    // --- Matched resolutions tying each txn to its recurring item this
    // month. The bills/summary route windows by occurrence_date inside
    // the current month, so anchor both at monthStart.
    await db.insert(forecastResolutionsTable).values([
      {
        userId,
        recurringItemId: paidBill.id,
        occurrenceDate: monthStart,
        status: "matched",
        matchedTxnId: paidTxn.id,
      },
      {
        userId,
        recurringItemId: partialBill.id,
        occurrenceDate: monthStart,
        status: "matched",
        matchedTxnId: partialTxn.id,
      },
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/bills");

    await expect(
      page.getByRole("heading", { name: /bills/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Both bill rows should render so we know the page is past loading.
    await expect(
      page.getByTestId(`row-bill-${paidBill.id}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`row-bill-${partialBill.id}`)).toBeVisible();
    await expect(page.getByTestId(`row-bill-${unmatchedBill.id}`)).toBeVisible();

    // --- Fully-paid case: green "$1,200.00 paid" with the Check svg.
    const paidLabel = page.getByTestId(`text-actual-${paidBill.id}`);
    await expect(paidLabel).toBeVisible();
    await expect(paidLabel).toHaveText(/\$1,200\.00 paid/);
    await expect(paidLabel).toHaveClass(/text-emerald-700/);
    await expect(paidLabel).toHaveAttribute(
      "title",
      /Paid \$1,200\.00 of \$1,200\.00 planned/,
    );
    // The check icon is an inline lucide <svg>; assert it's actually there
    // so a future refactor that drops the icon would fail the test.
    await expect(paidLabel.locator("svg")).toHaveCount(1);

    // --- Partial case: amber "$140.00 so far", no check icon.
    const partialLabel = page.getByTestId(`text-actual-${partialBill.id}`);
    await expect(partialLabel).toBeVisible();
    await expect(partialLabel).toHaveText(/\$140\.00 so far/);
    await expect(partialLabel).toHaveClass(/text-amber-600/);
    await expect(partialLabel).toHaveAttribute(
      "title",
      /Partial — \$140\.00 of \$300\.00 planned/,
    );
    await expect(partialLabel.locator("svg")).toHaveCount(0);

    // --- "None" case: no indicator rendered for the unmatched bill.
    await expect(
      page.getByTestId(`text-actual-${unmatchedBill.id}`),
    ).toHaveCount(0);

    await context.close();
  });
});
