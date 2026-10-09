import { test, expect, type Locator, type Page } from "@playwright/test";
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
 * was only verified by hand. This spec exercises the entry
 * points the operator uses on the transactions page:
 *
 *   1. A Transfer row is marked on the row: it carries no allowance
 *      bucket marks (CH-29 hides them on transfers).
 *   2. Picking a category on a Transfer row routes through the same
 *      `handleQuickCategorize` PATCH used by uncategorized rows.
 *      The server flips `isTransfer` to false as a side-effect (see
 *      PATCH /transactions/:id "categoryId without isTransfer" branch),
 *      so the row joins budget actuals — confirmed by the budget
 *      month roll-up gaining the row's amount under its new category.
 *   3. Toggling the Transfer checkbox in the Edit dialog persists
 *      `isTransfer` (and `isTransferUserOverridden`) server-side so
 *      a follow-up reload still reflects the user's choice.
 *
 * (C9 repair) The Chase row is the shared account row now. The old row
 * chips — the Transfer pill with its clear "X" (`badge-transfer-*`,
 * `button-clear-transfer-*`) and the inline category badge
 * (`badge-category-*`) — are not rendered on /transactions (parity CH-64:
 * the pill's handler is dead code there; the Amex rows keep theirs). So:
 * the pill pass became the row-marker check (1), the category is picked in
 * the row's CategoryPicker with "Remember" unticked (the old badge sent the
 * category alone), and "is a transfer" is read from the row's bucket marks.
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

/**
 * A Chase row is a transfer when it carries no allowance bucket marks: the
 * shared row hides WK/MO/UN/RE on transfer rows (CH-29), and shows all four
 * otherwise.
 */
async function isTransferRow(row: Locator): Promise<boolean> {
  return (await row.getByRole("button", { name: /weekly bucket/i }).count()) === 0;
}

test.describe("Transfer override flow on the transactions page (#494)", () => {
  test("a Transfer row reads as one, picking a category on a Transfer row joins budget actuals, and the Edit dialog Transfer checkbox round-trips", async ({
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

    // ===== Pass 1: a Transfer row shows as one on the row — no allowance
    // bucket marks (CH-29) — and has no clear-pill on /transactions (CH-64).
    const pillRow = await apiCall<{
      id: string;
      isTransfer: boolean;
      categoryId: string | null;
    }>(page, "POST", "/api/transactions", {
      occurredOn: isoDay(-1),
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
    expect(await isTransferRow(pillRowEl)).toBe(true);
    await expect(
      page.getByTestId(`button-clear-transfer-${pillRow.id}`),
    ).toHaveCount(0);

    const notifications = page.getByRole("region", { name: /notifications/i });

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
    expect(await isTransferRow(xferCatRowEl)).toBe(true);

    const inlineBadge = xferCatRowEl.getByTestId("button-category-picker");
    await expect(inlineBadge).toBeVisible();
    await expect(inlineBadge).toHaveText(transfersName);
    await inlineBadge.click();
    await page.getByTestId("checkbox-remember-picker").click();
    await expect(page.getByTestId("checkbox-remember-picker")).toHaveAttribute(
      "data-state",
      "unchecked",
    );

    const pickReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${xferCatRow.id}`,
      { timeout: 10_000 },
    );
    await page.getByRole("option", { name: groceriesName }).click();

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
    expect(await isTransferRow(dialogRowEl)).toBe(false);

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

    // Reload — the row should now read as a Transfer (no bucket marks), and
    // the server-side row should reflect the override flag.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(dialogRowEl).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => isTransferRow(dialogRowEl), { timeout: 10_000 })
      .toBe(true);

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
    await expect
      .poll(() => isTransferRow(dialogRowEl), { timeout: 10_000 })
      .toBe(false);

    const finalList = await apiCall<
      Array<{ id: string; isTransfer: boolean; isTransferUserOverridden: boolean }>
    >(page, "GET", "/api/transactions");
    const finalRow = finalList.find((t) => t.id === dialogRow.id);
    expect(finalRow?.isTransfer).toBe(false);
    expect(finalRow?.isTransferUserOverridden).toBe(true);

    await context.close();
  });
});
