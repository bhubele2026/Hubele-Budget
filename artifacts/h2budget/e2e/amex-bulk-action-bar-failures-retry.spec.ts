import { test, expect, type Page, type Route } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #637 — the Amex bulk action bar's
 * partial-failure UX (#508). #531 and #592 only pin the happy paths
 * for the various bulk verbs; this spec pins what happens when the
 * server reports `ok: false` for some of the selected ids:
 *
 *   - the destructive toast surfaces the "X updated, Y failed" wording
 *     (so a regression that drops the failure count or swallows the
 *     destructive variant is caught), and
 *   - the red `panel-bulk-failures` panel renders one row per failed
 *     id with the original transaction's description (proving
 *     `reportBulkOutcome`'s description lookup against the React Query
 *     cache still resolves even when the row was deleted server-side
 *     mid-flight), and
 *   - clicking Retry re-fires POST /transactions/bulk-update with
 *     ONLY the failed ids (not the whole original selection — the
 *     dedup-keyed retry shape is the whole point of `reportBulkOutcome`'s
 *     `retry` callback), and
 *   - on a successful retry the panel is cleared.
 *
 * Failure mode chosen: seed three Amex rows, select all three, then
 * delete one of them via the API before clicking the bulk verb. The
 * page's React Query cache still has the deleted row visible (and
 * still selected), so the bulk-update server returns `ok:true` for
 * the two surviving ids and `ok:false, error:"not found"` for the
 * deleted one — the exact partial-failure shape `reportBulkOutcome`
 * is built to handle. This is more faithful than mocking the server
 * response because it exercises the real route's per-id `results[]`.
 *
 * For the retry-success step we DO mock the second bulk-update call
 * (the one carrying only the failed id), since the failed row no
 * longer exists server-side and re-creating it would change the id.
 * The mock is gated on the request body so the first call still
 * hits the real server.
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

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

test.describe("Amex bulk action bar — partial failure panel + Retry (#637)", () => {
  test("a partially-failing bulk verb surfaces the failures panel with the failed descriptions, and Retry re-fires bulk-update with only the failed ids and clears the panel on success", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-bulk-bar-failures-retry-637",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Three same-day Amex rows, all unreviewed so the bulk Mark
    // reviewed verb actually flips state we can observe on the
    // surviving rows.
    const suffix = Math.random().toString(36).slice(2, 8);
    const today = todayIso();
    const seedSpecs = [
      { description: `AMEX FAIL ${suffix} — KEEP A`, amount: "11.00" },
      { description: `AMEX FAIL ${suffix} — KEEP B`, amount: "22.00" },
      { description: `AMEX FAIL ${suffix} — DOOMED`, amount: "33.00" },
    ];
    const seeded: { id: string; description: string }[] = [];
    for (const s of seedSpecs) {
      const row = await apiCall<{ id: string }>(
        page,
        "POST",
        "/api/transactions",
        {
          occurredOn: today,
          description: s.description,
          amount: s.amount,
          source: "amex",
          categoryId: null,
          reviewed: false,
        },
      );
      seeded.push({ id: row.id, description: s.description });
    }
    const [keepA, keepB, doomed] = seeded;

    await page.goto("/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    const rowA = page.getByTestId(`row-amex-${keepA.id}`);
    const rowB = page.getByTestId(`row-amex-${keepB.id}`);
    const rowDoomed = page.getByTestId(`row-amex-${doomed.id}`);
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await expect(rowB).toBeVisible();
    await expect(rowDoomed).toBeVisible();

    // Baseline: every seeded row starts unreviewed so the post-action
    // "the survivors flipped to reviewed=true" assertion is meaningful.
    await expect(rowA).toHaveAttribute("data-reviewed", "false");
    await expect(rowB).toHaveAttribute("data-reviewed", "false");
    await expect(rowDoomed).toHaveAttribute("data-reviewed", "false");

    // Select all three rows. The page's React Query cache still
    // believes the doomed row exists, so it stays selected even
    // after we delete it server-side below.
    await rowA.getByRole("checkbox", { name: /select/i }).check();
    await rowB.getByRole("checkbox", { name: /select/i }).check();
    await rowDoomed.getByRole("checkbox", { name: /select/i }).check();
    await expect(page.getByText("3 selected").first()).toBeVisible();

    // Delete the doomed row out from under the page. The transactions
    // list query is not auto-invalidated on this DELETE, so the row
    // and its selection check survive in the UI cache until the bulk
    // verb's own `invalidateTxns()` runs after the bulk-update call.
    await apiCall<unknown>(
      page,
      "DELETE",
      `/api/transactions/${doomed.id}`,
    );

    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });

    // -----------------------------------------------------------------
    // Trigger bulk Mark reviewed. The server's per-id results[] will
    // report ok=true for the two survivors and ok=false / "not found"
    // for the doomed id (see /transactions/bulk-update — rows not
    // matched by householdId+inArray get the not-found result).
    // -----------------------------------------------------------------
    const firstBulkReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/transactions/bulk-update",
      { timeout: 10_000 },
    );
    const firstBulkResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/transactions/bulk-update",
      { timeout: 10_000 },
    );

    await page.getByTestId("button-bulk-mark-reviewed").click();

    const firstBulkReq = await firstBulkReqPromise;
    const firstBulkRes = await firstBulkResPromise;
    expect(firstBulkRes.status()).toBe(200);
    const firstBulkSent = JSON.parse(firstBulkReq.postData() ?? "{}") as {
      ids: string[];
      patch: { reviewed: boolean };
    };
    // The first call carries the full original selection — that's
    // what `reportBulkOutcome`'s retry callback later narrows down.
    expect(new Set(firstBulkSent.ids)).toEqual(
      new Set([keepA.id, keepB.id, doomed.id]),
    );
    expect(firstBulkSent.patch.reviewed).toBe(true);

    // Destructive toast surfaces the partial outcome with the exact
    // "{ok} updated, {fail} failed" wording bulkSetReviewed builds.
    await expect(
      notifications.getByText(/2 updated, 1 failed/i),
    ).toBeVisible({ timeout: 10_000 });

    // The two survivors visibly flipped to reviewed=true; the doomed
    // row stays at reviewed=false until React Query refetches it
    // away after `invalidateTxns()`.
    await expect(rowA).toHaveAttribute("data-reviewed", "true", {
      timeout: 10_000,
    });
    await expect(rowB).toHaveAttribute("data-reviewed", "true", {
      timeout: 10_000,
    });

    // -----------------------------------------------------------------
    // Failures panel pins exactly the doomed id with its description.
    // Description lookup goes through the React Query snapshot the
    // page held when the bulk verb fired, so even though the row is
    // gone server-side the panel still names it usefully (the whole
    // point of #508 — a single error toast can only carry one
    // message; the panel shows every failure with context).
    // -----------------------------------------------------------------
    const panel = page.getByTestId("panel-bulk-failures");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText(/2 updated, 1 failed/i);
    const failureRows = panel.getByTestId(/^row-bulk-failure-/);
    await expect(failureRows).toHaveCount(1);
    const doomedFailure = panel.getByTestId(`row-bulk-failure-${doomed.id}`);
    await expect(doomedFailure).toBeVisible();
    await expect(doomedFailure).toContainText(doomed.description);

    // Retry button label encodes the failed count; #508 pins this so
    // a regression that double-counted retries (or counted the whole
    // original selection) would surface here.
    const retryButton = page.getByTestId("button-bulk-retry-failed");
    await expect(retryButton).toBeVisible();
    await expect(retryButton).toHaveText(/Retry 1 failed/i);

    // -----------------------------------------------------------------
    // Click Retry. Intercept ONLY the second bulk-update call (the
    // one carrying just the failed id) and fulfill it with success
    // — the doomed row no longer exists server-side and re-creating
    // it would mint a new id, so we mock the success response. The
    // route handler is gated on the request body so a stray refetch
    // cannot accidentally satisfy it.
    // -----------------------------------------------------------------
    let retryRequestSeen: { ids: string[]; patch: unknown } | null = null;
    await page.route(
      "**/api/transactions/bulk-update",
      async (route: Route) => {
        const sent = JSON.parse(route.request().postData() ?? "{}") as {
          ids: string[];
          patch: unknown;
        };
        if (
          Array.isArray(sent.ids) &&
          sent.ids.length === 1 &&
          sent.ids[0] === doomed.id
        ) {
          retryRequestSeen = sent;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              updated: 1,
              results: [
                { id: doomed.id, ok: true, error: null },
              ],
              affectedMonths: [],
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await retryButton.click();

    // Wait until the mock observed the retry call AND the panel
    // disappears (`reportBulkOutcome` clears `bulkFailures` on a
    // 0-failure result). Two separate assertions because we want
    // both signals to be pinned.
    await expect
      .poll(() => retryRequestSeen, { timeout: 10_000 })
      .not.toBeNull();
    await expect(panel).toHaveCount(0, { timeout: 10_000 });

    // Pin the dedup-keyed retry shape: ONLY the failed id, with the
    // same `{ reviewed: true }` patch the original call carried.
    expect(retryRequestSeen).not.toBeNull();
    const retrySent = retryRequestSeen as unknown as {
      ids: string[];
      patch: { reviewed: boolean };
    };
    expect(retrySent.ids).toEqual([doomed.id]);
    expect(retrySent.patch.reviewed).toBe(true);

    // Success toast wording for the retry — the same path that
    // showed "2 updated, 1 failed" above now reports the 1 retried
    // row as a clean success, proving the panel-clear path runs
    // through `reportBulkOutcome`'s `failed.length === 0` branch.
    await expect(
      notifications.getByText(/Marked 1 as reviewed/i),
    ).toBeVisible({ timeout: 10_000 });

    await page.unroute("**/api/transactions/bulk-update");
  });
});
