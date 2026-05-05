import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the three flows added in task #176:
 *
 * 1. Inline categorize popover on Budget rows
 *    - Violet "N matches" badge surfaces when a description matches a
 *      mapping rule pointing at this row's category.
 *    - Clicking the badge opens the popover with the suggested txn under
 *      the "Suggested · matches rule or name" section, and the assign
 *      button targets the same category.
 *
 * 2. Actuals breakdown popover on Budget rows
 *    - Clicking the actuals number opens a popover listing every
 *      contributing transaction this month.
 *    - "View all in Transactions →" navigates to /transactions with
 *      `category=<categoryName>` and `month=<monthStart>` URL params.
 *
 * 3. Inline edit of a Mapping Rule via the new PATCH endpoint
 *    - Editing a rule and clicking the save check button issues a
 *      PATCH /api/mapping-rules/:id (not delete + create) and the row
 *      re-renders with the updated pattern.
 *
 * Up to now these flows were only covered by typecheck + vitest. The app
 * is invite-only Clerk so the runTest skill couldn't reach these screens
 * directly — this Playwright spec drives them through a real browser
 * against a freshly provisioned test user.
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

test.describe("Budget popovers + Mapping Rules inline edit (#178)", () => {
  test("violet match hint, actuals popover deep-link, and PATCH mapping-rule edit", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-popovers-178",
      provisionedUserIds,
    );

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

    const dining = categories.find((c) => c.name === "Dining & Coffee");
    const groceries = categories.find((c) => c.name === "Groceries");
    if (!dining) throw new Error("Seed missing 'Dining & Coffee' category");
    if (!groceries) throw new Error("Seed missing 'Groceries' category");

    // Seed test data via the same authenticated session:
    //   - One mapping rule whose pattern ("STARBUCKS") will trigger the
    //     violet match hint on the Dining & Coffee budget row.
    //   - One uncategorized transaction "STARBUCKS COFFEE" — the rule
    //     match makes it land in the "Suggested" section of that row's
    //     categorize popover.
    //   - One categorized transaction on Groceries — its presence drives
    //     the actuals-breakdown popover content + non-zero actual.
    const rule = await apiCall<{ id: string; pattern: string }>(
      page,
      "POST",
      "/api/mapping-rules",
      {
        pattern: "STARBUCKS",
        matchType: "contains",
        categoryId: dining.id,
        priority: 50,
      },
    );

    const today = todayIso();
    const monthStart = thisMonthStart();

    // Pass categoryId: null explicitly so the POST /transactions
    // auto-categorize pipeline (which would otherwise apply the STARBUCKS
    // rule we just created and assign Dining) leaves this row truly
    // uncategorized — the badge / popover the assertions below exercise
    // only renders for uncategorized rows.
    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "STARBUCKS COFFEE #4421",
      amount: "-7.85",
      account: "Test Bank",
      categoryId: null,
    });

    await apiCall(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "TRADER JOES",
      amount: "-42.10",
      account: "Test Bank",
      categoryId: groceries.id,
    });

    // Reload so the budget page picks up the new transactions and rule
    // in its initial useListTransactions / useListMappingRules queries.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // The page floors the displayed month at 2026-04-01 and otherwise
    // tracks today's month. The deep-link assertion below uses the same
    // computation as the page so we don't lock the spec to a calendar date.
    const MIN_MONTH = "2026-04-01";
    const expectedMonth = monthStart < MIN_MONTH ? MIN_MONTH : monthStart;

    // --- Item 1: violet "N matches" hint on the Dining row -----------------
    const categorizeBadge = page.getByTestId(
      `button-categorize-${dining.id}`,
    );
    await expect(categorizeBadge).toBeVisible({ timeout: 15_000 });
    // The badge tracks the suggested count via data-suggested-count and
    // its text flips between "+N" (no rule match) and "N match(es)" when
    // at least one uncategorized txn matches a rule for this category.
    await expect(categorizeBadge).toHaveAttribute(
      "data-suggested-count",
      "1",
    );
    await expect(categorizeBadge).toContainText(/1\s*match/i);

    await categorizeBadge.click();

    const uncategorizedList = page.getByTestId(
      `uncategorized-list-${dining.id}`,
    );
    await expect(uncategorizedList).toBeVisible();
    await expect(uncategorizedList).toContainText(
      /Suggested · matches rule or name/i,
    );
    await expect(uncategorizedList).toContainText("STARBUCKS COFFEE");
    // The assign button for the suggested txn must target the Dining
    // category — locking the testid contract used by the popover.
    await expect(
      uncategorizedList.locator(
        `[data-testid$="-to-${dining.id}"]`,
      ),
    ).toHaveCount(1);

    // Dismiss the popover before opening the next one — Radix popovers
    // close on outside click.
    await page.keyboard.press("Escape");

    // --- Item 2: actuals breakdown popover + "View all" deep link ----------
    const actualsBtn = page.getByTestId(`button-actuals-${groceries.id}`);
    await expect(actualsBtn).toBeVisible();
    await actualsBtn.click();

    const actualsList = page.getByTestId(`actuals-list-${groceries.id}`);
    await expect(actualsList).toBeVisible();
    await expect(actualsList).toContainText("TRADER JOES");

    // The Trader Joe's txn is the only contributor, so its row must
    // appear by id under data-testid="actuals-row-{txnId}".
    const actualsRows = actualsList.locator('[data-testid^="actuals-row-"]');
    await expect(actualsRows).toHaveCount(1);

    const viewAll = page.getByTestId(`button-view-all-${groceries.id}`);
    await expect(viewAll).toBeVisible();
    await viewAll.click();

    await page.waitForURL(/\/transactions\?/, { timeout: 10_000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/transactions");
    expect(url.searchParams.get("category")).toBe("Groceries");
    expect(url.searchParams.get("month")).toBe(expectedMonth);

    // --- Item 3: inline PATCH edit of a Mapping Rule -----------------------
    await page.goto("/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    const editBtn = page.getByTestId(`rule-edit-btn-${rule.id}`);
    await expect(editBtn).toBeVisible({ timeout: 15_000 });
    await editBtn.click();

    const editRow = page.getByTestId(`rule-edit-${rule.id}`);
    await expect(editRow).toBeVisible();

    // Change the pattern, then save. The save button is wired to the
    // useUpdateMappingRule mutation which fires PATCH /api/mapping-rules/:id —
    // observe the request directly so a regression to the old delete+create
    // path would fail this assertion (delete would also fire DELETE and
    // create wouldn't include :id in the URL).
    const patternInput = editRow.locator("input").first();
    await patternInput.fill("STARBUCKS RESERVE");

    const patchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/mapping-rules/${rule.id}`,
      { timeout: 10_000 },
    );
    const patchResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/mapping-rules/${rule.id}`,
      { timeout: 10_000 },
    );

    await page.getByTestId(`rule-save-${rule.id}`).click();

    const patchReq = await patchPromise;
    const patchRes = await patchResponsePromise;
    expect(patchRes.status()).toBe(200);
    const sentBody = JSON.parse(patchReq.postData() ?? "{}");
    expect(sentBody.pattern).toBe("STARBUCKS RESERVE");
    expect(sentBody.categoryId).toBe(dining.id);

    // The row should flip back to the read-only variant with the new
    // pattern visible — proves the PATCH actually mutated the row in
    // place (no duplicate row from a fallback delete+create path).
    await expect(page.getByTestId(`rule-edit-${rule.id}`)).toHaveCount(0, {
      timeout: 10_000,
    });
    const readOnlyRow = page.getByTestId(`rule-row-${rule.id}`);
    await expect(readOnlyRow).toBeVisible();
    await expect(readOnlyRow).toContainText("STARBUCKS RESERVE");

    // Belt-and-suspenders: confirm the persisted rule via the API too.
    const rules = await apiCall<Array<{ id: string; pattern: string }>>(
      page,
      "GET",
      "/api/mapping-rules",
    );
    const matching = rules.filter((r) => r.id === rule.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]!.pattern).toBe("STARBUCKS RESERVE");
  });
});
