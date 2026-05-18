import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #701 — renaming a manual envelope to a
 * name another envelope already uses must:
 *   - surface the server's friendly 409 message as a destructive toast
 *   - leave the original row name unchanged (the rename does NOT take)
 *
 * The PATCH /budget/categories/:id endpoint already returns a 409 with
 * `A category named "X" already exists.` when a rename would collide
 * with the (household_id, name) unique index. The Budget page funnels
 * that error through handleRenameMyBudgetCategory's onError destructive
 * toast. Easy to regress when toast plumbing or the inline-rename input
 * lifecycle changes — this spec locks both halves down.
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

test.describe("Budget My-budget rename duplicate-name guard (#701)", () => {
  test("colliding rename surfaces 409 toast and leaves the row name unchanged", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-my-budget-rename-duplicate-701",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/budget");

    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 30_000,
    });

    // Trigger the lazy seed-defaults pass so subsequent POSTs land in the
    // already-seeded "My budget" group.
    await apiCall<unknown[]>(page, "GET", "/api/budget/categories");

    // Two manual envelopes — we'll try to rename "Bar" to "Foo" and
    // expect the server's unique-name guard to fire.
    const suffix = Math.random().toString(36).slice(2, 7);
    const nameFoo = `E2E Foo ${suffix}`;
    const nameBar = `E2E Bar ${suffix}`;
    await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      {
        name: nameFoo,
        kind: "expense",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 1,
      },
    );
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

    // Reload so the Budget page renders both seeded envelopes.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 30_000,
    });

    const rowBar = page.getByTestId(`row-budget-${catBar.id}`);
    await expect(rowBar).toBeVisible({ timeout: 30_000 });
    await expect(
      rowBar.getByTestId(`button-category-name-${catBar.id}`),
    ).toContainText(nameBar);

    // ---- Attempt the colliding inline rename: Bar -> Foo ----
    await rowBar.getByTestId(`button-rename-${catBar.id}`).click();
    const renameInput = page.getByTestId(`input-rename-${catBar.id}`);
    await expect(renameInput).toBeVisible();
    await renameInput.fill(nameFoo);
    await renameInput.press("Enter");

    // Destructive toast surfaces the API's exact 409 message. The toast
    // viewport is rendered as a region labeled "Notifications".
    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(notifications.getByText(/Rename failed/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      notifications.getByText(
        new RegExp(`A category named "${nameFoo}" already exists\\.`),
      ),
    ).toBeVisible({ timeout: 10_000 });

    // The Bar row still renders with its original name — the rename
    // did not silently take. Poll to give React Query's settle a beat.
    await expect
      .poll(
        async () =>
          rowBar
            .getByTestId(`button-category-name-${catBar.id}`)
            .textContent(),
        { timeout: 5_000, intervals: [200, 500] },
      )
      .toContain(nameBar);

    // And reload to confirm the server didn't persist the colliding
    // name either — Bar is still Bar after a fresh fetch.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 30_000,
    });
    const rowBarAfter = page.getByTestId(`row-budget-${catBar.id}`);
    await expect(rowBarAfter).toBeVisible({ timeout: 30_000 });
    await expect(
      rowBarAfter.getByTestId(`button-category-name-${catBar.id}`),
    ).toContainText(nameBar);
  });
});
