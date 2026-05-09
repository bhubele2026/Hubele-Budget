import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #426 (locks in the per-row "In Review
 * Bucket" badge + the header pending-count chip introduced by #422 on
 * the Chase Transactions page).
 *
 * The Chase page derives the badge state for each forecastFlagged row
 * from `forecastData.resolutions` keyed by `matchedTxnId`:
 *   - no resolution                                  → in-review-bucket
 *   - status="matched"                               → matched
 *   - status="ignored_unforecasted" | "unplanned"    → unplanned
 * The header chip (`link-bucket-pending-count`) shows the count of
 * forecastFlag rows in the current month with no resolution; when zero
 * it collapses to the `text-bucket-empty` "All sent items reconciled."
 * note. Both surfaces stay live because the Forecast page invalidates
 * `getGetForecastQueryKey()` on every match / unplanned action.
 *
 * Two cases are exercised here:
 *   1. Click Send-to-Forecast on a Chase row → assert the row gets the
 *      `in-review-bucket` badge and the chip shows "1". Then go to
 *      `/review`, one-click match the inbox card to a planned bill,
 *      return to Chase, and assert the badge flipped to `matched` and
 *      the chip collapsed to the "All sent items reconciled." empty
 *      state.
 *   2. Seed a second forecastFlag row, mark it Unplanned via the
 *      `/review` Inbox bulk-mark-unplanned button, return to Chase,
 *      and assert the badge flipped to `unplanned`.
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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function thisMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

/**
 * Pick a current-month day a few days from today (capped at 28 for
 * month-length safety). Same-day + exact amount as the seeded plan
 * gives the Forecast scorer a 0-day delta + 0 amount delta, so the
 * inbox card surfaces the uncontested high-confidence one-click Match
 * button (`one-click-match-<txnId>`).
 */
function pickAnchorDay(): { iso: string; day: number } {
  const d = new Date();
  const target = Math.min(Math.max(d.getDate() + 3, 5), 28);
  return {
    iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(target)}`,
    day: target,
  };
}

test.describe("Chase Transactions Review Bucket badge (#426)", () => {
  test("Send-to-Forecast flips the row badge to in-review-bucket and the chip to 1; matching it on /review flips the badge to matched and clears the chip", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "txn-bucket-badge-426",
      provisionedUserIds,
    );

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

    // --- Seed: a category, a current-month monthly recurring bill that
    // matches our row exactly (same amount and day → 0/0 deltas → high
    // confidence + uncontested one-click Match), and a categorized
    // manual bank row that's eligible for Send-to-Forecast (manual
    // rows are bank-treated by `canSendToForecast`).
    const suffix = Math.random().toString(36).slice(2, 8);
    const cat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: `Bills-${suffix}`, kind: "expense", groupName: "Other" },
    );

    const { iso: anchorIso, day: anchorDay } = pickAnchorDay();
    const planName = `BucketPlan-${suffix}`;
    await apiCall<{ id: string }>(page, "POST", "/api/recurring-items", {
      name: planName,
      kind: "bill",
      amount: "120.00",
      frequency: "monthly",
      dayOfMonth: anchorDay,
      active: "true",
    });

    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: anchorIso,
        description: `BUCKET-${suffix} ROW`,
        amount: "-120.00",
        categoryId: cat.id,
      },
    );

    // Reload so the freshly-seeded row shows up in the list.
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Initial state: nothing forecast-flagged → no per-row badge, and
    // the chip collapses to the "All sent items reconciled." note.
    await expect(page.getByTestId("text-bucket-empty")).toBeVisible();
    await expect(
      page.getByTestId(`badge-forecast-state-${txn.id}`),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("link-bucket-pending-count"),
    ).toHaveCount(0);

    const row = page.getByTestId(`row-tx-${txn.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // --- Click Send-to-Forecast on the row. The badge wiring should
    // light up *immediately* once forecastFlag flips and the resolution
    // map still has no entry for this txn → "in-review-bucket". The
    // chip surfaces the new awaiting-match count (1).
    await row.getByTestId(`button-send-forecast-${txn.id}`).click();

    const badge = page.getByTestId(`badge-forecast-state-${txn.id}`);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveAttribute(
      "data-forecast-state",
      "in-review-bucket",
    );

    const chip = page.getByTestId("link-bucket-pending-count");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("1");
    await expect(chip).toContainText(/awaiting match in Review Bucket/i);
    await expect(page.getByTestId("text-bucket-empty")).toHaveCount(0);
    // The chip must point at the deep-link the Forecast page handles
    // for the bucket tab — task #422's whole point was a one-click jump.
    await expect(chip).toHaveAttribute("href", "/forecast#bucket");

    // --- Match the inbox card to the planned bill via the /review
    // Inbox. The Forecast page invalidates the forecast query on
    // resolve, so the Chase chip + per-row badge must reflect the new
    // matched state when we come back.
    await page.goto("/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });
    const matchBtn = page.getByTestId(`one-click-match-${txn.id}`);
    await expect(matchBtn).toBeVisible({ timeout: 15_000 });
    await matchBtn.click();
    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(new RegExp(`Matched to ${planName}`)),
    ).toBeVisible({ timeout: 10_000 });

    // --- Back to Chase → badge flipped to matched, chip cleared, empty
    // state shown.
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    const badgeMatched = page.getByTestId(`badge-forecast-state-${txn.id}`);
    await expect(badgeMatched).toBeVisible({ timeout: 10_000 });
    await expect(badgeMatched).toHaveAttribute(
      "data-forecast-state",
      "matched",
    );
    await expect(badgeMatched).toContainText(/Matched/);
    await expect(
      page.getByTestId("link-bucket-pending-count"),
    ).toHaveCount(0);
    await expect(page.getByTestId("text-bucket-empty")).toBeVisible();
  });

  test("marking the inbox card Unplanned on /review flips the Chase badge to data-forecast-state=\"unplanned\"", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "txn-bucket-badge-426-up",
      provisionedUserIds,
    );

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

    // Seed a single categorized manual bank row already flagged for
    // Forecast (no plan to match against → no resolution → starts in
    // the Review Bucket state). We pre-flag via the API so the test is
    // focused on the Unplanned-→ badge flip rather than re-asserting
    // the Send button (covered by the first case).
    const suffix = Math.random().toString(36).slice(2, 8);
    const cat = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: `Misc-${suffix}`, kind: "expense", groupName: "Other" },
    );
    const { iso: anchorIso } = pickAnchorDay();
    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: anchorIso,
        description: `BUCKET-${suffix} UNPLANNED`,
        amount: "-49.00",
        categoryId: cat.id,
        forecastFlag: true,
      },
    );

    // Pre-condition on Chase: badge is in-review-bucket and the chip
    // shows the awaiting count.
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    const badge = page.getByTestId(`badge-forecast-state-${txn.id}`);
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute(
      "data-forecast-state",
      "in-review-bucket",
    );
    await expect(
      page.getByTestId("link-bucket-pending-count"),
    ).toContainText("1");

    // Mark the only inbox card unplanned. With one row in the bank
    // inbox, "Mark all unplanned" upserts a single
    // `ignored_unforecasted` resolution — which the badge selector on
    // Chase folds into `data-forecast-state="unplanned"`.
    await page.goto("/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("bulk-mark-unplanned").click();
    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(/Marked 1 as unplanned/i),
    ).toBeVisible({ timeout: 10_000 });

    // Back to Chase: badge flipped to unplanned, chip cleared.
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });
    const badgeUnplanned = page.getByTestId(
      `badge-forecast-state-${txn.id}`,
    );
    await expect(badgeUnplanned).toBeVisible({ timeout: 10_000 });
    await expect(badgeUnplanned).toHaveAttribute(
      "data-forecast-state",
      "unplanned",
    );
    await expect(badgeUnplanned).toContainText(/Unplanned/);
    await expect(
      page.getByTestId("link-bucket-pending-count"),
    ).toHaveCount(0);
    await expect(page.getByTestId("text-bucket-empty")).toBeVisible();
  });
});
