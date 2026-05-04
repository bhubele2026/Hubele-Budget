import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for tasks #220 + #243:
 *
 * On the Mapping Rules page's "Add New Rule" form, when the user types a
 * pattern (with or without a destination category) for an unsaved rule:
 *
 *   1. As soon as the user types a pattern — *before* picking a
 *      destination category — the page fires
 *      POST /api/mapping-rules/recategorize-preview-by-pattern (with
 *      `toCategoryId` omitted) and surfaces a neutral banner reading
 *      "This would match N uncategorized past transactions. Pick a
 *      category to assign them." (Task #243)
 *   2. Picking a category upgrades the banner copy to "N past
 *      transactions will move into <category> when you add this rule."
 *      and reveals the "Show matches" link — without firing another
 *      preview request, since count + samples don't depend on the
 *      destination. (Task #243)
 *   3. The "Show matches" link opens the same Dialog used on every
 *      other surface (`dialog-rule-matches-preview`) listing the
 *      uncategorized historical rows that match. (Task #220)
 *   4. Clicking Add POSTs the rule AND chains
 *      POST /api/transactions/recategorize-by-pattern with
 *      `fromCategoryId: null`, so the past *uncategorized* rows snap
 *      onto the new category in one user action. (Task #220)
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

test.describe("Mapping Rules add recategorize-preview (#220 + #243)", () => {
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

    // --- Task #243: type a pattern *before* picking a category. The
    // preview should fire with `toCategoryId` omitted and surface the
    // neutral "would match N uncategorized past transactions" banner.
    // We also keep a count of every preview request so we can later
    // assert that picking a category does NOT trigger a refetch.
    let previewRequestCount = 0;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/mapping-rules/recategorize-preview-by-pattern"
      ) {
        previewRequestCount += 1;
      }
    });

    const neutralPreviewResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/mapping-rules/recategorize-preview-by-pattern",
      { timeout: 10_000 },
    );

    await page.getByTestId("input-add-pattern").fill(pattern);

    const neutralPreviewRes = await neutralPreviewResponsePromise;
    expect(neutralPreviewRes.status()).toBe(200);
    const neutralPreviewBody = await neutralPreviewRes.json();
    expect(neutralPreviewBody.candidateCount).toBe(2);
    expect(neutralPreviewBody.fromCategoryId).toBeNull();
    // Server echoes back null since the client didn't send it yet.
    expect(neutralPreviewBody.toCategoryId).toBeNull();
    expect(neutralPreviewBody.pattern).toBe(pattern);
    // Confirm the request body really did omit toCategoryId — guards
    // against a regression that would refetch on every category pick.
    const neutralReqBody = JSON.parse(
      neutralPreviewRes.request().postData() ?? "{}",
    );
    expect(neutralReqBody).toEqual({
      pattern,
      matchType: "contains",
    });

    const previewBanner = page.getByTestId("rule-add-preview");
    await expect(previewBanner).toBeVisible({ timeout: 5_000 });
    await expect(previewBanner).toContainText(
      "This would match 2 uncategorized past transactions",
    );
    await expect(previewBanner).toContainText("Pick a category");
    await expect(page.getByTestId("rule-add-preview-count")).toHaveText("2");
    // The Show-matches affordance should be hidden until a category
    // is picked (the upgraded copy is what surfaces it).
    await expect(page.getByTestId("link-show-rule-matches-add")).toHaveCount(
      0,
    );

    // Snapshot the count *after* the neutral preview has settled so any
    // additional fetch from picking the category would visibly bump it.
    const previewRequestsBeforeCategoryPick = previewRequestCount;

    // --- Now pick the category. The banner should upgrade in place.
    // Radix Select renders the trigger as role=combobox with the
    // placeholder text inside it. Filter on that text to grab the
    // Add card's category trigger specifically.
    await page
      .getByRole("combobox")
      .filter({ hasText: "Select Category" })
      .click();
    await page.getByRole("option", { name: debtName }).first().click();

    await expect(previewBanner).toContainText(
      `2 past transactions will move into ${debtName}`,
    );
    await expect(page.getByTestId("rule-add-preview-count")).toHaveText("2");

    // Give any rogue debounced refetch a chance to fire and assert
    // we still only saw the original preview request.
    await page.waitForTimeout(500);
    expect(previewRequestCount).toBe(previewRequestsBeforeCategoryPick);

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
