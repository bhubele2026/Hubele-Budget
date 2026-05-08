import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #276:
 *
 * Task #27 added per-row checkboxes and a selection-scoped bulk bar to the
 * Forecast inbox so users can mark several pending bank rows as unplanned
 * in one click (data-testids `select-bank-<txnId>` and
 * `bulk-mark-unplanned-selected`). The Transactions side of the same task
 * is covered by `transactions-bulk-forecast-undo.spec.ts`. This spec mirrors
 * that pattern for the Forecast inbox bulk-mark-unplanned flow:
 *   - seed three pending bank inbox cards (manual rows with
 *     `forecastFlag: true` for the current month — manual rows are treated
 *     as bank/checking by `isBankTxn`, so they show up in the inbox),
 *   - select two of the three via their per-row checkbox,
 *   - click `bulk-mark-unplanned-selected`,
 *   - assert the success toast (`Marked 2 as unplanned`) and that the two
 *     resolved rows leave the inbox while the unselected third stays.
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

test.describe("Forecast inbox bulk mark-unplanned (#276)", () => {
  test("selecting multiple bank inbox cards and clicking bulk-mark-unplanned-selected resolves only the selected rows", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-bulk-unplanned-276",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/review");

    // Wait for the page shell to render before driving any API calls — the
    // helper has cookies set by the time signInAndOpen returns, but landing
    // on /forecast first guarantees the SPA has bootstrapped Clerk.
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });

    // --- Seed three manual bank rows for the current month with
    // forecastFlag: true. Manual rows (no plaidAccountId) are treated as
    // bank/checking by `isBankTxn`, so they land in the Forecast inbox as
    // pending_bank cards.
    const suffix = Math.random().toString(36).slice(2, 8);
    const a = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
      occurredOn: currentMonthDay(1),
      description: `INBOX-${suffix} ROW A`,
      amount: "-12.34",
      forecastFlag: true,
    });
    const b = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
      occurredOn: currentMonthDay(2),
      description: `INBOX-${suffix} ROW B`,
      amount: "-23.45",
      forecastFlag: true,
    });
    const c = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
      occurredOn: currentMonthDay(3),
      description: `INBOX-${suffix} ROW C`,
      amount: "-34.56",
      forecastFlag: true,
    });

    // Reload so the freshly-seeded rows show up in the bank inbox.
    await page.goto("/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });

    // (#478) The Active Register inbox now shows one pending row at a
    // time with a Prev/Next pager, so we step through the pager to reach
    // each row's checkbox. Wait for the pager to render with all 3 rows.
    await expect(page.getByTestId("bank-inbox-pager-indicator")).toContainText(
      "1 of 3",
      { timeout: 15_000 },
    );

    // Select rows A and B by paging through the inbox; leave C alone so
    // we can confirm the bulk action is scoped to the selection (not
    // "mark all unplanned"). The pager order is reverse-chronological,
    // so we make this loop order-agnostic.
    const pagerNext = page.getByTestId("bank-inbox-pager-next");
    const toSelect = new Set([a.id, b.id]);
    for (let step = 0; step < 3 && toSelect.size > 0; step++) {
      for (const id of [...toSelect]) {
        const cb = page.getByTestId(`select-bank-${id}`);
        if (await cb.isVisible().catch(() => false)) {
          await cb.click();
          toSelect.delete(id);
        }
      }
      if (toSelect.size > 0) await pagerNext.click();
    }
    expect(toSelect.size).toBe(0);

    const selectionBar = page.getByTestId("bank-inbox-selection-bar");
    await expect(selectionBar).toBeVisible();
    await expect(selectionBar).toContainText("2 selected");

    const bulkBtn = page.getByTestId("bulk-mark-unplanned-selected");
    await expect(bulkBtn).toBeVisible();
    await expect(bulkBtn).toHaveText(/Mark 2 unplanned/);

    // The bulk action fans out one POST /api/forecast/resolutions per
    // selected txn with status="ignored_unforecasted" + matchedTxnId. Watch
    // for those calls so we can confirm the client targets the resolutions
    // endpoint with the expected body shape and only for the selected ids.
    const seenResolutionPosts: Array<{ status: string; matchedTxnId: string }> =
      [];
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/forecast/resolutions"
      ) {
        try {
          const body = JSON.parse(req.postData() ?? "{}");
          seenResolutionPosts.push({
            status: body.status,
            matchedTxnId: body.matchedTxnId,
          });
        } catch {
          /* ignore */
        }
      }
    });

    await bulkBtn.click();

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(notifications.getByText(/Marked 2 as unplanned/i)).toBeVisible(
      { timeout: 10_000 },
    );

    // The two resolved rows must leave the inbox; the unselected row C
    // must stay. The selection bar tears itself down once the selection
    // clears post-resolve.
    await expect(page.getByTestId(`select-bank-${a.id}`)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByTestId(`select-bank-${b.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`select-bank-${c.id}`)).toBeVisible();
    await expect(page.getByTestId("bank-inbox-selection-bar")).toHaveCount(0);

    // Confirm the underlying upsertResolution calls were scoped to exactly
    // the selected txn ids with the expected status payload.
    const ignoredFor = new Set(
      seenResolutionPosts
        .filter((p) => p.status === "ignored_unforecasted")
        .map((p) => p.matchedTxnId),
    );
    expect(ignoredFor.has(a.id)).toBe(true);
    expect(ignoredFor.has(b.id)).toBe(true);
    expect(ignoredFor.has(c.id)).toBe(false);

    // And confirm server-side: the two resolved rows now have a
    // forecast resolution, the third does not.
    const fc = await apiCall<{
      resolutions: Array<{ matchedTxnId: string | null; status: string }>;
    }>(page, "GET", "/api/forecast");
    const resolvedIds = new Set(
      (fc.resolutions ?? [])
        .filter((r) => r.status === "ignored_unforecasted" && r.matchedTxnId)
        .map((r) => r.matchedTxnId as string),
    );
    expect(resolvedIds.has(a.id)).toBe(true);
    expect(resolvedIds.has(b.id)).toBe(true);
    expect(resolvedIds.has(c.id)).toBe(false);
  });
});
