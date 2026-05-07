import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #494:
 *
 * The Transfer override flow has API-level integration tests
 * (`transferOverride.integration.test.ts`) but the user-facing surface
 * was only verified by hand. This spec exercises the three entry
 * points the operator uses on the transactions page:
 *
 *   1. Clicking the X on a row's Transfer pill clears the flag and
 *      the row stops being marked as a transfer after a reload.
 *   2. Picking a category on a Transfer row routes through the same
 *      `handleQuickCategorize` PATCH used by uncategorized rows.
 *      The server flips `isTransfer` to false as a side-effect (see
 *      PATCH /transactions/:id "categoryId without isTransfer" branch),
 *      so the row joins budget actuals — confirmed by the budget
 *      month roll-up gaining the row's amount under its new category.
 *   3. Toggling the Transfer checkbox in the Edit dialog persists
 *      `isTransfer` (and `isTransferUserOverridden`) server-side so
 *      a follow-up reload still reflects the user's choice.
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

type BudgetMonth = {
  groups: Array<{
    groupName: string;
    lines: Array<{
      categoryId: string;
      categoryName: string;
      actualAmount: string;
    }>;
  }>;
};

function actualForCategory(month: BudgetMonth, categoryId: string): number {
  for (const g of month.groups) {
    for (const l of g.lines) {
      if (l.categoryId === categoryId) return parseFloat(l.actualAmount) || 0;
    }
  }
  return 0;
}

test.describe("Transfer override flow on the transactions page (#494)", () => {
  test("Transfer pill X clears the flag, picking a category on a Transfer row joins budget actuals, and the Edit dialog Transfer checkbox round-trips", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-transfer-494",
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

    const suffix = Math.random().toString(36).slice(2, 8);
    const transfersName = `Transfers494-${suffix}`;
    const groceriesName = `Groceries494-${suffix}`;

    const transfersCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: transfersName, kind: "expense", groupName: "Other" },
    );
    const groceriesCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: groceriesName, kind: "expense", groupName: "Food" },
    );

    // ===== Pass 1: clear the Transfer pill on a row that has a
    // category (so the row's chips include the inline picker AND the
    // Transfer pill). The server's PATCH branch sets
    // isTransferUserOverridden=true on isTransfer=false.
    const pillRow = await apiCall<{
      id: string;
      isTransfer: boolean;
      categoryId: string | null;
    }>(page, "POST", "/api/transactions", {
      occurredOn: isoDay(-1),
      // Use a description that matches no suggestion heuristic so the
      // CategorizeChip's "Categorize as X" suggestion doesn't appear
      // in pass 2 and steal the click. (#494)
      description: `XFER-PILL-${suffix.toUpperCase()}-ZZZZZ`,
      amount: "-50.00",
      categoryId: transfersCat.id,
      isTransfer: true,
    });
    expect(pillRow.isTransfer).toBe(true);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const pillRowEl = page.getByTestId(`row-tx-${pillRow.id}`);
    await expect(pillRowEl).toBeVisible({ timeout: 15_000 });
    const transferBadge = page.getByTestId(`badge-transfer-${pillRow.id}`);
    await expect(transferBadge).toBeVisible();

    const clearReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${pillRow.id}`,
      { timeout: 10_000 },
    );
    await page.getByTestId(`button-clear-transfer-${pillRow.id}`).click();
    const clearReq = await clearReqPromise;
    const clearBody = JSON.parse(clearReq.postData() ?? "{}");
    expect(clearBody.isTransfer).toBe(false);

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(
      notifications.getByText(/^Cleared Transfer flag$/),
    ).toBeVisible({ timeout: 5_000 });

    // Reload — the server-persisted state should keep the pill gone.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`row-tx-${pillRow.id}`)).toBeVisible();
    await expect(
      page.getByTestId(`badge-transfer-${pillRow.id}`),
    ).toHaveCount(0);

    const afterClearList = await apiCall<
      Array<{ id: string; isTransfer: boolean; isTransferUserOverridden: boolean }>
    >(page, "GET", "/api/transactions");
    const afterClear = afterClearList.find((t) => t.id === pillRow.id);
    expect(afterClear?.isTransfer).toBe(false);
    expect(afterClear?.isTransferUserOverridden).toBe(true);

    // ===== Pass 2: a Transfer row with a category — switch the
    // category via the inline picker. The server's PATCH branch
    // ("body sets a non-null categoryId without isTransfer") flips
    // isTransfer to false as a side-effect, which lets the row count
    // toward budget actuals for the new category.
    const xferCatRow = await apiCall<{
      id: string;
      isTransfer: boolean;
      categoryId: string | null;
    }>(page, "POST", "/api/transactions", {
      occurredOn: isoDay(-2),
      description: `XFER-CAT-${suffix.toUpperCase()}-ZZZZZ`,
      amount: "-37.25",
      categoryId: transfersCat.id,
      isTransfer: true,
    });
    expect(xferCatRow.isTransfer).toBe(true);

    // Baseline: this Transfer row is excluded from budget actuals on
    // its target ("Groceries") category. (We don't assert on the
    // current "Transfers" category because pass 1's pill-clear above
    // already promoted a row of the same category into actuals.)
    const monthBefore = await apiCall<BudgetMonth>(
      page,
      "GET",
      `/api/budget/months/${monthStart}`,
    );
    const groceriesBefore = actualForCategory(monthBefore, groceriesCat.id);
    expect(groceriesBefore).toBe(0);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const xferCatRowEl = page.getByTestId(`row-tx-${xferCatRow.id}`);
    await expect(xferCatRowEl).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(`badge-transfer-${xferCatRow.id}`),
    ).toBeVisible();

    const inlineBadge = page.getByTestId(`badge-category-${xferCatRow.id}`);
    await expect(inlineBadge).toBeVisible();
    await expect(inlineBadge).toHaveText(transfersName);
    await inlineBadge.click();

    const pickReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${xferCatRow.id}`,
      { timeout: 10_000 },
    );
    await page
      .getByTestId(
        `option-inline-category-${xferCatRow.id}-${groceriesCat.id}`,
      )
      .click();

    const pickReq = await pickReqPromise;
    const pickBody = JSON.parse(pickReq.postData() ?? "{}");
    expect(pickBody.categoryId).toBe(groceriesCat.id);
    // The inline picker only forwards the category — the server is the
    // one that flips isTransfer as a side-effect.
    expect(Object.prototype.hasOwnProperty.call(pickBody, "isTransfer"))
      .toBe(false);

    await expect(notifications.getByText(/^Categorized$/)).toBeVisible({
      timeout: 5_000,
    });

    const afterPickList = await apiCall<
      Array<{
        id: string;
        isTransfer: boolean;
        isTransferUserOverridden: boolean;
        categoryId: string | null;
      }>
    >(page, "GET", "/api/transactions");
    const afterPick = afterPickList.find((t) => t.id === xferCatRow.id);
    expect(afterPick?.categoryId).toBe(groceriesCat.id);
    expect(afterPick?.isTransfer).toBe(false);
    expect(afterPick?.isTransferUserOverridden).toBe(true);

    // The row now contributes to budget actuals on the Groceries
    // category (it had been excluded as a Transfer before the pick).
    const monthAfter = await apiCall<BudgetMonth>(
      page,
      "GET",
      `/api/budget/months/${monthStart}`,
    );
    expect(actualForCategory(monthAfter, groceriesCat.id)).toBeCloseTo(
      groceriesBefore + 37.25,
      2,
    );

    // ===== Pass 3: Edit dialog Transfer checkbox round-trips. Start
    // with a non-transfer row and toggle the checkbox on; the PATCH
    // body should forward isTransfer=true (only because the toggle's
    // value changed — see the `transferChanged` branch in onSubmit)
    // and a reload should still show the Transfer pill.
    const dialogRow = await apiCall<{
      id: string;
      isTransfer: boolean;
      categoryId: string | null;
    }>(page, "POST", "/api/transactions", {
      occurredOn: isoDay(-3),
      description: `XFER-DIALOG-${suffix.toUpperCase()}-ZZZZZ`,
      amount: "-19.99",
      categoryId: groceriesCat.id,
    });
    expect(dialogRow.isTransfer).toBe(false);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    const dialogRowEl = page.getByTestId(`row-tx-${dialogRow.id}`);
    await expect(dialogRowEl).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(`badge-transfer-${dialogRow.id}`),
    ).toHaveCount(0);

    await page.getByTestId(`button-edit-tx-${dialogRow.id}`).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Edit Transaction")).toBeVisible();

    const checkbox = page.getByTestId("checkbox-is-transfer");
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked();

    const toggleReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${dialogRow.id}`,
      { timeout: 10_000 },
    );
    const toggleResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${dialogRow.id}`,
      { timeout: 10_000 },
    );
    await dialog.getByRole("button", { name: /^save$/i }).click();
    const toggleReq = await toggleReqPromise;
    const toggleRes = await toggleResPromise;
    expect(toggleRes.status()).toBe(200);
    const toggleBody = JSON.parse(toggleReq.postData() ?? "{}");
    expect(toggleBody.isTransfer).toBe(true);
    // No-op same-category save must not forward `categoryId` (#241).
    expect(Object.prototype.hasOwnProperty.call(toggleBody, "categoryId"))
      .toBe(false);

    await expect(dialog).toBeHidden();

    // Reload — the Transfer pill should now be on the row, and the
    // server-side row should reflect the override flag.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(`badge-transfer-${dialogRow.id}`),
    ).toBeVisible();

    const afterToggleOnList = await apiCall<
      Array<{ id: string; isTransfer: boolean; isTransferUserOverridden: boolean }>
    >(page, "GET", "/api/transactions");
    const afterToggleOn = afterToggleOnList.find((t) => t.id === dialogRow.id);
    expect(afterToggleOn?.isTransfer).toBe(true);
    expect(afterToggleOn?.isTransferUserOverridden).toBe(true);

    // Re-open the dialog and toggle the checkbox back off — confirms
    // the round-trip in both directions.
    await page.getByTestId(`button-edit-tx-${dialogRow.id}`).click();
    await expect(dialog).toBeVisible();
    await expect(checkbox).toBeChecked();
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();

    const offReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${dialogRow.id}`,
      { timeout: 10_000 },
    );
    await dialog.getByRole("button", { name: /^save$/i }).click();
    const offReq = await offReqPromise;
    const offBody = JSON.parse(offReq.postData() ?? "{}");
    expect(offBody.isTransfer).toBe(false);

    await expect(dialog).toBeHidden();
    await expect(
      page.getByTestId(`badge-transfer-${dialogRow.id}`),
    ).toHaveCount(0);

    const finalList = await apiCall<
      Array<{ id: string; isTransfer: boolean; isTransferUserOverridden: boolean }>
    >(page, "GET", "/api/transactions");
    const finalRow = finalList.find((t) => t.id === dialogRow.id);
    expect(finalRow?.isTransfer).toBe(false);
    expect(finalRow?.isTransferUserOverridden).toBe(true);

    await context.close();
  });
});
