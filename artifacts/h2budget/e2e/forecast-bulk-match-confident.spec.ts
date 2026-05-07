import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #323 (the sister flow #276 intentionally
 * skipped):
 *
 * Task #27 added a selection-scoped bulk bar in the Forecast inbox with two
 * actions — `bulk-mark-unplanned-selected` (covered by
 * `forecast-bulk-mark-unplanned.spec.ts`) and `bulk-match-confident-selected`.
 * The confident-match button is only rendered when at least one of the
 * selected bank cards has a high-confidence plan suggestion (the
 * `matchableCount > 0` gate), and on click it fans out one
 * `POST /api/forecast/resolutions` per matchable card with `status="matched"`
 * + the chosen plan's `(recurringItemId, occurrenceDate)`.
 *
 * This spec mirrors the bulk-mark-unplanned pattern but seeds two onetime
 * recurring items (so we get two distinct plan keys — `pickConfidentBankMatches`
 * refuses to assign one plan occurrence to two bank rows) plus three manual
 * bank rows for the current month:
 *   - rows A & B exactly match a plan on the same date and amount, so they
 *     land in `confidentMatches` as `high` confidence picks,
 *   - row C has no matching plan (different amount, no plan nearby) so it's
 *     not in `confidentMatches` and must be left untouched.
 *
 * We then select all three, click `bulk-match-confident-selected`, and assert:
 *   - the success toast (`Matched 2 confident bank rows`),
 *   - the two matched rows leave the inbox while C stays,
 *   - the per-row resolution POSTs hit the correct ids with `status="matched"`
 *     and the right `recurringItemId`/`occurrenceDate` (not `ignored_unforecasted`),
 *   - server-side: A & B have `matched` resolutions; C has none.
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

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Pick three deterministic, strictly-future dates that all live in the same
 * calendar month. They must be future because the server's
 * `archiveExpiredOneTime` cron deactivates onetime recurring items whose
 * anchorDate has already passed — past plans would simply not produce a
 * confident match. They must share a month because the bank inbox is
 * scoped to `monthFilter` (default = current month). If `today + 2` would
 * push us past the current month's end (or the trio would straddle a
 * month boundary), shift the whole trio into the next month and signal
 * the caller to switch the monthFilter dropdown so the inbox is reachable.
 */
function pickPlanDates(): {
  dayA: string;
  dayB: string;
  dayC: string;
  monthKey: string;
  needSwitchMonth: boolean;
} {
  const today = new Date();
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let a = new Date(t);
  a.setDate(t.getDate() + 2);
  let b = new Date(t);
  b.setDate(t.getDate() + 5);
  let cd = new Date(t);
  cd.setDate(t.getDate() + 9);
  let needSwitchMonth = false;
  if (
    a.getMonth() !== t.getMonth() ||
    b.getMonth() !== t.getMonth() ||
    cd.getMonth() !== t.getMonth()
  ) {
    const next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
    a = new Date(next.getFullYear(), next.getMonth(), 5);
    b = new Date(next.getFullYear(), next.getMonth(), 10);
    cd = new Date(next.getFullYear(), next.getMonth(), 18);
    needSwitchMonth = true;
  }
  const monthKey = `${a.getFullYear()}-${pad(a.getMonth() + 1)}`;
  return {
    dayA: fmtDate(a),
    dayB: fmtDate(b),
    dayC: fmtDate(cd),
    monthKey,
    needSwitchMonth,
  };
}

test.describe("Forecast inbox bulk match-confident (#323)", () => {
  test("selecting cards and clicking bulk-match-confident-selected matches only the high-confidence selected rows", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-bulk-match-323",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/forecast");

    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    const dates = pickPlanDates();

    // --- Seed two onetime "expense" recurring items in future, in the
    // same calendar month. expandItem signs expense plans negative
    // (sign = -1), so a manual bank row of the same negative amount on
    // the same date scores as a high-confidence match (amountDelta == 0
    // + daysAway == 0). We use two items with distinct (itemId, date)
    // plan keys because `pickConfidentBankMatches` refuses to assign one
    // plan occurrence to two bank rows — with a single plan, only one
    // bank row would land in `confidentMatches`. Future-dated anchors
    // also dodge the server's `archiveExpiredOneTime` cron, which
    // deactivates onetime items whose anchorDate is already in the past.
    const suffix = Math.random().toString(36).slice(2, 8);
    const planA = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/recurring-items",
      {
        name: `Match-A-${suffix}`,
        kind: "expense",
        amount: "42.00",
        frequency: "onetime",
        anchorDate: dates.dayA,
        active: "true",
      },
    );
    const planB = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/recurring-items",
      {
        name: `Match-B-${suffix}`,
        kind: "expense",
        amount: "77.00",
        frequency: "onetime",
        anchorDate: dates.dayB,
        active: "true",
      },
    );

    // --- Three manual bank rows for the same month with forecastFlag.
    // A and B are exact matches against planA/planB; C has no matching
    // plan (different amount, no plan within 14 days), so its
    // `confidentMatches` entry is empty — it must be left untouched.
    const a = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
      occurredOn: dates.dayA,
      description: `INBOX-${suffix} ROW A`,
      amount: "-42.00",
      forecastFlag: true,
    });
    const b = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
      occurredOn: dates.dayB,
      description: `INBOX-${suffix} ROW B`,
      amount: "-77.00",
      forecastFlag: true,
    });
    const c = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
      occurredOn: dates.dayC,
      description: `INBOX-${suffix} ROW C (no match)`,
      amount: "-999.99",
      forecastFlag: true,
    });

    // Reload so the freshly-seeded plan + bank rows show up.
    await page.goto("/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    // If the trio fell into next month (today is too late in this month
    // for `today + 9` to stay in-month), switch monthFilter via the
    // bucket-tab month dropdown so the bank inbox is reachable. The
    // setting persists across tab switches.
    if (dates.needSwitchMonth) {
      await page.getByRole("tab", { name: /Review Bucket/i }).click();
      const monthCombobox = page.getByRole("combobox").first();
      await expect(monthCombobox).toBeVisible({ timeout: 5_000 });
      await monthCombobox.click();
      await page
        .getByRole("option", { name: dates.monthKey, exact: true })
        .click();
      await page.getByRole("tab", { name: /Active Register/i }).click();
    }

    // (#478) The Active Register inbox now shows one pending row at a
    // time with a Prev/Next pager — only the first row's checkbox is in
    // the DOM until we page over to the others.
    await expect(page.getByTestId("bank-inbox-pager-indicator")).toContainText(
      "1 of 3",
      { timeout: 15_000 },
    );

    // The header-level "Match all confident (2)" button confirms our seed
    // produced exactly two confident matches before we even open the
    // selection bar — guards against silent regressions in the scorer.
    const headerConfident = page.getByTestId("bulk-match-confident");
    await expect(headerConfident).toBeVisible();
    await expect(headerConfident).toHaveText(/Match all confident \(2\)/);

    // Select all three rows. The selection-scoped button must report the
    // matchable subset (2), not the selection size (3) — that's the
    // `matchableCount` gate in the bar's render. With one-at-a-time
    // (#478) we page between rows to reach each checkbox; pager order is
    // reverse-chronological so we make this loop order-agnostic.
    const pagerNext = page.getByTestId("bank-inbox-pager-next");
    const toSelect = new Set([a.id, b.id, c.id]);
    for (let step = 0; step < 4 && toSelect.size > 0; step++) {
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
    await expect(selectionBar).toContainText("3 selected");

    const bulkBtn = page.getByTestId("bulk-match-confident-selected");
    await expect(bulkBtn).toBeVisible();
    await expect(bulkBtn).toHaveText(/Match 2 confident/);

    // Capture the per-row POST /api/forecast/resolutions calls so we can
    // confirm the client targets the resolutions endpoint with the
    // expected matched-status payload, scoped to A and B (not C).
    type ResolutionPost = {
      status: string;
      matchedTxnId: string;
      recurringItemId: string | null;
      occurrenceDate: string | null;
    };
    const seenResolutionPosts: ResolutionPost[] = [];
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
            recurringItemId: body.recurringItemId ?? null,
            occurrenceDate: body.occurrenceDate ?? null,
          });
        } catch {
          /* ignore */
        }
      }
    });

    await bulkBtn.click();

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(
      notifications.getByText(/Matched 2 confident bank rows/i),
    ).toBeVisible({ timeout: 10_000 });

    // The two matched rows must leave the inbox; the unselected-from-
    // confident row C must stay. The selection bar tears itself down once
    // the selection clears post-resolve.
    await expect(page.getByTestId(`select-bank-${a.id}`)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByTestId(`select-bank-${b.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`select-bank-${c.id}`)).toBeVisible();
    await expect(page.getByTestId("bank-inbox-selection-bar")).toHaveCount(0);

    // Confirm the underlying upsertResolution calls were scoped to
    // exactly A & B with `status="matched"` (NOT `ignored_unforecasted`,
    // which is the sister bulk action), and that each carried the right
    // plan key. C must not appear in any matched POST.
    const matchedFor = seenResolutionPosts.filter((p) => p.status === "matched");
    const matchedById = new Map(matchedFor.map((p) => [p.matchedTxnId, p]));
    expect(matchedById.has(a.id)).toBe(true);
    expect(matchedById.has(b.id)).toBe(true);
    expect(matchedById.has(c.id)).toBe(false);
    expect(matchedById.get(a.id)?.recurringItemId).toBe(planA.id);
    expect(matchedById.get(a.id)?.occurrenceDate).toBe(dates.dayA);
    expect(matchedById.get(b.id)?.recurringItemId).toBe(planB.id);
    expect(matchedById.get(b.id)?.occurrenceDate).toBe(dates.dayB);
    // No `ignored_unforecasted` POSTs should have leaked from the wrong
    // bulk handler.
    expect(
      seenResolutionPosts.some((p) => p.status === "ignored_unforecasted"),
    ).toBe(false);

    // Server-side: A & B now have `matched` resolutions tied to the right
    // plan keys; C has no resolution at all.
    const fc = await apiCall<{
      resolutions: Array<{
        matchedTxnId: string | null;
        status: string;
        recurringItemId: string | null;
        occurrenceDate: string | null;
      }>;
    }>(page, "GET", "/api/forecast");
    const matchedResolutions = (fc.resolutions ?? []).filter(
      (r) => r.status === "matched" && r.matchedTxnId,
    );
    const byTxn = new Map(
      matchedResolutions.map((r) => [r.matchedTxnId as string, r]),
    );
    expect(byTxn.has(a.id)).toBe(true);
    expect(byTxn.has(b.id)).toBe(true);
    expect(byTxn.has(c.id)).toBe(false);
    expect(byTxn.get(a.id)?.recurringItemId).toBe(planA.id);
    expect(byTxn.get(a.id)?.occurrenceDate).toBe(dates.dayA);
    expect(byTxn.get(b.id)?.recurringItemId).toBe(planB.id);
    expect(byTxn.get(b.id)?.occurrenceDate).toBe(dates.dayB);
    // C must not be in any resolution (matched or otherwise).
    expect(
      (fc.resolutions ?? []).some((r) => r.matchedTxnId === c.id),
    ).toBe(false);
  });
});
