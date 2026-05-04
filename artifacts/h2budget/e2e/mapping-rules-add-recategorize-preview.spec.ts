import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #220:
 *
 * On the Mapping Rules page's "Add New Rule" form, when the user types a
 * pattern + picks a category for an unsaved rule:
 *
 *   1. The page fires
 *      POST /api/mapping-rules/recategorize-preview-by-pattern with
 *      `{ pattern, matchType, toCategoryId }` and surfaces an inline
 *      banner reading "N past transactions will move into <category>
 *      when you add this rule."
 *   2. A "Show matches" link opens the same Dialog used on every other
 *      surface (`dialog-rule-matches-preview`) listing the
 *      uncategorized historical rows that match.
 *   3. Clicking Add POSTs the rule AND chains
 *      POST /api/transactions/recategorize-by-pattern with
 *      `fromCategoryId: null`, so the past *uncategorized* rows snap
 *      onto the new category in one user action.
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

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Mapping Rules add recategorize-preview (#220)", () => {
  test("Add form previews uncategorized matches, Show-matches lists them, and Add chains the bulk recategorize with fromCategoryId=null", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "map-rules-add-recat-220",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    // Land on the Mapping Rules page so the user is provisioned.
    await signInAndOpen(page, email, password, "/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed deterministic category + uncategorized historical rows.
    // Two rows match the pattern and have no categoryId — those are the
    // candidates the Add-form preview should surface.
    const suffix = Math.random().toString(36).slice(2, 8);
    const debtName = `AddPreview-${suffix}`;
    const debtCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: debtName, kind: "expense", groupName: "Debt" },
    );

    const pattern = `E2EADDPREV-${suffix.toUpperCase()}`;
    const hist1 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-3),
        description: `${pattern} PMT XXXX9001`,
        amount: "-150.00",
        categoryId: null,
      },
    );
    const hist2 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-2),
        description: `${pattern} PMT XXXX9002`,
        amount: "-150.00",
        categoryId: null,
      },
    );

    // Reload so the page picks up the seeded category in its initial query.
    await page.goto("/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Type the pattern and pick the new category in the Add form.
    const previewResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/mapping-rules/recategorize-preview-by-pattern",
      { timeout: 10_000 },
    );

    await page.getByTestId("input-add-pattern").fill(pattern);
    // Radix Select renders the trigger as role=combobox with the
    // placeholder text inside it. Filter on that text to grab the
    // Add card's category trigger specifically.
    await page
      .getByRole("combobox")
      .filter({ hasText: "Select Category" })
      .click();
    await page.getByRole("option", { name: debtName }).first().click();

    const previewRes = await previewResponsePromise;
    expect(previewRes.status()).toBe(200);
    const previewBody = await previewRes.json();
    expect(previewBody.candidateCount).toBe(2);
    expect(previewBody.fromCategoryId).toBeNull();
    expect(previewBody.toCategoryId).toBe(debtCat.id);
    expect(previewBody.pattern).toBe(pattern);

    const previewBanner = page.getByTestId("rule-add-preview");
    await expect(previewBanner).toBeVisible({ timeout: 5_000 });
    await expect(previewBanner).toContainText(
      `2 past transactions will move into ${debtName}`,
    );
    await expect(page.getByTestId("rule-add-preview-count")).toHaveText("2");

    // --- "Show matches" opens the shared dialog with both historical rows.
    await page.getByTestId("link-show-rule-matches-add").click();
    const dialog = page.getByTestId("dialog-rule-matches-preview");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      `Move 2 past payments into ${debtName}?`,
    );

    const list = page.getByTestId("list-rule-matches");
    await expect(list).toBeVisible();
    const rows = list.locator('[data-testid^="row-rule-match-"]');
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId(`row-rule-match-${hist1.id}`)).toBeVisible();
    await expect(page.getByTestId(`row-rule-match-${hist2.id}`)).toBeVisible();

    // Cancel out of the dialog — the actual bulk recategorize fires from
    // the Add button, not from the dialog's Apply.
    await page.getByTestId("button-rule-matches-cancel").click();
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });

    // --- Click Add: POST the rule THEN POST recategorize-by-pattern.
    const createResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/mapping-rules",
      { timeout: 10_000 },
    );
    const recatRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );
    const recatResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );

    await page.getByTestId("btn-add-rule").click();

    const createRes = await createResponsePromise;
    expect(createRes.status()).toBe(201);

    const recatReq = await recatRequestPromise;
    const recatRes = await recatResponsePromise;
    expect(recatRes.status()).toBe(200);
    const sentBody = JSON.parse(recatReq.postData() ?? "{}");
    expect(sentBody.pattern).toBe(pattern);
    expect(sentBody.matchType).toBe("contains");
    // Add-flow always scopes to uncategorized rows.
    expect(sentBody.fromCategoryId).toBeNull();
    expect(sentBody.toCategoryId).toBe(debtCat.id);

    // Confirmation toast surfaces both halves of the chained operation.
    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(
        new RegExp(
          `Rule added.*moved 2 past transactions into ${debtName}`,
          "i",
        ),
      ),
    ).toBeVisible({ timeout: 5_000 });

    // Belt-and-suspenders: confirm both historical txns now point at the
    // new category server-side too.
    const allTxns = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions?limit=500");
    const byId = new Map(allTxns.map((t) => [t.id, t.categoryId] as const));
    expect(byId.get(hist1.id)).toBe(debtCat.id);
    expect(byId.get(hist2.id)).toBe(debtCat.id);

    await context.close();
  });
});
