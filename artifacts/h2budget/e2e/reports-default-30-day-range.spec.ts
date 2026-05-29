import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * Regression guard for task #841, which changed the Reports range selector to
 * default to "Last 30 days" on first load (previously 90 days). Without an
 * automated test, a future refactor could silently revert the default back to
 * 90 days.
 *
 * This spec proves the default both ways:
 *   - The RANGE selector trigger reads "Last 30 days" for a fresh user with no
 *     saved preference.
 *   - The Spending tab's "Total spend" tile reflects a 30-day window, not a
 *     90-day one. We seed two expenses — one 15 days ago ($100, inside 30 days)
 *     and one 75 days ago ($500, outside 30 but inside 90). On first load the
 *     tile shows $100.00 (30-day window). Switching the selector to "Last 90
 *     days" grows it to $600.00, confirming the seeded data straddles the
 *     boundary and that the default really is the narrower window.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
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

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function seedExpense(
  page: Page,
  occurredOn: string,
  description: string,
  amount: string,
): Promise<void> {
  await apiCall(page, "POST", "/api/transactions", {
    occurredOn,
    description,
    amount,
    source: "manual",
    categoryId: null,
  });
}

test.describe("Reports default range (#841)", () => {
  test("opens on a 30-day window by default for a user with no saved preference", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "reports-default-30day-841",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/reports");

    // The Reports page renders its <h1>Reports</h1> only once the year-of
    // transactions query resolves (it returns null while loading).
    await expect(
      page.getByRole("heading", { name: /^reports$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Seed two expenses straddling the 30-day boundary: one inside the
    // default 30-day window and one only inside a 90-day window.
    await seedExpense(page, isoDaysAgo(15), "REPORTS-RANGE-IN-30", "-100.00");
    await seedExpense(page, isoDaysAgo(75), "REPORTS-RANGE-IN-90", "-500.00");

    // Reload so the page's `useListTransactions` query picks up the seeded
    // rows on its initial fetch (avoids racing the cache).
    await page.goto("/reports");
    await expect(
      page.getByRole("heading", { name: /^reports$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // (1) The RANGE selector trigger reads "Last 30 days" by default — the
    // core #841 contract.
    const rangeTrigger = page
      .getByRole("combobox")
      .filter({ hasText: /Last 30 days/ });
    await expect(rangeTrigger).toBeVisible({ timeout: 15_000 });

    // (2) The Spending tab's totals reflect a 30-day window. Only the
    // 15-day-old $100 expense counts; the 75-day-old $500 one is excluded.
    await page.getByRole("tab", { name: /spending/i }).click();
    const totalSpendTile = page
      .locator("div.rounded-2xl", { hasText: "Total spend" })
      .first();
    await expect(totalSpendTile).toContainText("$100.00");
    await expect(totalSpendTile).not.toContainText("$600.00");

    // Switching to "Last 90 days" pulls in the older $500 expense, growing
    // the total to $600.00 — proving the data straddles the boundary and the
    // default really was the narrower 30-day window.
    await rangeTrigger.click();
    await page.getByRole("option", { name: /Last 90 days/ }).click();
    await expect(totalSpendTile).toContainText("$600.00", { timeout: 15_000 });

    await context.close();
  });
});
