import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #338 — running totals in the budget
 * actuals-breakdown popover.
 *
 * The popover lists every transaction that contributed to a row's actual
 * total this month (newest at the top) and renders an oldest→newest
 * accumulating running total under each amount via
 * `data-testid="actuals-running-{txnId}"`.
 *
 * This spec seeds three Groceries transactions on distinct dates so the
 * row order is deterministic, opens the popover, and asserts:
 *
 *   1. The newest row's running total equals the line's actualAmount
 *      (i.e. the cumulative sum reaches the full month total).
 *   2. Going from newest → oldest down the list, |running| is monotonically
 *      non-increasing — strictly decreasing for every non-zero contributor
 *      and equal across $0 transactions.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

type Category = {
  id: string;
  name: string;
  groupName: string;
  sourceKind: string;
};

type ApiResult<T> = { ok: true; status: number; body: T } | {
  ok: false;
  status: number;
  body: unknown;
};

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

// Parse "$1,234.56" / "-$1,234.56" / "($1,234.56)" into a signed number.
// formatCurrency in the app may render negatives with a leading "-" or
// parens depending on locale, so handle both.
function parseCurrency(text: string): number {
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-") || /^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[^0-9.]/g, "");
  if (!digits) return 0;
  const n = Number(digits);
  return negative ? -n : n;
}

test.describe("Budget actuals popover running totals (#338)", () => {
  test("newest row matches actual total and running totals decrease down the list", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-actuals-running-338",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/budget");

    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Wait for seed-defaults to finish so /api/budget/categories returns
    // a populated list before we look up Groceries.
    let categories: Category[] = [];
    await expect
      .poll(
        async () => {
          categories = await apiCall<Category[]>(
            page,
            "GET",
            "/api/budget/categories",
          );
          return categories.length;
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThan(0);

    const groceries = categories.find((c) => c.name === "Groceries");
    if (!groceries) throw new Error("Seed missing 'Groceries' category");

    // Pick three dates in the current month so the page's
    // "this month" filter includes all three and the newest-first sort
    // yields a deterministic order. The page floors the displayed month
    // at 2026-04-01 and otherwise tracks today's month, so use the same
    // floor here.
    const now = new Date();
    const MIN_YEAR = 2026;
    const MIN_MONTH_IDX = 3; // April (0-indexed)
    let year = now.getFullYear();
    let monthIdx = now.getMonth();
    if (year < MIN_YEAR || (year === MIN_YEAR && monthIdx < MIN_MONTH_IDX)) {
      year = MIN_YEAR;
      monthIdx = MIN_MONTH_IDX;
    }
    const yyyy = String(year);
    const mm = String(monthIdx + 1).padStart(2, "0");
    const dates = [
      `${yyyy}-${mm}-02`, // oldest
      `${yyyy}-${mm}-05`,
      `${yyyy}-${mm}-08`, // newest
    ];

    // Distinct amounts so the running-total math is unambiguous; signs
    // are negative because Groceries is a spending category.
    const seeded: Array<{ id: string; amount: number; date: string }> = [];
    const rows = [
      { date: dates[0]!, amount: -10, desc: "TJ OLDEST" },
      { date: dates[1]!, amount: -25, desc: "TJ MIDDLE" },
      { date: dates[2]!, amount: -42, desc: "TJ NEWEST" },
    ];
    for (const r of rows) {
      const tx = await apiCall<{ id: string }>(
        page,
        "POST",
        "/api/transactions",
        {
          occurredOn: r.date,
          description: r.desc,
          amount: String(r.amount),
          account: "Test Bank",
          categoryId: groceries.id,
        },
      );
      seeded.push({ id: tx.id, amount: r.amount, date: r.date });
    }

    // Reload so the budget page picks up the new transactions in its
    // initial useListTransactions query.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const actualsBtn = page.getByTestId(`button-actuals-${groceries.id}`);
    await expect(actualsBtn).toBeVisible({ timeout: 15_000 });

    // The line's actualAmount should reflect the three seeded txns
    // before we open the popover. The API returns actualAmount as an
    // absolute spend magnitude (server sign convention) while the txn
    // amounts are signed negative — so we compare on |total|.
    const expectedAbsTotal = Math.abs(rows.reduce((s, r) => s + r.amount, 0));
    await expect
      .poll(
        async () => Math.abs(parseCurrency(await actualsBtn.innerText())),
        {
          timeout: 10_000,
          intervals: [250, 500, 1000],
        },
      )
      .toBe(expectedAbsTotal);

    await actualsBtn.click();

    const actualsList = page.getByTestId(`actuals-list-${groceries.id}`);
    await expect(actualsList).toBeVisible();

    // Rows render newest → oldest. Lock that order via the seeded ids
    // so the running-total assertions below are unambiguous about which
    // row should hold which cumulative value.
    const orderedIds = [...seeded].reverse().map((s) => s.id);
    const rowsLoc = actualsList.locator('[data-testid^="actuals-row-"]');
    await expect(rowsLoc).toHaveCount(orderedIds.length);

    const runningValues: number[] = [];
    for (const id of orderedIds) {
      const runningCell = actualsList.getByTestId(`actuals-running-${id}`);
      await expect(runningCell).toBeVisible();
      runningValues.push(parseCurrency(await runningCell.innerText()));
    }

    // 1. Newest row's running total equals the line's actualAmount
    //    (compared on absolute value to bridge the server's positive-spend
    //    actualAmount vs. the popover's signed-negative running total).
    expect(Math.abs(runningValues[0]!)).toBe(expectedAbsTotal);

    // 2. Going down the list (newest → oldest), |running| is monotonically
    //    non-increasing, and strictly decreasing across non-zero contributors.
    for (let i = 1; i < runningValues.length; i++) {
      const prev = Math.abs(runningValues[i - 1]!);
      const curr = Math.abs(runningValues[i]!);
      const contributor = seeded[seeded.length - 1 - (i - 1)]!; // txn that drops out at this step
      if (contributor.amount === 0) {
        expect(curr).toBe(prev);
      } else {
        expect(curr).toBeLessThan(prev);
      }
    }

    // 3. Oldest row's running total equals just its own amount — closes
    //    the loop on the oldest-through-this-row accumulation contract.
    const oldest = seeded[0]!;
    expect(runningValues[runningValues.length - 1]).toBe(oldest.amount);
  });
});
