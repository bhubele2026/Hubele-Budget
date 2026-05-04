import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #215:
 *
 * Bulk Send-to-Forecast / Remove-from-Forecast on the Chase Transactions
 * page now both surface an Undo affordance on their success toast (the same
 * affordance task #199 added to bulk re-categorize). Clicking Undo flips
 * exactly the rows the original bulk touched, skipping any the user has
 * since toggled back by hand, and surfaces a "Restored N transactions"
 * confirmation toast.
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

test.describe("Transactions bulk Send-to-Forecast Undo (#215)", () => {
  test("bulk Send-to-Forecast and Remove-from-Forecast each offer Undo on the success toast, scoped to the affectedIds", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-bulk-fc-undo-215",
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

    // --- Seed a category and three categorized manual rows. Manual rows
    // (no plaid_account_id) are treated as bank/checking by canSendToForecast,
    // so they're eligible for the bulk Send-to-Forecast flow.
    const suffix = Math.random().toString(36).slice(2, 8);
    const cat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: `Groceries-${suffix}`, kind: "expense", groupName: "Other" },
    );

    const a = await apiCall<{ id: string; forecastFlag: boolean }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-3),
        description: `BULKFC-${suffix} ROW A`,
        amount: "-12.34",
        categoryId: cat.id,
      },
    );
    const b = await apiCall<{ id: string; forecastFlag: boolean }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-2),
        description: `BULKFC-${suffix} ROW B`,
        amount: "-23.45",
        categoryId: cat.id,
      },
    );
    const c = await apiCall<{ id: string; forecastFlag: boolean }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-1),
        description: `BULKFC-${suffix} ROW C`,
        amount: "-34.56",
        categoryId: cat.id,
      },
    );

    // Reload so the seeded rows show up in the list.
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const rowA = page.getByTestId(`row-tx-${a.id}`);
    const rowB = page.getByTestId(`row-tx-${b.id}`);
    const rowC = page.getByTestId(`row-tx-${c.id}`);
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await expect(rowB).toBeVisible();
    await expect(rowC).toBeVisible();

    // Select all three rows via the per-row checkbox.
    await rowA.getByTestId(`select-${a.id}`).click();
    await rowB.getByTestId(`select-${b.id}`).click();
    await rowC.getByTestId(`select-${c.id}`).click();
    await expect(page.getByTestId("bulk-bar")).toContainText("3 selected");

    // --- Bulk Send-to-Forecast. Watch the request so we can confirm the
    // client targets the new bulk endpoint with the expected body.
    const sendReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/bulk-set-forecast-flag",
      { timeout: 10_000 },
    );
    const sendResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/bulk-set-forecast-flag",
      { timeout: 10_000 },
    );
    await page.getByTestId("bulk-send-forecast").click();
    const sendReq = await sendReqPromise;
    const sendRes = await sendResPromise;
    expect(sendRes.status()).toBe(200);
    const sentBody = JSON.parse(sendReq.postData() ?? "{}");
    expect(sentBody.forecastFlag).toBe(true);
    expect(new Set(sentBody.ids)).toEqual(new Set([a.id, b.id, c.id]));

    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(/Sent 3 to Forecast/i),
    ).toBeVisible({ timeout: 5_000 });

    // Confirm the rows actually got flipped server-side.
    let txns = await apiCall<
      Array<{ id: string; forecastFlag: boolean }>
    >(page, "GET", "/api/transactions?limit=500");
    const flagBy = (rows: typeof txns) =>
      new Map(rows.map((t) => [t.id, t.forecastFlag] as const));
    let byId = flagBy(txns);
    expect(byId.get(a.id)).toBe(true);
    expect(byId.get(b.id)).toBe(true);
    expect(byId.get(c.id)).toBe(true);

    // --- Undo bulk Send-to-Forecast. The Undo POST should re-issue the same
    // endpoint with `forecastFlag: false` and the affectedIds whitelist.
    const undoSendAction = page.getByTestId("action-undo-bulk-send-forecast");
    await expect(undoSendAction).toBeVisible({ timeout: 5_000 });

    const undoReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/bulk-set-forecast-flag",
      { timeout: 10_000 },
    );
    const undoResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/bulk-set-forecast-flag",
      { timeout: 10_000 },
    );
    await undoSendAction.click();
    const undoReq = await undoReqPromise;
    const undoRes = await undoResPromise;
    expect(undoRes.status()).toBe(200);
    const undoBody = JSON.parse(undoReq.postData() ?? "{}");
    expect(undoBody.forecastFlag).toBe(false);
    expect(new Set(undoBody.ids)).toEqual(new Set([a.id, b.id, c.id]));

    await expect(
      notifications.getByText(/Restored 3 transactions/i),
    ).toBeVisible({ timeout: 5_000 });

    txns = await apiCall<Array<{ id: string; forecastFlag: boolean }>>(
      page,
      "GET",
      "/api/transactions?limit=500",
    );
    byId = flagBy(txns);
    expect(byId.get(a.id)).toBe(false);
    expect(byId.get(b.id)).toBe(false);
    expect(byId.get(c.id)).toBe(false);

    // --- Now exercise the bulk Remove-from-Forecast Undo path. First put
    // all three rows back into Forecast directly via the API (so the test
    // doesn't depend on the Send Undo confirmation toast still being
    // mounted), then select them again and click Remove-from-Forecast.
    for (const id of [a.id, b.id, c.id]) {
      await apiCall(page, "PATCH", `/api/transactions/${id}`, {
        forecastFlag: true,
      });
    }
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const rowA2 = page.getByTestId(`row-tx-${a.id}`);
    const rowB2 = page.getByTestId(`row-tx-${b.id}`);
    const rowC2 = page.getByTestId(`row-tx-${c.id}`);
    await expect(rowA2).toBeVisible({ timeout: 15_000 });
    await rowA2.getByTestId(`select-${a.id}`).click();
    await rowB2.getByTestId(`select-${b.id}`).click();
    await rowC2.getByTestId(`select-${c.id}`).click();

    const removeReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/bulk-set-forecast-flag",
      { timeout: 10_000 },
    );
    const removeResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/bulk-set-forecast-flag",
      { timeout: 10_000 },
    );
    await page.getByTestId("bulk-remove-forecast").click();
    const removeReq = await removeReqPromise;
    const removeRes = await removeResPromise;
    expect(removeRes.status()).toBe(200);
    const removeBody = JSON.parse(removeReq.postData() ?? "{}");
    expect(removeBody.forecastFlag).toBe(false);
    expect(new Set(removeBody.ids)).toEqual(new Set([a.id, b.id, c.id]));

    await expect(
      notifications.getByText(/Removed 3 from Forecast/i),
    ).toBeVisible({ timeout: 5_000 });

    // --- Simulate the user toggling row B back into Forecast manually
    // *before* clicking Undo. The Undo POST is still scoped to all three
    // affectedIds, but the server-side `forecast_flag != target` guard
    // should leave row B alone — only A and C flip back to true. The
    // confirmation toast should reflect the smaller "Restored 2" count.
    await apiCall(page, "PATCH", `/api/transactions/${b.id}`, {
      forecastFlag: true,
    });

    const undoRemoveAction = page.getByTestId(
      "action-undo-bulk-remove-forecast",
    );
    await expect(undoRemoveAction).toBeVisible({ timeout: 5_000 });

    const undoRemoveReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/bulk-set-forecast-flag",
      { timeout: 10_000 },
    );
    const undoRemoveResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/bulk-set-forecast-flag",
      { timeout: 10_000 },
    );
    await undoRemoveAction.click();
    const undoRemoveReq = await undoRemoveReqPromise;
    const undoRemoveRes = await undoRemoveResPromise;
    expect(undoRemoveRes.status()).toBe(200);
    const undoRemoveBody = JSON.parse(undoRemoveReq.postData() ?? "{}");
    expect(undoRemoveBody.forecastFlag).toBe(true);
    expect(new Set(undoRemoveBody.ids)).toEqual(new Set([a.id, b.id, c.id]));

    await expect(
      notifications.getByText(/Restored 2 transactions/i),
    ).toBeVisible({ timeout: 5_000 });

    txns = await apiCall<Array<{ id: string; forecastFlag: boolean }>>(
      page,
      "GET",
      "/api/transactions?limit=500",
    );
    byId = flagBy(txns);
    // A and C went false→true via Undo; B was already true (user re-edited
    // it before clicking Undo) so the server skipped it.
    expect(byId.get(a.id)).toBe(true);
    expect(byId.get(b.id)).toBe(true);
    expect(byId.get(c.id)).toBe(true);
  });
});
