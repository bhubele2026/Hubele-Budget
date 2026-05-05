import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #200:
 *
 * On the Mapping Rules page, when the user edits an existing rule and
 * picks a different category in the inline edit form:
 *
 *   1. The page fires POST /api/mapping-rules/:id/recategorize-preview
 *      and surfaces an inline banner reading
 *      "N past transactions will move into <new category> when you save."
 *   2. A "Show matches" link opens the same Dialog used on the
 *      Chase/Transactions page (`dialog-rule-matches-preview`) listing
 *      the affected transactions.
 *   3. Clicking Save PATCHes the rule AND chains
 *      POST /api/transactions/recategorize-by-pattern with the captured
 *      `fromCategoryId`, so the past transactions snap onto the new
 *      category in one user action.
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

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Mapping Rules edit recategorize-preview (#200)", () => {
  test("inline preview reports N affected, Show-matches dialog lists them, and Save fires the bulk recategorize with the captured fromCategoryId", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "map-rules-edit-recat-200",
      provisionedUserIds,
    );

    // Land on the Mapping Rules page so the user is provisioned and the
    // edit form is the system under test.
    await signInAndOpen(page, email, password, "/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed deterministic categories + rule + transactions via the API.
    // The rule currently points at "MiscBuf"; the two historical rows
    // sit in MiscBuf so re-pointing the rule at "AmexDelta" should
    // surface candidateCount=2 in the preview.
    const suffix = Math.random().toString(36).slice(2, 8);
    const miscName = `MiscBuf-${suffix}`;
    const debtName = `AmexDelta-${suffix}`;

    const miscCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: miscName, kind: "expense", groupName: "Other" },
    );
    const debtCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: debtName, kind: "expense", groupName: "Debt" },
    );

    const pattern = `E2EMAPRULE-${suffix.toUpperCase()}`;
    const rule = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/mapping-rules",
      {
        pattern,
        matchType: "contains",
        categoryId: miscCat.id,
        priority: 50,
      },
    );

    const hist1 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-3),
        description: `${pattern} PMT XXXX1006`,
        amount: "-150.00",
        categoryId: miscCat.id,
      },
    );
    const hist2 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-2),
        description: `${pattern} PMT XXXX1007`,
        amount: "-150.00",
        categoryId: miscCat.id,
      },
    );

    // Reload so the page picks up the seeded rule + categories in its
    // initial query.
    await page.goto("/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Open the rule edit row.
    const ruleRow = page.getByTestId(`rule-row-${rule.id}`);
    await expect(ruleRow).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`rule-edit-btn-${rule.id}`).click();

    const editRow = page.getByTestId(`rule-edit-${rule.id}`);
    await expect(editRow).toBeVisible();

    // --- Watch for the preview round-trip + assert the inline banner.
    const previewResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          `/api/mapping-rules/${rule.id}/recategorize-preview`,
      { timeout: 10_000 },
    );

    // Pick the new (debt) category in the inline edit form. Radix Select
    // renders as a custom combobox so we click the trigger then the option.
    await page.getByTestId(`rule-edit-category-${rule.id}`).click();
    await page.getByRole("option", { name: debtName }).first().click();

    const previewRes = await previewResponsePromise;
    expect(previewRes.status()).toBe(200);
    const previewBody = await previewRes.json();
    expect(previewBody.candidateCount).toBe(2);
    expect(previewBody.fromCategoryId).toBe(miscCat.id);
    expect(previewBody.toCategoryId).toBe(debtCat.id);

    const previewBanner = page.getByTestId(`rule-edit-preview-${rule.id}`);
    await expect(previewBanner).toBeVisible({ timeout: 5_000 });
    await expect(previewBanner).toContainText(
      `2 past transactions will move into ${debtName}`,
    );
    await expect(
      page.getByTestId(`rule-edit-preview-count-${rule.id}`),
    ).toHaveText("2");

    // --- "Show matches" opens the shared dialog with both historical rows.
    await page
      .getByTestId(`link-show-rule-matches-edit-${rule.id}`)
      .click();
    const dialog = page.getByTestId("dialog-rule-matches-preview");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      `Move 2 past payments into ${debtName}?`,
    );

    const list = page.getByTestId("list-rule-matches");
    await expect(list).toBeVisible();
    const rows = list.locator('[data-testid^="row-rule-match-"]');
    await expect(rows).toHaveCount(2);
    await expect(
      page.getByTestId(`row-rule-match-${hist1.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`row-rule-match-${hist2.id}`),
    ).toBeVisible();

    // Cancel out of the dialog — the actual bulk recategorize on this
    // page fires from the Save button, not from the dialog's Apply.
    await page.getByTestId("button-rule-matches-cancel").click();
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });

    // --- Save: PATCH the rule THEN POST recategorize-by-pattern.
    const patchResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/mapping-rules/${rule.id}`,
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

    await page.getByTestId(`rule-save-${rule.id}`).click();

    const patchRes = await patchResponsePromise;
    expect(patchRes.status()).toBe(200);

    const recatReq = await recatRequestPromise;
    const recatRes = await recatResponsePromise;
    expect(recatRes.status()).toBe(200);
    const sentBody = JSON.parse(recatReq.postData() ?? "{}");
    expect(sentBody.pattern).toBe(pattern);
    expect(sentBody.matchType).toBe("contains");
    expect(sentBody.fromCategoryId).toBe(miscCat.id);
    expect(sentBody.toCategoryId).toBe(debtCat.id);

    // Confirmation toast surfaces both halves of the chained operation.
    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(
        new RegExp(
          `Rule updated.*moved 2 past transactions into ${debtName}`,
          "i",
        ),
      ),
    ).toBeVisible({ timeout: 5_000 });

    // Belt-and-suspenders: confirm both historical txns now point at the
    // debt category server-side too.
    const allTxns = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions?limit=500");
    const byId = new Map(allTxns.map((t) => [t.id, t.categoryId] as const));
    expect(byId.get(hist1.id)).toBe(debtCat.id);
    expect(byId.get(hist2.id)).toBe(debtCat.id);
  });
});
