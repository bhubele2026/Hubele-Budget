import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #527:
 *
 * The amber "Inbox clear, but the forecast and the bank disagree…" badge on
 * /forecast is now a real button. Clicking it dispatches by the largest
 * contributor's kind:
 *   - kind="starting" → opens the Settings dialog with the starting-balance
 *     input focused, so the fix is one keystroke away.
 *   - kind="matched"  → scrolls/highlights the bucket row driving the
 *     mismatch (matched plan occurrences live in the bucket panel, not the
 *     visible plan register).
 *
 * We seed two fresh users — one for each scenario — and drive the click
 * through the real /api/forecast pipeline (recurring-items, transactions,
 * forecast/resolutions, forecast/bank-snapshot).
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

function todayISO(): { iso: string; day: number } {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = d.getDate();
  return {
    iso: `${year}-${month}-${String(day).padStart(2, "0")}`,
    day,
  };
}

test.describe("Forecast off-from-bank badge jump (#527)", () => {
  test("starting-balance contributor → click opens Settings with starting-balance input focused", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-mismatch-starting",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");

    // No plans, no txns. A bank snapshot whose balance disagrees with the
    // default starting balance (0) leaves the residual entirely on the
    // starting-balance contributor.
    await apiCall(page, "POST", "/api/forecast/bank-snapshot", {
      balance: "4321.99",
    });

    await page.reload();

    const badge = page.getByTestId("badge-balance-mismatch");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute("data-contributor-kind", "starting");

    await badge.click();

    const input = page.getByTestId("input-starting-balance");
    await expect(input).toBeVisible({ timeout: 5_000 });
    // autoFocus on the rendered Input must land focus on the field so the
    // user can immediately type a corrected starting balance.
    await expect(input).toBeFocused();
  });

  test("matched-pair contributor → click scrolls/highlights the offending bucket row", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-mismatch-matched",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");

    // Plan a bill anchored to TODAY, then a bank txn for today with a
    // DIFFERENT amount, mark them matched, and set the bank snapshot so
    // the entire gap collapses onto the matched-pair contributor.
    //
    // Math:
    //   startingBalance = 0
    //   plan amount     = -120  (bill outflow)
    //   bank amount     = -150  (recorded txn)
    //   forecastAtSnapshot = 0 + (-120) = -120
    //   bankAtSnapshot     = -150
    //   rawGap             = forecastAtSnapshot - bankAtSnapshot = 30
    //   matchedDelta       = plan - bank = -120 - (-150) = 30
    //   startingDelta      = rawGap - matchedDelta = 0
    // So contributors = [matched(30)] and the badge's largestContributor
    // is the matched pair.
    const { iso } = todayISO();
    const suffix = Math.random().toString(36).slice(2, 8);
    const billName = `MismatchBill-${suffix}`;

    // Use a one-time event anchored to today so the matched-pair is the
    // ONLY plan event in [fromISO, snapshot]. A monthly bill would also
    // emit a prior-month occurrence (still in the cash window) that
    // would land as `pending_plan` and inflate the gap, pushing the
    // residual onto the starting-balance contributor instead.
    const bill = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/recurring-items",
      {
        name: billName,
        kind: "bill",
        amount: "120.00",
        frequency: "onetime",
        anchorDate: iso,
        active: "true",
      },
    );

    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: iso,
        description: `BANKTXN-${suffix}`,
        amount: "-150.00",
        forecastFlag: true,
      },
    );

    await apiCall(page, "POST", "/api/forecast/resolutions", {
      recurringItemId: bill.id,
      occurrenceDate: iso,
      status: "matched",
      matchedTxnId: txn.id,
    });

    await apiCall(page, "POST", "/api/forecast/bank-snapshot", {
      balance: "-150.00",
    });

    await page.reload();

    const badge = page.getByTestId("badge-balance-mismatch");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute("data-contributor-kind", "matched");

    // The bucket row for the matched plan occurrence carries the
    // `<itemId>|<date>` data-plan-key the badge's jumpToPlan targets.
    const planKey = `${bill.id}|${iso}`;
    const bucketRow = page.locator(`[data-plan-key="${planKey}"]`);
    await expect(bucketRow).toBeVisible({ timeout: 10_000 });

    await badge.click();

    // The highlight ring (sky-50 + ring-sky-400) is added to the matched
    // bucket row for ~2s. We assert it appears after the click — a
    // regression that loses the planKey wiring or the highlight class
    // would surface here as a missing sky ring.
    await expect(bucketRow).toHaveClass(/ring-sky-400/, { timeout: 5_000 });
  });
});
