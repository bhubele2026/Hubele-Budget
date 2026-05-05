import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the Budget category drill-down VISUAL INDICATOR
 * (task #305 / #326). Task #305 added a small CreditCard / Landmark icon
 * and an "Opens in Amex" / "Opens in Transactions" tooltip suffix to each
 * Budget category-name button, plus a `data-drilldown-target` attribute
 * that mirrors the routing decision. The routing logic itself is covered
 * by `budgetCategoryDrillDown.test.ts` (unit) and the click destinations
 * are covered by `budget-amex-drill-down.spec.ts` (e2e). This spec
 * specifically asserts that the rendered icon, title suffix, and
 * `data-drilldown-target` attribute on the button match the destination
 * the click actually lands on, for both the Amex-dominant and the
 * Bank-dominant cases.
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

function todayIso(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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

test.describe("Budget → category drill-down icon matches destination (#305 / #326 e2e)", () => {
  test("Amex-dominant row shows the CreditCard icon, 'Opens in Amex' title, data-drilldown-target='amex', and clicking lands on /amex", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "budget-drilldown-icon-amex-326",
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

    // Seed two amex-source txns this month so the row's sourceBreakdown
    // is Amex-dominant (Amex=2, Bank=0). The routing rule picks /amex
    // and the row should render the CreditCard icon variant.
    const today = todayIso();
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "ICON AMEX DRILLDOWN A",
      amount: "-7.85",
      account: "Amex",
      source: "amex",
      categoryId: dining.id,
    });
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "ICON AMEX DRILLDOWN B",
      amount: "-12.10",
      account: "Amex",
      source: "amex",
      categoryId: dining.id,
    });

    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Wait for the breakdown to land server-side (Amex badge visible).
    await expect(
      page.getByTestId(`badge-source-amex-${dining.id}`),
    ).toBeVisible({ timeout: 15_000 });

    const button = page.getByTestId(`button-category-name-${dining.id}`);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("data-drilldown-target", "amex");
    await expect(button).toHaveAttribute(
      "title",
      `View ${dining.name} transactions — Opens in Amex`,
    );
    // Amex-variant icon present, Transactions-variant icon absent.
    await expect(
      page.getByTestId(`icon-drilldown-amex-${dining.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`icon-drilldown-transactions-${dining.id}`),
    ).toHaveCount(0);

    await button.click();
    await page.waitForURL(/\/amex\?/, { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe("/amex");

    await context.close();
  });

  test("Bank-dominant row shows the Landmark icon, 'Opens in Transactions' title, data-drilldown-target='transactions', and clicking lands on /transactions", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "budget-drilldown-icon-bank-326",
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

    // Seed Bank=2 / Amex=1 → Bank >= Amex, so the row keeps the legacy
    // /transactions destination and renders the Landmark icon variant.
    const today = todayIso();
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "ICON BANK DRILLDOWN A",
      amount: "-22.10",
      account: "Test Bank",
      source: "plaid:bank",
      categoryId: groceries.id,
    });
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "ICON BANK DRILLDOWN B",
      amount: "-31.40",
      account: "Test Bank",
      source: "plaid:bank",
      categoryId: groceries.id,
    });
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "ICON BANK DRILLDOWN AMEX TIEBREAKER",
      amount: "-9.99",
      account: "Amex",
      source: "amex",
      categoryId: groceries.id,
    });

    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    await expect(
      page.getByTestId(`badge-source-bank-${groceries.id}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(`badge-source-amex-${groceries.id}`),
    ).toBeVisible();

    const button = page.getByTestId(`button-category-name-${groceries.id}`);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute(
      "data-drilldown-target",
      "transactions",
    );
    await expect(button).toHaveAttribute(
      "title",
      `View ${groceries.name} transactions — Opens in Transactions`,
    );
    await expect(
      page.getByTestId(`icon-drilldown-transactions-${groceries.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`icon-drilldown-amex-${groceries.id}`),
    ).toHaveCount(0);

    await button.click();
    await page.waitForURL(/\/transactions\?/, { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe("/transactions");

    await context.close();
  });
});
