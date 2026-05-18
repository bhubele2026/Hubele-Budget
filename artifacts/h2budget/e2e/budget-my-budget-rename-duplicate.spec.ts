import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * Task #701 — the PATCH /budget/categories/:id endpoint returns 409 with
 * a friendly "A category named X already exists." message on a rename
 * collision; the Budget page surfaces that as a destructive toast and
 * leaves the row's original name in place. This spec pins that flow so
 * a future toast-plumbing change can't silently regress it.
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
      `API ${method} ${path} failed (${result.status}): ${JSON.stringify(
        result.body,
      )}`,
    );
  }
  return result.body;
}

test.describe("Budget My-budget rename collision (#701)", () => {
  test("renaming to a name already in use shows a destructive toast and keeps the old name", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-my-budget-rename-duplicate-701",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });
    await apiCall<unknown[]>(page, "GET", "/api/budget/categories");

    const suffix = Math.random().toString(36).slice(2, 7);
    const nameFoo = `E2E Foo ${suffix}`;
    const nameBar = `E2E Bar ${suffix}`;
    await apiCall<{ id: string }>(page, "POST", "/api/budget/categories", {
      name: nameFoo,
      kind: "expense",
      groupName: "My budget",
      sourceKind: "manual",
      sortOrder: 1,
    });
    const catBar = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      {
        name: nameBar,
        kind: "expense",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 2,
      },
    );

    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const rowBar = page.getByTestId(`row-budget-${catBar.id}`);
    await expect(rowBar).toBeVisible({ timeout: 15_000 });

    // Inline-rename "Bar" to "Foo" — the server's 409 branch should kick in.
    await rowBar.getByTestId(`button-rename-${catBar.id}`).click();
    const input = page.getByTestId(`input-rename-${catBar.id}`);
    await expect(input).toBeVisible();
    await input.fill(nameFoo);
    await input.press("Enter");

    // A destructive toast appears with the 409 message verbatim.
    await expect(
      page.getByText(`A category named "${nameFoo}" already exists.`, {
        exact: false,
      }),
    ).toBeVisible({ timeout: 10_000 });

    // The row keeps its original name — the rename did not silently take.
    // Reload to make sure we're reading server state, not the optimistic
    // pre-mutation cache value.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page
        .getByTestId(`row-budget-${catBar.id}`)
        .getByTestId(`button-category-name-${catBar.id}`),
    ).toContainText(nameBar);
  });
});
