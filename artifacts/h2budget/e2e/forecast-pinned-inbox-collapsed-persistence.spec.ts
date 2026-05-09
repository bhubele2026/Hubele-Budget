import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #530:
 *
 * Task #519 added a collapse/expand toggle on the pinned inbox card on the
 * Forecast → Active Register tab (testid `pinned-inbox-collapse-toggle`),
 * with the choice persisted to localStorage under
 * `h2budget:pinnedInboxCollapsed`. When collapsed, the pinned card
 * shrinks to a compact one-line strip (`pinned-inbox-collapsed-row`) that
 * still surfaces the description, amount, and a one-click Match button
 * (`pinned-inbox-collapsed-match`). When expanded, the full
 * `InboxCardView` (with its `select-bank-<txnId>` checkbox) and
 * `SuggestionStrip` (`bank-suggestions-<txnId>`) come back. This spec
 * locks in:
 *
 *   (a) toggling collapsed swaps the full card for the compact strip
 *       (description, amount, Match), updates the pinned area's
 *       `data-collapsed` attribute, and writes "1" to the documented
 *       localStorage key;
 *   (b) reloading the page restores the collapsed state from
 *       localStorage;
 *   (c) toggling expanded restores the full `InboxCardView` and the
 *       `SuggestionStrip`, hides the compact strip, and writes "0" back
 *       to localStorage.
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

test.describe("Forecast pinned inbox collapsed-state persistence (#530)", () => {
  test("toggle collapses to a compact strip with description/amount/Match, persists across reload, and expanding restores InboxCardView + SuggestionStrip", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-pinned-collapsed-530",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });

    // Seed a single planned bill that matches the bank txn we're about
    // to create — same amount and same day-of-month — so the pinned
    // inbox card has a confident one-click suggestion (which both
    // enables the compact strip's "Match" button and renders the
    // SuggestionStrip we'll assert on after expanding).
    const suffix = Math.random().toString(36).slice(2, 8);
    const billName = `PinnedCollapseBill-${suffix}`;
    const billDay = 11;
    const billIso = currentMonthDay(billDay);

    await apiCall<{ id: string }>(page, "POST", "/api/recurring-items", {
      name: billName,
      kind: "bill",
      amount: "42.00",
      frequency: "monthly",
      dayOfMonth: billDay,
      active: "true",
    });

    const txnDescription = `PINNED-COLLAPSE-${suffix}`;
    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: billIso,
        description: txnDescription,
        amount: "-42.00",
        forecastFlag: true,
      },
    );

    await page.goto("/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });

    const pinnedArea = page.getByTestId("pinned-inbox-area");
    const toggle = page.getByTestId("pinned-inbox-collapse-toggle");
    const collapsedRow = page.getByTestId("pinned-inbox-collapsed-row");
    const collapsedMatch = page.getByTestId("pinned-inbox-collapsed-match");
    const fullCheckbox = page.getByTestId(`select-bank-${txn.id}`);
    const suggestionStrip = page.getByTestId(`bank-suggestions-${txn.id}`);

    // --- Initial state: pinned inbox is expanded.
    await expect(pinnedArea).toBeVisible({ timeout: 15_000 });
    await expect(pinnedArea).toHaveAttribute("data-collapsed", "false");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(fullCheckbox).toBeVisible();
    await expect(suggestionStrip).toBeVisible();
    await expect(collapsedRow).toHaveCount(0);

    // --- (a) Collapse: the compact strip replaces the full card and
    // surfaces the description, amount, and an enabled Match button.
    await toggle.click();
    await expect(pinnedArea).toHaveAttribute("data-collapsed", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(collapsedRow).toBeVisible();
    await expect(collapsedRow).toContainText(txnDescription);
    await expect(collapsedRow).toContainText("$42.00");
    await expect(collapsedMatch).toBeVisible();
    await expect(collapsedMatch).toBeEnabled();
    await expect(fullCheckbox).toHaveCount(0);
    await expect(suggestionStrip).toHaveCount(0);

    // The collapse choice was written to localStorage under the
    // documented key — assert by name so a future rename can't silently
    // break the persistence contract.
    const persistedAfterCollapse = await page.evaluate(() =>
      window.localStorage.getItem("h2budget:pinnedInboxCollapsed"),
    );
    expect(persistedAfterCollapse).toBe("1");

    // --- (b) Reload: collapsed state is restored from localStorage.
    await page.reload();
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });
    await expect(pinnedArea).toHaveAttribute("data-collapsed", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(collapsedRow).toBeVisible();
    await expect(collapsedRow).toContainText(txnDescription);
    await expect(collapsedRow).toContainText("$42.00");
    await expect(collapsedMatch).toBeVisible();
    await expect(collapsedMatch).toBeEnabled();
    await expect(fullCheckbox).toHaveCount(0);
    await expect(suggestionStrip).toHaveCount(0);

    // --- (c) Expand: the full InboxCardView (its checkbox) and
    // SuggestionStrip come back; the compact strip is gone; localStorage
    // flips back to "0".
    await toggle.click();
    await expect(pinnedArea).toHaveAttribute("data-collapsed", "false");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(fullCheckbox).toBeVisible();
    await expect(suggestionStrip).toBeVisible();
    await expect(collapsedRow).toHaveCount(0);

    const persistedAfterExpand = await page.evaluate(() =>
      window.localStorage.getItem("h2budget:pinnedInboxCollapsed"),
    );
    expect(persistedAfterExpand).toBe("0");
  });
});
