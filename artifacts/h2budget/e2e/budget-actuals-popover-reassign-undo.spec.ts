import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #340 — the inline re-categorize picker
 * task #295 added to each row of the actuals breakdown popover on the
 * Budget page, plus its "Categorized" toast Undo.
 *
 * Locks in three behaviors the next refactor of budget.tsx must not
 * silently break:
 *   1. Picking a different category from a row's `…` picker re-points
 *      the underlying transaction (PATCH /api/transactions/:id).
 *   2. Both the popover total in the header AND the budget row's
 *      actual refresh in place — the React Query invalidations fire
 *      against both the transactions list and the current budget month.
 *   3. The "Categorized" toast renders with an Undo action that
 *      restores the transaction to its original category, and the
 *      popover total + row actual snap back accordingly.
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

type Transaction = {
  id: string;
  description: string;
  amount: string;
  categoryId: string | null;
};

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

function todayIso(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Budget actuals popover re-categorize + Undo (#340)", () => {
  test("picker re-points txn, popover total + row actual refresh, Undo restores", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-actuals-reassign-340",
      provisionedUserIds,
    );

    // First visit auto-fires POST /budget/seed-defaults so we have
    // categories to reassign between.
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

    const groceries = categories.find((c) => c.name === "Groceries");
    const dining = categories.find((c) => c.name === "Dining & Coffee");
    if (!groceries) throw new Error("Seed missing 'Groceries' category");
    if (!dining) throw new Error("Seed missing 'Dining & Coffee' category");

    // Two transactions on Groceries so the popover total has something
    // to refresh against (1 txn / 2 txns is observable; total flips
    // from -$60 to -$40 when we move the smaller one to Dining).
    const today = todayIso();
    const big = await apiCall<Transaction>(page, "POST", "/api/transactions", {
      occurredOn: today,
      description: "TRADER JOES",
      amount: "-40.00",
      account: "Test Bank",
      categoryId: groceries.id,
    });
    const small = await apiCall<Transaction>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: today,
        description: "WHOLE FOODS LATTE",
        amount: "-20.00",
        account: "Test Bank",
        categoryId: groceries.id,
      },
    );

    // Reload so the budget page picks up the seeded transactions in
    // its initial useListTransactions / useGetBudgetMonth queries.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // --- Open the actuals breakdown popover for Groceries ----------------
    const groceriesActualsBtn = page.getByTestId(
      `button-actuals-${groceries.id}`,
    );
    await expect(groceriesActualsBtn).toBeVisible({ timeout: 15_000 });
    // Row's actual reflects both txns ($60.00 of spend) before reassign.
    // Budget lines store actuals as positive "spent" amounts, so the
    // displayed text is "$60.00" — distinct from the per-row txn amounts
    // inside the popover, which are signed (-$40.00 / -$20.00).
    await expect(groceriesActualsBtn).toHaveText("$60.00");
    await groceriesActualsBtn.click();

    const groceriesList = page.getByTestId(`actuals-list-${groceries.id}`);
    await expect(groceriesList).toBeVisible();
    // Both contributing txns are listed.
    await expect(
      groceriesList.locator('[data-testid^="actuals-row-"]'),
    ).toHaveCount(2);

    // The popover header surfaces a "<n> txns · <total>" summary —
    // assert it directly so the in-place refresh after reassign is
    // observable, not just the row count. The list's direct parent is
    // the PopoverContent, which also contains the header line.
    const popoverContent = groceriesList.locator("xpath=..");
    await expect(popoverContent).toContainText(/2\s*txns\s*·\s*\$60\.00/);

    // --- Re-categorize the small txn from Groceries → Dining --------------
    const reassignBtn = page.getByTestId(`button-reassign-${small.id}`);
    await expect(reassignBtn).toBeVisible();
    await reassignBtn.click();

    // The picker popover lists Dining as a target.
    const pickerItem = page.getByTestId(
      `item-reassign-${small.id}-to-${dining.id}`,
    );
    await expect(pickerItem).toBeVisible();

    // Capture the PATCH so we can assert the right txn + payload were
    // sent (regression guard against a refactor that wires the picker
    // to e.g. POST /transactions/bulk-categorize instead).
    const patchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${small.id}`,
      { timeout: 10_000 },
    );
    await pickerItem.click();
    const patchReq = await patchPromise;
    const sentBody = JSON.parse(patchReq.postData() ?? "{}");
    expect(sentBody.categoryId).toBe(dining.id);

    // --- Toast appears ----------------------------------------------------
    const toast = page.getByRole("status").filter({ hasText: "Categorized" });
    await expect(toast).toBeVisible({ timeout: 10_000 });

    // --- Popover total + Groceries row actual refresh in place ------------
    // The actuals popover stays mounted (the picker's onClick stopPropagation
    // keeps the parent open), so the header + row list update without us
    // re-opening it. Groceries now has 1 contributor totaling -$40.00.
    await expect(
      groceriesList.locator('[data-testid^="actuals-row-"]'),
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(popoverContent).toContainText(/1\s*txn\s*·\s*\$40\.00/, {
      timeout: 10_000,
    });
    // The row's actual button outside the popover also refreshed.
    await expect(groceriesActualsBtn).toHaveText("$40.00", {
      timeout: 10_000,
    });
    // The Dining row absorbed the moved $20.00 of spend.
    await expect(page.getByTestId(`button-actuals-${dining.id}`)).toHaveText(
      "$20.00",
      { timeout: 10_000 },
    );

    // --- Undo restores the original category ------------------------------
    const undoBtn = page.getByTestId(`action-undo-reassign-${small.id}`);
    await expect(undoBtn).toBeVisible();

    const undoPatchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/transactions/${small.id}`,
      { timeout: 10_000 },
    );
    await undoBtn.click();
    const undoReq = await undoPatchPromise;
    const undoBody = JSON.parse(undoReq.postData() ?? "{}");
    expect(undoBody.categoryId).toBe(groceries.id);

    // Groceries is whole again — both row actual and popover total snap
    // back to the pre-reassign state.
    await expect(groceriesActualsBtn).toHaveText("$60.00", {
      timeout: 10_000,
    });
    await expect(
      groceriesList.locator('[data-testid^="actuals-row-"]'),
    ).toHaveCount(2, { timeout: 10_000 });
    await expect(popoverContent).toContainText(/2\s*txns\s*·\s*\$60\.00/, {
      timeout: 10_000,
    });
    // Dining returned to its empty state.
    await expect(page.getByTestId(`button-actuals-${dining.id}`)).toHaveText(
      "$0.00",
      { timeout: 10_000 },
    );

    // Belt-and-suspenders: persisted category on the server matches
    // the original, proving Undo wasn't only a UI-state flip.
    const txns = await apiCall<Transaction[]>(
      page,
      "GET",
      "/api/transactions",
    );
    const persisted = txns.find((t) => t.id === small.id);
    expect(persisted?.categoryId).toBe(groceries.id);
    // The other Groceries txn was never touched.
    const persistedBig = txns.find((t) => t.id === big.id);
    expect(persistedBig?.categoryId).toBe(groceries.id);
  });
});
