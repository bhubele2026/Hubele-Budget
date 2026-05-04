import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for Task #223 — bulk-select & bulk-delete
 * mapping rules with a single Undo toast that restores the whole batch.
 *
 * The flow:
 *   1. Seed three mapping rules so we have something to bulk-delete.
 *   2. Tick two of them, leave the third unchecked.
 *   3. Click "Delete selected (2)" — both selected rows disappear,
 *      the unselected row stays put, and a single toast "Deleted 2
 *      rules" appears with one Undo action.
 *   4. Click Undo — both rules come back (matched on pattern, since
 *      the server may issue new ids on re-create) and the toast
 *      changes to "Restored 2 rules".
 *   5. Header checkbox interaction with search: search for one
 *      pattern, hit the header checkbox to "select all visible",
 *      and confirm only the visible row is added to the selection
 *      (rows hidden by the search filter are not touched).
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

type MappingRule = {
  id: string;
  pattern: string;
  matchType: string;
  categoryId: string | null;
  priority: number;
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

test.describe("Mapping Rules bulk select & delete (#223)", () => {
  test("bulk delete with single undo toast restores the whole batch", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "mapping-bulk-delete-223",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    // Land on /budget first so the default-budget seed runs and we
    // get categories to point our test rules at.
    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

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

    const dining = categories.find((c) => c.name === "Dining & Coffee");
    const groceries = categories.find((c) => c.name === "Groceries");
    if (!dining) throw new Error("Seed missing 'Dining & Coffee' category");
    if (!groceries) throw new Error("Seed missing 'Groceries' category");

    // Seed three deterministic rules. Patterns are unique so we can
    // assert against them by text after the optimistic round-trip
    // (Undo recreates rules with new ids).
    const seedRules: Array<{
      pattern: string;
      matchType: string;
      categoryId: string;
      priority: number;
    }> = [
      {
        pattern: "BULK_TEST_STARBUCKS",
        matchType: "contains",
        categoryId: dining.id,
        priority: 70,
      },
      {
        pattern: "BULK_TEST_TRADERJOE",
        matchType: "contains",
        categoryId: groceries.id,
        priority: 60,
      },
      {
        pattern: "BULK_TEST_AMAZON",
        matchType: "contains",
        categoryId: groceries.id,
        priority: 50,
      },
    ];

    const created: MappingRule[] = [];
    for (const r of seedRules) {
      created.push(
        await apiCall<MappingRule>(page, "POST", "/api/mapping-rules", r),
      );
    }
    const [starbucks, traderjoe, amazon] = created;
    if (!starbucks || !traderjoe || !amazon) {
      throw new Error("Seed rules failed to create");
    }

    await page.goto("/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    const starbucksRow = page.getByTestId(`rule-row-${starbucks.id}`);
    const traderjoeRow = page.getByTestId(`rule-row-${traderjoe.id}`);
    const amazonRow = page.getByTestId(`rule-row-${amazon.id}`);
    await expect(starbucksRow).toBeVisible();
    await expect(traderjoeRow).toBeVisible();
    await expect(amazonRow).toBeVisible();

    // --- Tick two rows; the bulk bar shows "Delete selected (2)" ----------
    await page.getByTestId(`rule-select-${starbucks.id}`).click();
    await page.getByTestId(`rule-select-${traderjoe.id}`).click();

    const bulkDeleteBtn = page.getByTestId("rule-bulk-delete");
    await expect(bulkDeleteBtn).toBeVisible();
    await expect(bulkDeleteBtn).toContainText("Delete selected (2)");

    // --- Bulk delete → both rows disappear, third one stays ---------------
    await bulkDeleteBtn.click();
    await expect(starbucksRow).toHaveCount(0, { timeout: 10_000 });
    await expect(traderjoeRow).toHaveCount(0, { timeout: 10_000 });
    await expect(amazonRow).toBeVisible();

    // Toast shows the batch count + a single Undo action.
    const toast = page.getByText(/Deleted 2 rules/i).first();
    await expect(toast).toBeVisible({ timeout: 5_000 });
    const undoBtn = page.getByTestId("action-undo-bulk-delete-rules");
    await expect(undoBtn).toBeVisible();

    // Confirm the server actually deleted both — no stale rows lingering.
    let serverRules = await apiCall<MappingRule[]>(
      page,
      "GET",
      "/api/mapping-rules",
    );
    let patterns = new Set(serverRules.map((r) => r.pattern));
    expect(patterns.has("BULK_TEST_STARBUCKS")).toBe(false);
    expect(patterns.has("BULK_TEST_TRADERJOE")).toBe(false);
    expect(patterns.has("BULK_TEST_AMAZON")).toBe(true);

    // --- Undo restores the whole batch in one click -----------------------
    await undoBtn.click();
    await expect(page.getByText(/Restored 2 rules/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Both deleted rows should be back. The recreated rules may carry
    // new ids, so we assert against the visible pattern text rather
    // than the original testids.
    await expect
      .poll(
        async () => {
          serverRules = await apiCall<MappingRule[]>(
            page,
            "GET",
            "/api/mapping-rules",
          );
          patterns = new Set(serverRules.map((r) => r.pattern));
          return [
            patterns.has("BULK_TEST_STARBUCKS"),
            patterns.has("BULK_TEST_TRADERJOE"),
            patterns.has("BULK_TEST_AMAZON"),
          ].every(Boolean);
        },
        { timeout: 10_000, intervals: [250, 500, 1000] },
      )
      .toBe(true);

    // Belt-and-suspenders: row count for each pattern should be exactly 1
    // (no accidental duplication on Undo).
    expect(
      serverRules.filter((r) => r.pattern === "BULK_TEST_STARBUCKS"),
    ).toHaveLength(1);
    expect(
      serverRules.filter((r) => r.pattern === "BULK_TEST_TRADERJOE"),
    ).toHaveLength(1);

    // --- Header checkbox is scoped to currently filtered rows -------------
    // Search for the unique test pattern — only that one row stays
    // visible. The default seed includes its own STARBUCKS rule too,
    // so we have to filter on the test-only prefix to keep the
    // assertion deterministic. Clicking the "select all visible"
    // header checkbox should then add exactly that one row to the
    // selection, leaving every other (hidden) row untouched.
    await page.getByTestId("input-search-rules").fill("BULK_TEST_STARBUCKS");
    // After Undo the rule has a new id — find it by current pattern.
    const restoredRules = await apiCall<MappingRule[]>(
      page,
      "GET",
      "/api/mapping-rules",
    );
    const restoredStarbucks = restoredRules.find(
      (r) => r.pattern === "BULK_TEST_STARBUCKS",
    );
    if (!restoredStarbucks) throw new Error("Restored Starbucks rule missing");
    await expect(
      page.getByTestId(`rule-row-${restoredStarbucks.id}`),
    ).toBeVisible();
    // Other rows are filtered out.
    await expect(page.getByTestId(`rule-row-${amazon.id}`)).toHaveCount(0);

    await page.getByTestId("rule-select-all").click();
    const bulkDeleteBtn2 = page.getByTestId("rule-bulk-delete");
    await expect(bulkDeleteBtn2).toContainText("Delete selected (1)");

    await context.close();
  });
});
