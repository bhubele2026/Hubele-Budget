import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #531 — the Amex page bulk action bar
 * is the primary consumer of POST /transactions/bulk-update (covered
 * server-side by transactionsBulkUpdate.integration.test.ts in the
 * api-server). This spec pins the UI side: that
 *   - selecting multiple Amex rows and triggering a bulk action fires
 *     a single bulk-update request that batches the ids,
 *   - the success toast surfaces the per-id ok-count from the server's
 *     `results[]`, and
 *   - every affected row reflects the new value in the same React
 *     Query cache cycle (no full page reload).
 *
 * It exercises both `runBulkPatch` (via `bulkSetCategory`, which
 * groups by patch and depends on the per-id ok set in the response)
 * and `bulkSetReviewed` (the simpler single-group path that drives
 * the row's `data-reviewed`/opacity-50 styling).
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

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

test.describe("Amex bulk action bar (#531)", () => {
  test("bulk recategorize and bulk mark-reviewed each fire a single bulk-update and update every selected row in one shot", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-bulk-action-bar-531",
      provisionedUserIds,
    );

    // Sign in first so we have a Clerk session cookie before any
    // /api/* seeding calls. We land on /amex but reload after seeding.
    await signInAndOpen(page, email, password, "/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Seed a destination category for the bulkSetCategory action.
    const suffix = Math.random().toString(36).slice(2, 8);
    const catName = `BulkBarTarget-${suffix}`;
    const targetCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: catName, kind: "expense", groupName: "Other" },
    );

    // Seed three same-day Amex transactions. Two are the bulk targets
    // and one is the control row that must NOT be touched. Using
    // distinct descriptions makes failure messages easy to read.
    const today = todayIso();
    const seedSpecs = [
      {
        description: `AMEX BULK BAR ${suffix} — TARGET A`,
        amount: "21.00",
      },
      {
        description: `AMEX BULK BAR ${suffix} — TARGET B`,
        amount: "32.00",
      },
      {
        description: `AMEX BULK BAR ${suffix} — CONTROL`,
        amount: "44.00",
      },
    ];
    const seeded: { id: string; description: string }[] = [];
    for (const s of seedSpecs) {
      const row = await apiCall<{ id: string }>(
        page,
        "POST",
        "/api/transactions",
        {
          occurredOn: today,
          description: s.description,
          amount: s.amount,
          source: "amex",
          // Seed uncategorized + unreviewed so the assertions about
          // "the row gained the new category" / "the row became
          // reviewed" are meaningful (and so the empty rule set on a
          // fresh user can't auto-categorize anything).
          categoryId: null,
          reviewed: false,
        },
      );
      seeded.push({ id: row.id, description: s.description });
    }
    const [targetA, targetB, control] = seeded;

    // Reload so the page picks up the seeded rows in its month query.
    await page.goto("/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    const rowA = page.getByTestId(`row-amex-${targetA.id}`);
    const rowB = page.getByTestId(`row-amex-${targetB.id}`);
    const rowC = page.getByTestId(`row-amex-${control.id}`);
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await expect(rowB).toBeVisible();
    await expect(rowC).toBeVisible();

    // Baseline: every seeded row starts unreviewed, so the bulk-mark
    // step later actually flips state we can observe.
    await expect(rowA).toHaveAttribute("data-reviewed", "false");
    await expect(rowB).toHaveAttribute("data-reviewed", "false");
    await expect(rowC).toHaveAttribute("data-reviewed", "false");
    // Baseline: the rows do not yet show the destination category name.
    await expect(rowA.getByText(catName, { exact: true })).toHaveCount(0);
    await expect(rowB.getByText(catName, { exact: true })).toHaveCount(0);

    // --- Select target A and target B (leave the control unchecked).
    // The desktop layout is the one Playwright drives at the default
    // 1280px viewport; the per-row select checkbox is the one labeled
    // "Select" under each row's `row-amex-${id}` container.
    await rowA.getByRole("checkbox", { name: /select/i }).check();
    await rowB.getByRole("checkbox", { name: /select/i }).check();

    const bulkBar = page.getByText("2 selected").first();
    await expect(bulkBar).toBeVisible();

    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });

    // --- Action 1: bulkSetCategory via the BulkCategoryPicker.
    // This is the runBulkPatch path that groups by JSON-stringified
    // patch — every selected id gets the same `{ categoryId }`, so we
    // expect exactly one POST /transactions/bulk-update with both ids.
    const recatRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/transactions/bulk-update",
      { timeout: 10_000 },
    );
    const recatResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/transactions/bulk-update",
      { timeout: 10_000 },
    );

    await page.getByRole("button", { name: /set category/i }).click();
    // The popover renders a Command palette; pick our seeded category.
    await page
      .getByRole("option", { name: catName })
      .first()
      .click();

    const recatReq = await recatRequestPromise;
    const recatRes = await recatResponsePromise;
    expect(recatRes.status()).toBe(200);
    const recatSent = JSON.parse(recatReq.postData() ?? "{}") as {
      ids: string[];
      patch: { categoryId: string };
    };
    // Single bulk-update with exactly the two selected ids and the
    // chosen categoryId — pins the "one shot" payload shape.
    expect(new Set(recatSent.ids)).toEqual(
      new Set([targetA.id, targetB.id]),
    );
    expect(recatSent.patch.categoryId).toBe(targetCat.id);

    // Toast reports the per-id ok-count (server returned 2 ok).
    await expect(
      notifications.getByText(/Updated 2 transactions/i),
    ).toBeVisible({ timeout: 10_000 });

    // Both affected rows reflect the new category name without a
    // reload; the control row stays uncategorized.
    await expect(
      rowA.getByText(catName, { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      rowB.getByText(catName, { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(rowC.getByText(catName, { exact: true })).toHaveCount(0);

    // --- Action 2: bulkSetReviewed(true). bulkSetCategory clears the
    // selection on success, so re-select the same two rows. This time
    // we also assert the row's visible "reviewed" state flips.
    await rowA.getByRole("checkbox", { name: /select/i }).check();
    await rowB.getByRole("checkbox", { name: /select/i }).check();
    await expect(page.getByText("2 selected").first()).toBeVisible();

    const reviewRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/transactions/bulk-update",
      { timeout: 10_000 },
    );
    const reviewResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/transactions/bulk-update",
      { timeout: 10_000 },
    );

    await page.getByTestId("button-bulk-mark-reviewed").click();

    const reviewReq = await reviewRequestPromise;
    const reviewRes = await reviewResponsePromise;
    expect(reviewRes.status()).toBe(200);
    const reviewSent = JSON.parse(reviewReq.postData() ?? "{}") as {
      ids: string[];
      patch: { reviewed: boolean };
    };
    expect(new Set(reviewSent.ids)).toEqual(
      new Set([targetA.id, targetB.id]),
    );
    expect(reviewSent.patch.reviewed).toBe(true);

    await expect(
      notifications.getByText(/Marked 2 as reviewed/i),
    ).toBeVisible({ timeout: 10_000 });

    // Both affected rows visibly transition to reviewed=true; the
    // control row remains unreviewed. The `data-reviewed` attribute
    // is the single source the row uses for its opacity-50 styling,
    // so this also pins the styling path.
    await expect(rowA).toHaveAttribute("data-reviewed", "true", {
      timeout: 10_000,
    });
    await expect(rowB).toHaveAttribute("data-reviewed", "true", {
      timeout: 10_000,
    });
    await expect(rowC).toHaveAttribute("data-reviewed", "false");
  });
});
