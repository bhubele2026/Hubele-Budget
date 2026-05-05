import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the neutral "+N" fallback variant of the inline
 * categorize badge on Budget rows (task #183).
 *
 * Task #178 already locked the violet "N matches" variant — that path
 * fires when an uncategorized transaction matches a mapping rule (or
 * contains the row's category name) for that row's category.
 *
 * The fallback variant — dashed "+N" with neutral muted-foreground colors —
 * only had unit-test coverage. This spec seeds an uncategorized txn whose
 * description does NOT match any rule and does NOT substring-match any
 * seeded category name, then asserts on the Groceries budget row that:
 *   - The badge reads "+1" (not "1 match")
 *   - data-suggested-count="0"
 *   - The popover groups the txn under "Uncategorized this month"
 *     (the section title flips to "Other uncategorized" only when at
 *     least one suggested txn is also rendered above it)
 *   - Clicking the assign button categorizes the txn and the badge
 *     disappears (count drops from 1 → 0, which hides the badge entirely
 *     because the parent only renders when uncategorizedTxns.length > 0).
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

function todayIso(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Budget categorize neutral '+N' badge (#183)", () => {
  test("dashed +N badge with no suggestions, popover lists txn under 'Uncategorized this month', and assigning hides the badge", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "budget-neutral-badge-183",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    // Sign in and land on /budget — first visit auto-fires
    // POST /budget/seed-defaults so we have categories to assert against.
    await signInAndOpen(page, email, password, "/budget");

    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Wait until categories have actually been seeded — the seed mutation
    // races with the initial render so polling here keeps the spec
    // deterministic without coupling to internal timing.
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

    // Seed a single uncategorized transaction with a description that
    // intentionally avoids matching any seeded category name and any rule
    // (we deliberately create no rules in this spec). The merchant string
    // "ZZQ MERCHANT XYZ #771" doesn't substring-match "Groceries",
    // "Dining & Coffee", "Subscriptions", "Utilities", "Pets", etc., so
    // the suggested split keeps it in `otherTxns` for every row.
    const today = todayIso();
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "ZZQ MERCHANT XYZ #771",
      amount: "-12.34",
      account: "Test Bank",
      categoryId: null,
    });

    // Reload so the budget page picks up the new transaction in its
    // initial useListTransactions query.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // --- Neutral "+1" badge on the Groceries row --------------------------
    const categorizeBadge = page.getByTestId(
      `button-categorize-${groceries.id}`,
    );
    await expect(categorizeBadge).toBeVisible({ timeout: 15_000 });
    // No rule for Groceries + description doesn't contain "groceries", so
    // suggestedTxns is empty → badge falls back to the neutral variant
    // and reads "+1" (not "1 match").
    await expect(categorizeBadge).toHaveAttribute(
      "data-suggested-count",
      "0",
    );
    await expect(categorizeBadge).toHaveText(/\+\s*1/);
    await expect(categorizeBadge).not.toContainText(/match/i);

    await categorizeBadge.click();

    const uncategorizedList = page.getByTestId(
      `uncategorized-list-${groceries.id}`,
    );
    await expect(uncategorizedList).toBeVisible();
    // With zero suggested txns the popover header is "Uncategorized this
    // month" — it would only flip to "Other uncategorized" if a Suggested
    // section was also rendered above. Lock both halves of that contract.
    await expect(uncategorizedList).toContainText(
      /Uncategorized this month/i,
    );
    await expect(uncategorizedList).not.toContainText(
      /Suggested · matches rule or name/i,
    );
    await expect(uncategorizedList).toContainText("ZZQ MERCHANT XYZ #771");

    // --- Assign the txn to Groceries via the popover button ---------------
    const assignBtn = uncategorizedList.locator(
      `[data-testid$="-to-${groceries.id}"]`,
    );
    await expect(assignBtn).toHaveCount(1);
    await assignBtn.click();

    // After the assign the txn is no longer uncategorized, so the parent
    // (which only renders when uncategorizedTxns.length > 0) unmounts the
    // badge entirely — count effectively drops from 1 to 0.
    await expect(
      page.getByTestId(`button-categorize-${groceries.id}`),
    ).toHaveCount(0, { timeout: 10_000 });

    // Belt-and-suspenders: confirm via the API the txn is now categorized
    // to Groceries (proves the assign click actually persisted, not just
    // that the popover closed optimistically).
    const txns = await apiCall<Array<{ id: string; categoryId: string | null; description: string }>>(
      page,
      "GET",
      "/api/transactions",
    );
    const seeded = txns.find((t) => t.description === "ZZQ MERCHANT XYZ #771");
    expect(seeded).toBeDefined();
    expect(seeded!.categoryId).toBe(groceries.id);

    await context.close();
  });
});
