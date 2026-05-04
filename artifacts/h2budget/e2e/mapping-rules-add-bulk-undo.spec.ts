import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #242:
 *
 * The Add-rule flow's chained bulk recategorize toast offers an Undo
 * affordance. Clicking Undo POSTs the affected transaction ids to
 * /transactions/uncategorize-by-ids with `fromCategoryId` set to the
 * category the bulk moved them into, so:
 *   - rows still in that category get flipped back to uncategorized
 *   - rows the user has since manually re-edited away from that
 *     category are preserved (the server's guard skips them)
 *
 * The freshly-added mapping rule is left in place — the user can
 * delete it via the row-level Trash with its own Undo if they want.
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

test.describe("Mapping Rules add-flow bulk Undo (#242)", () => {
  test("Undo restores the rule-added bulk's affected rows back to uncategorized while preserving rows the user has since re-edited", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "map-rules-add-undo-242",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed two destination categories + three uncategorized historical
    // rows that match the pattern the user is about to add.
    const suffix = Math.random().toString(36).slice(2, 8);
    const debtName = `AddUndo-${suffix}`;
    const otherName = `Other-${suffix}`;
    const debtCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: debtName, kind: "expense", groupName: "Debt" },
    );
    const otherCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: otherName, kind: "expense", groupName: "Debt" },
    );

    const pattern = `E2EADDUNDO-${suffix.toUpperCase()}`;
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
    const hist3 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-1),
        description: `${pattern} PMT XXXX9003`,
        amount: "-150.00",
        categoryId: null,
      },
    );

    await page.goto("/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the inline preview round-trip so the Add chain fires the
    // bulk recategorize (the snapshot must line up with the pattern +
    // category the user is about to save).
    const previewResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/mapping-rules/recategorize-preview-by-pattern",
      { timeout: 10_000 },
    );
    await page.getByTestId("input-add-pattern").fill(pattern);
    await page
      .getByRole("combobox")
      .filter({ hasText: "Select Category" })
      .click();
    await page.getByRole("option", { name: debtName }).first().click();
    const previewRes = await previewResponsePromise;
    expect(previewRes.status()).toBe(200);

    // --- Click Add: bulk recategorize fires; Undo button surfaces on
    // the success toast.
    const recatResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );
    await page.getByTestId("btn-add-rule").click();
    const recatRes = await recatResponsePromise;
    expect(recatRes.status()).toBe(200);

    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(
        new RegExp(
          `Rule added.*moved 3 past transactions into ${debtName}`,
          "i",
        ),
      ),
    ).toBeVisible({ timeout: 5_000 });

    // Sanity check: all three rows are now in the new category.
    const afterBulk = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions?limit=500");
    const afterBulkById = new Map(
      afterBulk.map((t) => [t.id, t.categoryId] as const),
    );
    expect(afterBulkById.get(hist1.id)).toBe(debtCat.id);
    expect(afterBulkById.get(hist2.id)).toBe(debtCat.id);
    expect(afterBulkById.get(hist3.id)).toBe(debtCat.id);

    // --- Manually re-categorize one row away from debtCat. The Undo
    // should preserve this row (the server's `fromCategoryId === debtCat`
    // guard skips it) and only flip back the other two.
    await apiCall(page, "PATCH", `/api/transactions/${hist3.id}`, {
      categoryId: otherCat.id,
    });

    // --- Click Undo. The toast button posts to /uncategorize-by-ids
    // with the affected ids + debtCat as the guard category.
    const undoRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/transactions/uncategorize-by-ids",
      { timeout: 10_000 },
    );
    const undoResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/transactions/uncategorize-by-ids",
      { timeout: 10_000 },
    );

    await page.getByTestId("action-undo-add-rule-bulk").click();

    const undoReq = await undoRequestPromise;
    const undoRes = await undoResponsePromise;
    expect(undoRes.status()).toBe(200);
    const undoBody = JSON.parse(undoReq.postData() ?? "{}");
    expect(undoBody.fromCategoryId).toBe(debtCat.id);
    expect(Array.isArray(undoBody.ids)).toBe(true);
    // The bulk affected all three rows so the Undo whitelist mirrors that
    // even though one has since been re-edited (the server guard skips
    // re-edited rows on its own).
    expect(undoBody.ids).toEqual(
      expect.arrayContaining([hist1.id, hist2.id, hist3.id]),
    );

    await expect(
      notifications.getByText(/Restored 2 transactions to uncategorized/i),
    ).toBeVisible({ timeout: 5_000 });

    // --- Server-side: hist1 + hist2 are uncategorized again; hist3
    // keeps the manual re-edit; the rule itself is still in place.
    const afterUndo = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions?limit=500");
    const afterUndoById = new Map(
      afterUndo.map((t) => [t.id, t.categoryId] as const),
    );
    expect(afterUndoById.get(hist1.id)).toBeNull();
    expect(afterUndoById.get(hist2.id)).toBeNull();
    expect(afterUndoById.get(hist3.id)).toBe(otherCat.id);

    const rules = await apiCall<
      Array<{ id: string; pattern: string; categoryId: string | null }>
    >(page, "GET", "/api/mapping-rules");
    const addedRule = rules.find((r) => r.pattern === pattern);
    expect(addedRule).toBeDefined();
    expect(addedRule?.categoryId).toBe(debtCat.id);

    await context.close();
  });
});
