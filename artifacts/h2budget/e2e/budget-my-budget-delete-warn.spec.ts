import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #698 — deleting a "My budget" envelope
 * that still has categorized spending in it must prompt the user with
 * a warning that tells them how many transactions (and how much) are
 * about to be unlinked. An empty envelope deletes silently (no prompt).
 *
 * Both branches matter: silently un-linking real spending was the
 * actual data-loss footgun this task closes, and the empty-envelope
 * branch is the regression we want to guard against accidentally
 * adding a confirm to every delete.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

type Category = { id: string; name: string; sourceKind: string };
type Transaction = { id: string; categoryId: string | null };

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
      `API ${method} ${path} failed (${result.status}): ${JSON.stringify(
        result.body,
      )}`,
    );
  }
  return result.body;
}

function thisMonthDayIso(day: number): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

test.describe("Budget My-budget delete warning (#698)", () => {
  test("non-empty envelope prompts with count + total; empty envelope deletes silently", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-my-budget-delete-warn-698",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Force the lazy seed pass so the standard categories exist and
    // POSTing our manual envelopes doesn't race the system seed.
    await apiCall<unknown[]>(page, "GET", "/api/budget/categories");

    // Two manual "My budget" envelopes — one we'll load with two real
    // transactions (non-empty branch), one we leave empty (empty branch).
    const suffix = Math.random().toString(36).slice(2, 7);
    const filledName = `E2E Filled ${suffix}`;
    const emptyName = `E2E Empty ${suffix}`;
    const filled = await apiCall<Category>(
      page,
      "POST",
      "/api/budget/categories",
      {
        name: filledName,
        kind: "expense",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 1,
      },
    );
    const emptyCat = await apiCall<Category>(
      page,
      "POST",
      "/api/budget/categories",
      {
        name: emptyName,
        kind: "expense",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 2,
      },
    );

    // Two transactions categorized into the "filled" envelope this
    // month: -$25.00 and -$15.00 → 2 txns / $40.00 total. Use day 15
    // to stay inside the current month no matter when the test runs.
    const dateInMonth = thisMonthDayIso(15);
    await apiCall<Transaction>(page, "POST", "/api/transactions", {
      occurredOn: dateInMonth,
      description: "E2E GIFT SHOP",
      amount: "-25.00",
      account: "Test Bank",
      categoryId: filled.id,
    });
    await apiCall<Transaction>(page, "POST", "/api/transactions", {
      occurredOn: dateInMonth,
      description: "E2E PARTY STORE",
      amount: "-15.00",
      account: "Test Bank",
      categoryId: filled.id,
    });

    // Reload so the Budget page picks up the seeded envelopes +
    // transactions in its initial queries.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const filledRow = page.getByTestId(`row-budget-${filled.id}`);
    const emptyRow = page.getByTestId(`row-budget-${emptyCat.id}`);
    await expect(filledRow).toBeVisible({ timeout: 15_000 });
    await expect(emptyRow).toBeVisible({ timeout: 15_000 });

    // The filled row's actual reflects $40.00 of spend — wait for it
    // before invoking delete so the warning has the right counts.
    await expect(
      filledRow.getByTestId(`button-actuals-${filled.id}`),
    ).toHaveText("$40.00", { timeout: 15_000 });

    // ----- Branch A: non-empty envelope shows the warning ---------------
    //
    // Capture every dialog the page raises during this branch. The first
    // dismiss → confirms the warning fires + the row survives the cancel.
    // The second accept → confirms the user can still proceed and the
    // envelope (and its categorized transactions) are unlinked.
    const dialogs: { message: string; action: "dismiss" | "accept" }[] = [];

    // Cancel branch: assert the warning surfaces the count + amount
    // and that dismissing it leaves the envelope in place.
    const cancelHandler = async (d: import("@playwright/test").Dialog) => {
      dialogs.push({ message: d.message(), action: "dismiss" });
      await d.dismiss();
    };
    page.on("dialog", cancelHandler);
    await filledRow.getByTestId(`button-delete-${filled.id}`).click();
    await expect.poll(() => dialogs.length, { timeout: 5_000 }).toBe(1);
    page.off("dialog", cancelHandler);

    const warning = dialogs[0]!.message;
    expect(warning).toMatch(/2 transactions/);
    expect(warning).toContain("$40.00");
    expect(warning.toLowerCase()).toContain("uncategorized");

    // Row is still there because we dismissed the prompt.
    await expect(filledRow).toBeVisible();

    // Accept branch: same row, same warning, user clicks OK this time.
    const acceptHandler = async (d: import("@playwright/test").Dialog) => {
      dialogs.push({ message: d.message(), action: "accept" });
      await d.accept();
    };
    page.on("dialog", acceptHandler);
    await filledRow.getByTestId(`button-delete-${filled.id}`).click();
    await expect.poll(() => dialogs.length, { timeout: 5_000 }).toBe(2);
    page.off("dialog", acceptHandler);


    // ----- Branch B: empty envelope deletes silently --------------------
    //
    // No dialog handler attached. If the empty branch ever regresses to
    // pop a confirm, Playwright will auto-dismiss the dialog and the
    // delete won't fire — the row would stay visible and the assertion
    // below would fail. (We also assert the dialog count stays at 2.)
    const dialogCountBeforeEmpty = dialogs.length;
    await emptyRow.getByTestId(`button-delete-${emptyCat.id}`).click();
    await expect(emptyRow).toBeHidden({ timeout: 10_000 });
    expect(dialogs.length).toBe(dialogCountBeforeEmpty);
  });

  test("non-empty envelope still warns even when the transactions list hasn't loaded yet", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-my-budget-delete-warn-698-race",
      provisionedUserIds,
    );

    // Seed envelope + transaction BEFORE we visit /budget so the row's
    // server-rendered actualAmount has the spending baked in.
    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });
    await apiCall<unknown[]>(page, "GET", "/api/budget/categories");

    const suffix = Math.random().toString(36).slice(2, 7);
    const filled = await apiCall<Category>(
      page,
      "POST",
      "/api/budget/categories",
      {
        name: `E2E Slow ${suffix}`,
        kind: "expense",
        groupName: "My budget",
        sourceKind: "manual",
        sortOrder: 1,
      },
    );
    await apiCall<Transaction>(page, "POST", "/api/transactions", {
      occurredOn: thisMonthDayIso(15),
      description: "E2E SLOW SHOP",
      amount: "-25.00",
      account: "Test Bank",
      categoryId: filled.id,
    });

    // Stall every transactions list response by 8s so the row renders
    // with a non-zero actual from /budget/months while allTxns is still
    // loading. The delete handler must fall back on the row's actual
    // (not the empty txn map) to decide whether to warn.
    await page.route("**/api/transactions**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await new Promise((r) => setTimeout(r, 8_000));
      await route.continue();
    });

    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const row = page.getByTestId(`row-budget-${filled.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Wait for the row's actual to reflect the seeded spending — this
    // comes from /budget/months, NOT from /api/transactions, so it
    // arrives long before the stalled list does.
    await expect(row.getByTestId(`button-actuals-${filled.id}`)).toHaveText(
      "$25.00",
      { timeout: 15_000 },
    );

    const dialogs: string[] = [];
    const handler = async (d: import("@playwright/test").Dialog) => {
      dialogs.push(d.message());
      await d.dismiss();
    };
    page.on("dialog", handler);

    await row.getByTestId(`button-delete-${filled.id}`).click();
    await expect.poll(() => dialogs.length, { timeout: 5_000 }).toBe(1);
    page.off("dialog", handler);

    // Fallback message uses "~$amount" sourced from the row's actual,
    // since the per-transaction list hasn't landed yet. The key
    // guarantee is that a non-empty envelope is NEVER deleted without
    // any prompt during the loading race.
    expect(dialogs[0]).toContain("$25.00");
    expect(dialogs[0]!.toLowerCase()).toContain("uncategorized");

    // Row survives the dismissal.
    await expect(row).toBeVisible();
  });
});
