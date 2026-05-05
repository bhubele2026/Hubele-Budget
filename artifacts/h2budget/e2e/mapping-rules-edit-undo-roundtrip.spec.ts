import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #219:
 *
 * After the Mapping Rules edit form saves a category change, the toast
 * "Rule updated · moved N past transactions into <new category>" exposes
 * an "Undo" button. Clicking Undo must revert BOTH halves of Save:
 *
 *   1. The historical transactions snap back to their pre-edit category.
 *   2. The mapping rule's `categoryId` is also re-pointed back to its
 *      pre-edit value, so future matching charges no longer auto-flip
 *      onto the user's accidental pick.
 *
 * Without (2) the user is left with the rule still pointing at the new
 * category even after the bulk move is reverted — Undo is asymmetric
 * with Save. This spec drives the full edit → save → undo round-trip
 * through the UI and asserts both the rule and the historical txns are
 * back to their pre-edit state via the API.
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

test.describe("Mapping Rules edit save → undo round-trip (#219)", () => {
  test("Undo on the post-save toast reverts BOTH the bulk recategorize AND the rule's category change", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "map-rules-edit-undo-219",
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
    // surface candidateCount=2 in the preview, then snap both rows
    // (and the rule) back into MiscBuf when Undo fires.
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

    const pattern = `E2EUNDORULE-${suffix.toUpperCase()}`;
    const rule = await apiCall<{ id: string; categoryId: string }>(
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
        description: `${pattern} PMT XXXX2001`,
        amount: "-200.00",
        categoryId: miscCat.id,
      },
    );
    const hist2 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-2),
        description: `${pattern} PMT XXXX2002`,
        amount: "-200.00",
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

    // --- Pick the new (debt) category in the inline edit form. Wait for
    // the preview round-trip so the inline banner renders before Save.
    const previewResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          `/api/mapping-rules/${rule.id}/recategorize-preview`,
      { timeout: 10_000 },
    );
    await page.getByTestId(`rule-edit-category-${rule.id}`).click();
    await page.getByRole("option", { name: debtName }).first().click();

    const previewRes = await previewResponsePromise;
    expect(previewRes.status()).toBe(200);
    await expect(
      page.getByTestId(`rule-edit-preview-count-${rule.id}`),
    ).toHaveText("2");

    // --- Save: PATCH the rule THEN POST recategorize-by-pattern.
    const patchResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/mapping-rules/${rule.id}`,
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
    const recatRes = await recatResponsePromise;
    expect(recatRes.status()).toBe(200);

    // Sanity-check: post-save state should have moved the rule + both
    // txns onto the debt category.
    const rulesAfterSave = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/mapping-rules");
    expect(
      rulesAfterSave.find((r) => r.id === rule.id)?.categoryId,
    ).toBe(debtCat.id);
    {
      const allTxns = await apiCall<
        Array<{ id: string; categoryId: string | null }>
      >(page, "GET", "/api/transactions?limit=500");
      const byId = new Map(
        allTxns.map((t) => [t.id, t.categoryId] as const),
      );
      expect(byId.get(hist1.id)).toBe(debtCat.id);
      expect(byId.get(hist2.id)).toBe(debtCat.id);
    }

    // --- Find the post-save toast + click its Undo action. The toast
    // surfaces inside the notifications region (matches the existing
    // bulk-recategorize Undo testid pattern: action-undo-bulk-
    // recategorize-edit).
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

    // The Undo round-trip fires a second POST to recategorize-by-pattern,
    // this time with the swapped from/to AND the originating ruleId so
    // the server also re-points the mapping rule back to its pre-edit
    // category in the same call.
    const undoRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );
    const undoResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );

    await page
      .getByTestId("action-undo-bulk-recategorize-edit")
      .click();

    const undoReq = await undoRequestPromise;
    const undoRes = await undoResponsePromise;
    expect(undoRes.status()).toBe(200);

    // Body assertions: from/to swapped vs Save, ids whitelisted to the
    // exact rows the original bulk touched, and ruleId carried so the
    // rule re-point happens on the server.
    const undoBody = JSON.parse(undoReq.postData() ?? "{}");
    expect(undoBody.pattern).toBe(pattern);
    expect(undoBody.matchType).toBe("contains");
    expect(undoBody.fromCategoryId).toBe(debtCat.id);
    expect(undoBody.toCategoryId).toBe(miscCat.id);
    expect(Array.isArray(undoBody.ids)).toBe(true);
    expect(new Set<string>(undoBody.ids)).toEqual(
      new Set([hist1.id, hist2.id]),
    );
    expect(undoBody.ruleId).toBe(rule.id);

    // Confirmation toast acknowledges both halves were reverted.
    await expect(
      notifications.getByText(/Reverted 2 transactions and rule/i),
    ).toBeVisible({ timeout: 5_000 });

    // --- Server-side: BOTH the rule AND the two historical txns must
    // be back at the pre-edit MiscBuf category.
    const allRules = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/mapping-rules");
    const ruleAfterUndo = allRules.find((r) => r.id === rule.id);
    expect(ruleAfterUndo?.categoryId).toBe(miscCat.id);

    const allTxns = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions?limit=500");
    const byId = new Map(
      allTxns.map((t) => [t.id, t.categoryId] as const),
    );
    expect(byId.get(hist1.id)).toBe(miscCat.id);
    expect(byId.get(hist2.id)).toBe(miscCat.id);

    // --- UI: the read-only rule row's category badge must repaint with
    // the restored category — this is the visible payoff of
    // invalidating the mapping rules cache after Undo.
    await expect(
      page.getByTestId(`rule-category-${rule.id}`),
    ).toHaveText(miscName, { timeout: 5_000 });
  });
});
