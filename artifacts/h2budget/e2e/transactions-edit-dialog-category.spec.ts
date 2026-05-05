import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #241 (follow-up of #234):
 *
 * The Edit-Transaction dialog exposes the same Category combobox the Add
 * dialog uses (Task #234). On submit the page's `onSubmit` branches:
 *
 *   - When the user picked a *different* category, PATCH /transactions/:id
 *     forwards the new `categoryId`. The success path mirrors the row's
 *     quick-categorize chip: a "Categorized" toast (with the same
 *     ruleAction-aware Undo affordance the chip uses).
 *   - When the user saves with the category *unchanged*, the PATCH body
 *     deliberately OMITS `categoryId` so the server-side mapping-rule
 *     auto-learn / repoint side effects don't fire on a no-op edit. The
 *     toast falls back to the plain "Transaction updated" copy.
 *
 * The Add dialog already has a permanent spec
 * (`transactions-new-dialog-category.spec.ts`); this spec gives the Edit
 * path the equivalent regression net.
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

function thisMonthStart(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Edit-Transaction dialog Category combobox (#241)", () => {
  test("pre-fills the existing category, PATCHes a changed pick with a 'Categorized' toast, and falls back to 'Transaction updated' when the category is left unchanged", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-edit-cat-241",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    const monthStart = thisMonthStart();
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed two distinct categories and a transaction pre-assigned
    // to the first one. No mapping rules are seeded so the Edit dialog
    // has no rule churn surface to worry about — the test isolates the
    // changed-vs-unchanged categoryId branching in `onSubmit`.
    const suffix = Math.random().toString(36).slice(2, 8);
    const groceriesName = `Groceries241-${suffix}`;
    const diningName = `Dining241-${suffix}`;
    const description = `EDIT-CAT-${suffix.toUpperCase()} MARKET`;

    const groceriesCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: groceriesName, kind: "expense", groupName: "Food" },
    );
    const diningCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: diningName, kind: "expense", groupName: "Food" },
    );
    const seeded = await apiCall<{ id: string; categoryId: string | null }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-1),
        description,
        amount: "-12.34",
        categoryId: groceriesCat.id,
      },
    );
    expect(seeded.categoryId).toBe(groceriesCat.id);

    // Reload so the freshly-seeded row + categories land in the page's
    // react-query caches that the Edit dialog reads from.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId(`row-tx-${seeded.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // ===== Pass 1: change the category from Groceries → Dining.
    await page.getByTestId(`button-edit-tx-${seeded.id}`).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Edit Transaction")).toBeVisible();

    // Combobox should be pre-filled with the row's existing category.
    const combobox = page.getByTestId("combobox-new-tx-category");
    await expect(combobox).toBeVisible();
    await expect(combobox).toContainText(groceriesName);

    // Pick the second category.
    await combobox.click();
    await page.getByTestId(`option-new-tx-category-${diningCat.id}`).click();
    await expect(combobox).toContainText(diningName);

    // Submit and capture the PATCH so we can assert the body actually
    // forwards the new categoryId (the changed branch in onSubmit).
    const changedReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    const changedResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    await dialog.getByRole("button", { name: /^save$/i }).click();

    const changedReq = await changedReqPromise;
    const changedRes = await changedResPromise;
    expect(changedRes.status()).toBe(200);

    const changedBody = JSON.parse(changedReq.postData() ?? "{}");
    expect(changedBody.categoryId).toBe(diningCat.id);

    // The "Categorized" toast (not the plain "Transaction updated"
    // fallback) should fire on the changed-category path.
    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(notifications.getByText(/^Categorized$/)).toBeVisible({
      timeout: 5_000,
    });

    // GET /api/transactions should reflect the new categoryId
    // server-side, proving the change was actually persisted (not just
    // optimistically updated in the cache).
    const listAfterChange = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions");
    const persisted = listAfterChange.find((t) => t.id === seeded.id);
    expect(persisted?.categoryId).toBe(diningCat.id);

    // Wait for the dialog to close before reopening so the second pass
    // doesn't race the first dialog's unmount.
    await expect(dialog).toBeHidden();

    // ===== Pass 2 (bonus): saving with the category unchanged should
    // hit the "Transaction updated" branch — no `categoryId` in the
    // PATCH body (so no rule auto-learn / repoint can fire), and the
    // ruleAction-aware "Categorized" toast must NOT show.
    await page.getByTestId(`button-edit-tx-${seeded.id}`).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Edit Transaction")).toBeVisible();
    await expect(combobox).toContainText(diningName);

    const unchangedReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    const unchangedResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    await dialog.getByRole("button", { name: /^save$/i }).click();

    const unchangedReq = await unchangedReqPromise;
    const unchangedRes = await unchangedResPromise;
    expect(unchangedRes.status()).toBe(200);

    const unchangedBody = JSON.parse(unchangedReq.postData() ?? "{}");
    // The no-op branch in onSubmit deliberately omits `categoryId` from
    // the payload so PATCH /transactions/:id's mapping-rule side
    // effects (auto-learn / repoint) don't run on a same-category save.
    expect(Object.prototype.hasOwnProperty.call(unchangedBody, "categoryId"))
      .toBe(false);
    expect(unchangedBody.description).toBe(description);

    await expect(notifications.getByText(/^Transaction updated$/)).toBeVisible({
      timeout: 5_000,
    });

    // The category server-side stays put.
    const listAfterUnchanged = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions");
    const stillDining = listAfterUnchanged.find((t) => t.id === seeded.id);
    expect(stillDining?.categoryId).toBe(diningCat.id);

    await context.close();
  });
});
