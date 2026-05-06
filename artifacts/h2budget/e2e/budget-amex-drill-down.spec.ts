import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the Amex-aware Budget category drill-down
 * (task #168). The routing rule (`pickCategoryDrillDownHref`) and the
 * Amex page's URL-param handling were both unit-tested, but nothing
 * tied them together through a real click on a Budget row. This spec
 * does exactly that:
 *
 *   1. Amex-dominant case — seed 2 amex-source txns for "Dining &
 *      Coffee" in the current month, click the row's category name,
 *      assert the URL becomes `/amex?category=Dining%20%26%20Coffee&month=…`
 *      AND the Amex page renders only those 2 rows (proving both the
 *      `?category=` and `?month=` params actually take effect).
 *   2. Bank-dominant case — seed 2 plaid:bank txns + 1 amex txn for
 *      "Groceries", click the row, assert the URL becomes
 *      `/transactions?category=Groceries&month=…` (legacy destination
 *      preserved when Bank count >= Amex count).
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

function thisMonthStart(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function todayIso(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Mirror the Budget page's MIN_MONTH floor (see `budget.tsx`). The page
// won't render any month earlier than April 2026, so the deep-link's
// `?month=` param matches that floor for any "real" calendar month from
// April 2026 onward.
const MIN_MONTH = "2026-04-01";

async function waitForCategories(page: Page): Promise<Category[]> {
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
  return categories;
}

test.describe("Budget → category drill-down deep-link (#168 e2e)", () => {
  test("Amex-dominant row navigates to /amex with category + month params and the Amex page filters to that category", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "budget-drilldown-amex-168",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const categories = await waitForCategories(page);
    const dining = categories.find((c) => c.name === "Dining & Coffee");
    if (!dining) throw new Error("Seed missing 'Dining & Coffee' category");

    // Seed two amex-source txns for the current month, both pre-categorized
    // to Dining & Coffee. With zero Bank entries the routing rule picks
    // Amex (count > 0) over Other / nothing, so the row should deep-link
    // to /amex on click.
    const today = todayIso();
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "AMEX DRILLDOWN STARBUCKS A",
      amount: "-7.85",
      account: "Amex",
      source: "amex",
      categoryId: dining.id,
    });
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "AMEX DRILLDOWN STARBUCKS B",
      amount: "-12.10",
      account: "Amex",
      source: "amex",
      categoryId: dining.id,
    });

    // Reload so the Budget page's initial month query picks up the new
    // sourceBreakdown for the row.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Wait for the Amex source badge on this row to appear — that's the
    // server confirming the breakdown made it into the response.
    const amexBadge = page.getByTestId(
      `badge-source-amex-${dining.id}`,
    );
    await expect(amexBadge).toBeVisible({ timeout: 15_000 });
    // No Bank txns seeded → no Bank badge for this row.
    await expect(
      page.getByTestId(`badge-source-bank-${dining.id}`),
    ).toHaveCount(0);

    // Click the category-name button inside this row. The button is
    // unnamed in test IDs (it's the row's primary affordance) so scope
    // by the row's stable testid and match the button by accessible name.
    const row = page.getByTestId(`row-budget-${dining.id}`);
    await row
      .getByRole("button", { name: dining.name, exact: true })
      .first()
      .click();

    await page.waitForURL(/\/amex\?/, { timeout: 10_000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/amex");
    expect(url.searchParams.get("category")).toBe(dining.name);
    const monthStart = thisMonthStart();
    const expectedMonth = monthStart < MIN_MONTH ? MIN_MONTH : monthStart;
    expect(url.searchParams.get("month")).toBe(expectedMonth);

    // Amex page renders only the seeded category's rows. Both seeded
    // amex txns are in the current month, so they MUST appear in the
    // filtered list — and the row count must be exactly 2 (no other
    // amex categories were seeded).
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("text-row-count")).toContainText(
      /^\s*2 of \d+ txns\s*$/,
      { timeout: 15_000 },
    );
    // Two visual layouts render the same row (mobile cards + desktop table);
    // assert presence in both rather than picking one — keeps the spec
    // resilient to the responsive breakpoint applied during the run.
    await expect(page.getByText("AMEX DRILLDOWN STARBUCKS A")).toHaveCount(2);
    await expect(page.getByText("AMEX DRILLDOWN STARBUCKS B")).toHaveCount(2);

    await context.close();
  });

  test("Bank-dominant row navigates to /transactions with category + month params (preserves legacy destination)", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "budget-drilldown-bank-168",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const categories = await waitForCategories(page);
    const groceries = categories.find((c) => c.name === "Groceries");
    if (!groceries) throw new Error("Seed missing 'Groceries' category");

    // Seed 2 plaid:bank txns + 1 amex txn for Groceries this month.
    // The breakdown becomes Bank=2 / Amex=1 — Bank >= Amex, so the
    // routing rule keeps the legacy /transactions destination.
    const today = todayIso();
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "BANK DRILLDOWN TRADER JOES A",
      amount: "-22.10",
      account: "Test Bank",
      source: "plaid:bank",
      categoryId: groceries.id,
    });
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "BANK DRILLDOWN TRADER JOES B",
      amount: "-31.40",
      account: "Test Bank",
      source: "plaid:bank",
      categoryId: groceries.id,
    });
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "AMEX DRILLDOWN GROCERIES",
      amount: "-9.99",
      account: "Amex",
      source: "amex",
      categoryId: groceries.id,
    });

    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Both badges visible — that's the breakdown rendered server-side.
    await expect(
      page.getByTestId(`badge-source-bank-${groceries.id}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(`badge-source-amex-${groceries.id}`),
    ).toBeVisible();

    const row = page.getByTestId(`row-budget-${groceries.id}`);
    await row
      .getByRole("button", { name: groceries.name, exact: true })
      .first()
      .click();

    await page.waitForURL(/\/transactions\?/, { timeout: 10_000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/transactions");
    expect(url.searchParams.get("category")).toBe(groceries.name);
    const monthStart = thisMonthStart();
    const expectedMonth = monthStart < MIN_MONTH ? MIN_MONTH : monthStart;
    expect(url.searchParams.get("month")).toBe(expectedMonth);

    await context.close();
  });
});
