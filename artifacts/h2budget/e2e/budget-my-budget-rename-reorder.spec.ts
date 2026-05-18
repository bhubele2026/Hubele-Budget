import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #692 — inline rename + up/down reorder
 * for manual envelopes in the Budget page's "My budget" card.
 *
 * The flow is mouse-heavy (pencil icon to open the inline input, neighbor-
 * swap buttons for reorder) and the row layout is easy to regress when
 * other Budget tweaks land. This spec seeds two manual envelopes via the
 * same POST /api/budget/categories endpoint the "Add a line" form drives,
 * then:
 *
 *   1. Renames the first envelope inline (pencil → type → Enter) and
 *      reloads to assert the new name persists.
 *   2. Uses the down-arrow on the (now-renamed) first envelope to swap
 *      it with its neighbor and asserts the rendered order flips.
 *   3. Asserts the top row's "Move up" and the bottom row's "Move down"
 *      buttons are disabled (no neighbor to swap with).
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

test.describe("Budget My-budget rename + reorder (#692)", () => {
  test("inline rename persists and up/down swap reflows row order", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-my-budget-rename-reorder-692",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/budget");

    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Trigger the lazy seed-defaults pass (creates the system categories
    // and seeds the canonical groups) by hitting GET /api/budget/categories
    // before posting our own rows.
    await apiCall<unknown[]>(page, "GET", "/api/budget/categories");

    // Two manual envelopes in the "My budget" bucket. Distinct sortOrder
    // values lock the initial render order to [A, B] so the reorder
    // assertions below are unambiguous.
    const suffix = Math.random().toString(36).slice(2, 7);
    const nameA = `E2E Envelope A ${suffix}`;
    const nameB = `E2E Envelope B ${suffix}`;
    const catA = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      {
        name: nameA,
        kind: "expense",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 1,
      },
    );
    const catB = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      {
        name: nameB,
        kind: "expense",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 2,
      },
    );

    // Reload so the Budget page picks up both seeded envelopes in its
    // initial budget-month query.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const rowA = page.getByTestId(`row-budget-${catA.id}`);
    const rowB = page.getByTestId(`row-budget-${catB.id}`);
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await expect(rowB).toBeVisible({ timeout: 15_000 });

    // Initial order: A is above B in the My budget card.
    const myBudgetCard = page.getByTestId("group-My budget");
    const rowsLoc = myBudgetCard.locator('[data-testid^="row-budget-"]');
    const initialIds = await rowsLoc.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.testid ?? ""),
    );
    expect(initialIds).toEqual([
      `row-budget-${catA.id}`,
      `row-budget-${catB.id}`,
    ]);

    // ---- 1. Inline rename of A ----
    const renamedA = `E2E Envelope A Renamed ${suffix}`;
    await rowA.getByTestId(`button-rename-${catA.id}`).click();
    const renameInput = page.getByTestId(`input-rename-${catA.id}`);
    await expect(renameInput).toBeVisible();
    await renameInput.fill(renamedA);
    await renameInput.press("Enter");

    // Reload and assert the new name persists on the same row.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });
    const rowAAfter = page.getByTestId(`row-budget-${catA.id}`);
    await expect(rowAAfter).toBeVisible({ timeout: 15_000 });
    await expect(
      rowAAfter.getByTestId(`button-category-name-${catA.id}`),
    ).toContainText(renamedA);

    // ---- 2. Reorder: move A down, expect [B, A] ----
    const moveDownA = rowAAfter.getByTestId(`button-move-down-${catA.id}`);
    await expect(moveDownA).toBeEnabled();
    await moveDownA.click();

    // The list re-renders after both PATCHes settle. Poll the rendered
    // order rather than racing the swap.
    await expect
      .poll(
        async () =>
          myBudgetCard
            .locator('[data-testid^="row-budget-"]')
            .evaluateAll((els) =>
              els.map((e) => (e as HTMLElement).dataset.testid ?? ""),
            ),
        { timeout: 10_000, intervals: [250, 500, 1000] },
      )
      .toEqual([`row-budget-${catB.id}`, `row-budget-${catA.id}`]);

    // ---- 3. Edge rows have their respective move buttons disabled ----
    // Top row (B): "Move up" is disabled.
    const topRow = page.getByTestId(`row-budget-${catB.id}`);
    await expect(
      topRow.getByTestId(`button-move-up-${catB.id}`),
    ).toBeDisabled();
    // Bottom row (A): "Move down" is disabled.
    const bottomRow = page.getByTestId(`row-budget-${catA.id}`);
    await expect(
      bottomRow.getByTestId(`button-move-down-${catA.id}`),
    ).toBeDisabled();
  });
});
