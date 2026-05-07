import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #451:
 *
 * Rows that already have a category (e.g. ones the server's
 * mapping-rule auto-categorize pipeline filled in) now expose an
 * inline category override — clicking the category badge opens the
 * same picker the uncategorized-row CategorizeChip uses. Picking a
 * different category PATCHes the row through the same
 * `handleQuickCategorize` flow, so the same "Categorized" toast
 * fires and the change is persisted server-side. The pencil/edit
 * dialog is left untouched as a secondary path.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

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

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Inline category override on rule-categorized rows (#451)", () => {
  test("clicking the category badge opens the picker; picking a different category PATCHes the row and shows the Categorized toast", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-inline-cat-451",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    const monthStart = thisMonthStart();
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Seed two categories and one transaction pre-assigned to the
    // first one so we can verify the inline picker's PATCH flow.
    const suffix = Math.random().toString(36).slice(2, 8);
    const groceriesName = `Groceries451-${suffix}`;
    const diningName = `Dining451-${suffix}`;
    const description = `INLINE-CAT-${suffix.toUpperCase()} MARKET`;

    const groceriesCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: groceriesName, kind: "expense", groupName: "Food" },
    );
    const diningCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: diningName, kind: "expense", groupName: "Food" },
    );
    const seeded = await apiCall<{ id: string; categoryId: string | null }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-1),
        description,
        amount: "-12.34",
        categoryId: groceriesCat.id,
      },
    );
    expect(seeded.categoryId).toBe(groceriesCat.id);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId(`row-tx-${seeded.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The inline category badge should show the current category and
    // act as the picker trigger (no edit dialog needed).
    const badge = page.getByTestId(`badge-category-${seeded.id}`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(groceriesName);

    await badge.click();

    // Picker opens with all categories searchable. Pick the second one.
    const patchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    const resPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    await page
      .getByTestId(`option-inline-category-${seeded.id}-${diningCat.id}`)
      .click();

    const patchReq = await patchPromise;
    const patchRes = await resPromise;
    expect(patchRes.status()).toBe(200);
    const body = JSON.parse(patchReq.postData() ?? "{}");
    expect(body.categoryId).toBe(diningCat.id);

    // The "Categorized" toast (same one handleQuickCategorize fires
    // for the uncategorized-row CategorizeChip) should show.
    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(notifications.getByText(/^Categorized$/)).toBeVisible({
      timeout: 5_000,
    });

    // Server-side persistence — the row's category really moved.
    const list = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions");
    const persisted = list.find((t) => t.id === seeded.id);
    expect(persisted?.categoryId).toBe(diningCat.id);

    // Badge label updates to reflect the new category.
    await expect(badge).toHaveText(diningName);

    await context.close();
  });
});
