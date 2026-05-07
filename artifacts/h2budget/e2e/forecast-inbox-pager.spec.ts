import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #481:
 *
 * Task #478 changed the Active Register's "Inbox from Chase" card to show
 * a single pending row at a time with a Prev / "X of N" / Next pager
 * (testids: `bank-inbox-pager`, `bank-inbox-pager-prev`,
 * `bank-inbox-pager-next`, `bank-inbox-pager-indicator`). This spec locks
 * in the pager wiring:
 *   - With multiple pending rows, only one `InboxCardView` is visible at
 *     a time and the indicator reads "1 of N".
 *   - Prev/Next step the visible row and the indicator updates; the
 *     buttons disable at the ends.
 *   - Resolving the visible row (match, mark unplanned, or remove from
 *     forecast) auto-advances to the next pending row in the same slot.
 *   - When the inbox empties, `bank-inbox-pager` is no longer rendered
 *     and the existing empty state shows.
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

function currentMonthDay(day: number): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

async function visibleInboxTxnId(page: Page): Promise<string> {
  // The single visible inbox row is identified by its `select-bank-<txnId>`
  // checkbox testid (rendered next to the visible InboxCardView). The pager
  // mounts only one row at a time, so this should match exactly one node.
  const handles = await page
    .locator('[data-testid^="select-bank-"]')
    .elementHandles();
  expect(handles.length, "expected exactly one visible inbox row").toBe(1);
  const tid = await handles[0].getAttribute("data-testid");
  return (tid ?? "").replace(/^select-bank-/, "");
}

test.describe("Forecast inbox one-at-a-time pager (#481)", () => {
  test("pager shows one row at a time, steps with Prev/Next, auto-advances on resolve, and disappears when empty", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-inbox-pager-481",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    // Seed one planned bill so the first visible inbox row has a clean
    // one-click Match target. The remaining inbox rows have no matching
    // plan, so we resolve them via Mark unplanned and Remove respectively.
    const suffix = Math.random().toString(36).slice(2, 8);
    const billName = `PagerBill-${suffix}`;
    const billDay = 12;
    const billIso = currentMonthDay(billDay);

    await apiCall<{ id: string }>(page, "POST", "/api/recurring-items", {
      name: billName,
      kind: "bill",
      amount: "75.00",
      frequency: "monthly",
      dayOfMonth: billDay,
      active: "true",
    });

    // Three pending bank inbox rows for the current month. Only the first
    // one (same amount + same day as the bill) gets a one-click match; the
    // other two are noise we'll resolve manually.
    const txnA = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: billIso,
        description: `PAGER-${suffix} A`,
        amount: "-75.00",
        forecastFlag: true,
      },
    );
    const txnB = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: currentMonthDay(14),
        description: `PAGER-${suffix} B`,
        amount: "-13.50",
        forecastFlag: true,
      },
    );
    const txnC = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: currentMonthDay(16),
        description: `PAGER-${suffix} C`,
        amount: "-22.40",
        forecastFlag: true,
      },
    );

    await page.goto("/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    const pager = page.getByTestId("bank-inbox-pager");
    const prev = page.getByTestId("bank-inbox-pager-prev");
    const next = page.getByTestId("bank-inbox-pager-next");
    const indicator = page.getByTestId("bank-inbox-pager-indicator");

    // --- Initial state: pager mounted, exactly one row visible, "1 of 3".
    await expect(pager).toBeVisible({ timeout: 15_000 });
    await expect(indicator).toHaveText("1 of 3");
    await expect(page.locator('[data-testid^="select-bank-"]')).toHaveCount(1);
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();

    const firstId = await visibleInboxTxnId(page);
    const seenInOrder: string[] = [firstId];

    // --- Next twice: indicator advances to "2 of 3" then "3 of 3", and the
    // visible row changes each step.
    await next.click();
    await expect(indicator).toHaveText("2 of 3");
    await expect(page.locator('[data-testid^="select-bank-"]')).toHaveCount(1);
    const secondId = await visibleInboxTxnId(page);
    expect(secondId).not.toBe(firstId);
    seenInOrder.push(secondId);
    await expect(prev).toBeEnabled();
    await expect(next).toBeEnabled();

    await next.click();
    await expect(indicator).toHaveText("3 of 3");
    await expect(page.locator('[data-testid^="select-bank-"]')).toHaveCount(1);
    const thirdId = await visibleInboxTxnId(page);
    expect(new Set(seenInOrder).has(thirdId)).toBe(false);
    seenInOrder.push(thirdId);

    // At the end: Next disabled, Prev enabled. All three txns covered.
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();
    expect(new Set(seenInOrder)).toEqual(new Set([txnA.id, txnB.id, txnC.id]));

    // --- Prev steps back symmetrically.
    await prev.click();
    await expect(indicator).toHaveText("2 of 3");
    expect(await visibleInboxTxnId(page)).toBe(secondId);
    await prev.click();
    await expect(indicator).toHaveText("1 of 3");
    expect(await visibleInboxTxnId(page)).toBe(firstId);
    await expect(prev).toBeDisabled();

    // --- Auto-advance after one-click Match. The first txn shown happens
    // to be the one with the matching plan; if not, page through until we
    // find it (the picker assigns the one-click button to the lone txn
    // matching the lone plan).
    let oneClickBtn = page.getByTestId(`one-click-match-${firstId}`);
    let activeId = firstId;
    let activeIndex = 1;
    while ((await oneClickBtn.count()) === 0) {
      await next.click();
      activeIndex += 1;
      await expect(indicator).toHaveText(`${activeIndex} of 3`);
      activeId = await visibleInboxTxnId(page);
      oneClickBtn = page.getByTestId(`one-click-match-${activeId}`);
      if (activeIndex >= 3) break;
    }
    await expect(oneClickBtn).toBeVisible();

    const remainingAfterMatch = new Set([txnA.id, txnB.id, txnC.id]);
    remainingAfterMatch.delete(activeId);

    await oneClickBtn.click();
    // The matched row leaves the inbox and the visible slot now holds one
    // of the remaining pending rows — without scrolling/extra interaction.
    await expect(indicator).toContainText(" of 2", { timeout: 10_000 });
    await expect(page.locator('[data-testid^="select-bank-"]')).toHaveCount(1);
    const afterMatchId = await visibleInboxTxnId(page);
    expect(remainingAfterMatch.has(afterMatchId)).toBe(true);
    // The matched txn's row is gone from the (single-row) inbox slot.
    await expect(page.getByTestId(`select-bank-${activeId}`)).toHaveCount(0);

    // --- Auto-advance after Mark unplanned. Click the visible row's
    // Unplanned button (scoped to the one rendered InboxCardView).
    const unplannedBtn = page
      .getByTestId("card-from-bank")
      .getByRole("button", { name: /^unplanned$/i });
    await expect(unplannedBtn).toBeVisible();
    await unplannedBtn.click();
    await expect(indicator).toHaveText("1 of 1", { timeout: 10_000 });
    await expect(page.locator('[data-testid^="select-bank-"]')).toHaveCount(1);
    const lastVisibleId = await visibleInboxTxnId(page);
    expect(lastVisibleId).not.toBe(afterMatchId);
    await expect(prev).toBeDisabled();
    await expect(next).toBeDisabled();

    // --- Auto-advance after Remove (un-send back to Bank list). The "X"
    // remove icon button sits next to the InboxCardView with the title
    // "Un-send back to Bank list".
    const removeBtn = page
      .getByTestId("card-from-bank")
      .getByRole("button", { name: /un-send back to bank list/i });
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // --- Empty state: pager unmounted, empty-state copy visible.
    await expect(page.getByTestId("bank-inbox-pager")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid^="select-bank-"]')).toHaveCount(0);
    await expect(page.getByTestId("card-from-bank")).toContainText(
      /Send a bank transaction|Reconciled to bank/i,
    );
  });
});
