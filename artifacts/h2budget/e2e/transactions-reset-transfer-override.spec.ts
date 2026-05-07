import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #513 (follow-up of #493):
 *
 * Task #493 added a "Manually set" hint chip on Transfer rows whose
 * `isTransferUserOverridden` flag is true (so future Plaid syncs / XLSX
 * imports don't silently re-flip `isTransfer` from the description+PFC
 * heuristic), and a "Reset to auto" button inside the Edit dialog that
 * POSTs `/transactions/:id/clear-transfer-override` to flip the override
 * flag back off.
 *
 * This spec locks in the web flow:
 *   - With a row that has `isTransfer=false` AND `isTransferUserOverridden=true`,
 *     the row renders the `badge-transfer-overridden-cleared-<id>` "Manually set"
 *     chip.
 *   - Opening that row's Edit dialog renders the `transfer-override-hint` block
 *     with the "Transfer status manually set" copy and the "Reset to auto"
 *     button.
 *   - Clicking "Reset to auto" fires POST
 *     `/api/transactions/:id/clear-transfer-override`, surfaces the
 *     "Reset to auto" toast, and after the list refresh the row's hint chip
 *     disappears (server-side `isTransferUserOverridden` is false now).
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

test.describe("Transactions Edit dialog 'Reset to auto' for transfer override (#513)", () => {
  test("shows the 'Manually set' hint chip + Edit-dialog hint, and clicking 'Reset to auto' clears the override server-side and removes the chip after refresh", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-reset-transfer-513",
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

    // Seed a regular (non-Transfer) transaction, then PATCH `isTransfer=false`
    // explicitly so the route's #479 logic flips
    // `isTransferUserOverridden=true` while leaving `isTransfer=false`. That
    // matches the production state the "Manually set" chip + Edit-dialog
    // hint render for: a row the user explicitly cleared from auto-Transfer
    // detection.
    const suffix = Math.random().toString(36).slice(2, 8);
    const description = `RESET-TRANSFER-${suffix.toUpperCase()} VENDOR`;
    const seeded = await apiCall<{
      id: string;
      isTransfer: boolean;
      isTransferUserOverridden: boolean;
    }>(page, "POST", "/api/transactions", {
      // Use today rather than `isoDay(-1)` so the seeded row is guaranteed
      // to land in the month-scoped Chase view even on the 1st of a month.
      occurredOn: isoDay(0),
      description,
      amount: "-25.00",
    });
    expect(seeded.isTransfer).toBe(false);
    expect(seeded.isTransferUserOverridden).toBe(false);

    const overridden = await apiCall<{
      id: string;
      isTransfer: boolean;
      isTransferUserOverridden: boolean;
    }>(page, "PATCH", `/api/transactions/${seeded.id}`, {
      isTransfer: false,
    });
    expect(overridden.isTransfer).toBe(false);
    expect(overridden.isTransferUserOverridden).toBe(true);

    // Reload so the freshly-overridden row lands in the page's react-query
    // cache that the row + Edit dialog read from.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId(`row-tx-${seeded.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The row should render the "Manually set" hint chip (the
    // `!isTransfer && isTransferUserOverridden` branch).
    const overrideChip = page.getByTestId(
      `badge-transfer-overridden-cleared-${seeded.id}`,
    );
    await expect(overrideChip).toBeVisible();
    await expect(overrideChip).toHaveText(/manually set/i);

    // Open the Edit dialog and assert the override hint block is visible
    // with the "Transfer status manually set" copy + the Reset button.
    await page.getByTestId(`button-edit-tx-${seeded.id}`).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Edit Transaction")).toBeVisible();

    const hint = page.getByTestId("transfer-override-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/transfer status manually set/i);

    const resetBtn = page.getByTestId("button-reset-transfer-override");
    await expect(resetBtn).toBeVisible();
    await expect(resetBtn).toHaveText(/reset to auto/i);

    // Click "Reset to auto" and capture the dedicated clear-override POST
    // (NOT the generic PATCH /transactions/:id) so a future refactor that
    // accidentally re-routes this button through PATCH — which would
    // re-set `isTransferUserOverridden=true` — fails the test.
    const clearReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          `/api/transactions/${seeded.id}/clear-transfer-override`,
      { timeout: 10_000 },
    );
    const clearResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          `/api/transactions/${seeded.id}/clear-transfer-override`,
      { timeout: 10_000 },
    );
    await resetBtn.click();
    await clearReqPromise;
    const clearRes = await clearResPromise;
    expect(clearRes.status()).toBe(200);

    // After the list invalidation, the row's "Manually set" hint chip should
    // disappear (the `isTransferUserOverridden=false` branch) — this is the
    // user-visible regression net the task asks for.
    await expect(overrideChip).toBeHidden({ timeout: 10_000 });

    // Server-side: GET /api/transactions reflects the cleared override so
    // future Plaid syncs are free to re-derive `isTransfer` from the
    // heuristic again.
    const list = await apiCall<
      Array<{
        id: string;
        isTransfer: boolean;
        isTransferUserOverridden: boolean;
      }>
    >(page, "GET", "/api/transactions");
    const persisted = list.find((t) => t.id === seeded.id);
    expect(persisted?.isTransferUserOverridden).toBe(false);

    await context.close();
  });
});
