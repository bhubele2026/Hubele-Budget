import { test, expect, type Locator, type Page } from "@playwright/test";
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
 *
 * (C9 repair) Two things the page changed under this spec:
 * - A row's selection is its "Select" checkbox (the shared account row),
 *   not a `select-<id>` test id.
 * - A POSTED checking row is always in the forecast (`inForecast`); bulk
 *   Send skips it and bulk Remove records "not a planned payment" instead of
 *   flipping its flag (CH-40). The flag write this spec is about therefore
 *   happens only for rows dated AFTER today, so the three rows are seeded on
 *   future household days, all in one month, and the page opens on that
 *   month.
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

/** A day on the HOUSEHOLD calendar (America/Chicago), `offset` days from today. */
function householdIso(offset = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + offset)).toISOString().slice(0, 10);
}

/**
 * `n` consecutive days after today, all in one calendar month (so one Month
 * view lists them): tomorrow onwards, or the 1st of next month onwards when
 * tomorrow's run would cross the month end.
 */
function futureDaysInOneMonth(n: number): string[] {
  let start = 1;
  if (householdIso(start).slice(0, 7) !== householdIso(start + n - 1).slice(0, 7)) {
    while (householdIso(start).slice(8) !== "01") start += 1;
  }
  return Array.from({ length: n }, (_, i) => householdIso(start + i));
}

/** The shared account row's own selection checkbox ("Select day" is the day head's). */
async function selectRow(row: Locator): Promise<void> {
  await row.getByRole("checkbox", { name: "Select", exact: true }).click();
}

test.describe("Transactions bulk Send-to-Forecast Undo (#215)", () => {
  test("bulk Send-to-Forecast and Remove-from-Forecast each offer Undo on the success toast, scoped to the affectedIds", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "txn-bulk-fc-undo-215",
      provisionedUserIds,
    );

    // Three days after today, in one month: unflagged future rows are the
    // ones a bulk Send flips (posted checking rows are always in the forecast).
    const days = futureDaysInOneMonth(3);
    const monthStart = `${days[0]!.slice(0, 7)}-01`;
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed a category and three categorized manual rows, dated after
    // today. Manual rows (no plaid_account_id) are treated as bank/checking by
    // canSendToForecast, so they're eligible for the bulk Send-to-Forecast flow.
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
        occurredOn: days[0]!,
        description: `BULKFC-${suffix} ROW A`,
        amount: "-12.34",
        categoryId: cat.id,
        forecastFlag: false,
      },
    );
    const b = await apiCall<{ id: string; forecastFlag: boolean }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: days[1]!,
        description: `BULKFC-${suffix} ROW B`,
        amount: "-23.45",
        categoryId: cat.id,
        forecastFlag: false,
      },
    );
    const c = await apiCall<{ id: string; forecastFlag: boolean }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: days[2]!,
        description: `BULKFC-${suffix} ROW C`,
        amount: "-34.56",
        categoryId: cat.id,
        forecastFlag: false,
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
    await selectRow(rowA);
    await selectRow(rowB);
    await selectRow(rowC);
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
    await selectRow(rowA2);
    await selectRow(rowB2);
    await selectRow(rowC2);
    await expect(page.getByTestId("bulk-bar")).toContainText("3 selected");

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
