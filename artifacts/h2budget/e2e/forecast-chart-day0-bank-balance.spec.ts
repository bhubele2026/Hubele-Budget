import { test, expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  forecastResolutionsTable,
  recurringItemsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  provisionTestHousehold,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #667 — locking in the day-0 contract from
 * task #666's cashSignal fix.
 *
 * The fix in `artifacts/api-server/src/lib/cashSignal.ts` says: when a
 * bank snapshot is set, every planned event whose effective date is on
 * or before the snapshot is dropped from the projection — bills AND
 * income, real AND synthetic. The chart's first visible point must
 * therefore equal the bank snapshot whenever there's nothing actionable
 * dated after it on day 0 (no Plaid checking txns post-snapshot, no
 * future bills due today).
 *
 * API-level tests already cover the math; this spec locks in the
 * user-visible contract on /forecast so a future axis/rounding/render
 * regression on the page is caught even when the server is right:
 *   - The Projected Balance chart's first visible point (cash signal
 *     `daily[0].balance`) equals the Bank Balance card to the cent.
 *   - The Lowest Point KPI card equals the Bank Balance card.
 *   - There are no "Pending plans dragging this day" entries on day 0.
 *
 * Seeding strategy: a pre-snapshot monthly income (anchored last month,
 * larger amount, falling on a day BEFORE the bill each cycle) and a
 * pre-snapshot monthly bill (also anchored last month). All past
 * occurrences are dropped by the #666 fix; future occurrences project
 * naturally but never land on day 0 (we pick day-of-month values that
 * are guaranteed to differ from today) and the income leads the bill
 * each cycle so the running balance never dips below the snapshot.
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

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

test.describe("Forecast chart day-0 starts at bank balance (#667)", () => {
  test("with pre-snapshot recurring income & expenses, the chart's first point and Lowest Point both equal the Bank Balance card", async ({
    page,
  }) => {
    const { userId, email, password } = await createTestUser(
      "forecast-day0-bank-balance",
      provisionedUserIds,
    );

    const householdId = await provisionTestHousehold(userId);

    // Sign in & land on /forecast. The page's bootstrap fans out to
    // several /api routes (notably /api/budget/categories) and the
    // shared `SEED_RECURRING_ITEMS` lazy seed fires there, populating
    // the household with demo bills/income that would otherwise pull
    // the projection below the snapshot and break the day-0
    // == lowest-point assertion.
    await signInAndOpen(page, email, password, "/forecast");
    // Wait for the page's first paint so the seed has had a chance to
    // commit. The bank-snapshot card renders only after /api/forecast
    // resolves, which fires concurrently with the seed.
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    // Deactivate (don't delete) every seeded recurring item: the seed's
    // idempotency check is "skip if a row with this name already
    // exists", so leaving the rows in place — but inactive — guarantees
    // the seed will NOT re-insert them after our reload below. Inactive
    // recurring items are dropped by `expandItem` and so do not
    // contribute to the projection. Debts are deleted outright (the
    // budget seed does not insert debt rows).
    await db
      .delete(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.householdId, householdId));
    await db
      .update(recurringItemsTable)
      .set({ active: "false" })
      .where(eq(recurringItemsTable.householdId, householdId));
    await db
      .delete(debtsTable)
      .where(eq(debtsTable.householdId, householdId));

    const today = new Date();
    const todayISO = isoDate(today);

    // Pick a safeBase in [0, 24] derived from today's day so that
    // `incomeDay = safeBase + 2` and `billDay = safeBase + 3` are both
    // in [2, 27] (always valid month days, robust across month
    // boundaries) AND both strictly differ from today's day. Income
    // always falls one day before the bill in every cycle, so the
    // running balance only ever moves up-then-slightly-down within a
    // month — never dipping below the day-0 snapshot.
    const safeBase = today.getDate() % 25;
    const incomeDay = safeBase + 2;
    const billDay = safeBase + 3;

    // Anchor 35 days back so the recurring expansion definitely
    // produces prior-month occurrences inside the cash signal's
    // first-day-of-prior-month lookback. Every one of those past
    // occurrences must be dropped by the #666 fix.
    const preAnchor = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - 35,
    );
    const preAnchorISO = isoDate(preAnchor);

    await apiCall(page, "POST", "/api/recurring-items", {
      name: `PreSnapBill-${Math.random().toString(36).slice(2, 7)}`,
      kind: "bill",
      amount: "240.00",
      frequency: "monthly",
      dayOfMonth: billDay,
      anchorDate: preAnchorISO,
      active: "true",
    });
    await apiCall(page, "POST", "/api/recurring-items", {
      name: `PreSnapIncome-${Math.random().toString(36).slice(2, 7)}`,
      kind: "income",
      amount: "5000.00",
      frequency: "monthly",
      dayOfMonth: incomeDay,
      anchorDate: preAnchorISO,
      active: "true",
    });

    const SNAPSHOT_BALANCE = "5000.00";
    const SNAPSHOT_DISPLAY = "$5,000.00";
    await apiCall(page, "POST", "/api/forecast/bank-snapshot", {
      balance: SNAPSHOT_BALANCE,
    });

    // Refresh so the page picks up the seeded snapshot + recurring items.
    await page.reload();

    // --- Bank Balance card renders the seeded snapshot. ---
    const bankBalance = page.getByTestId("text-bank-balance");
    await expect(bankBalance).toHaveText(SNAPSHOT_DISPLAY, { timeout: 15_000 });

    // --- The Projected Balance chart actually renders (no empty state). ---
    const chartCard = page.getByTestId("card-projected-balance-chart");
    await expect(chartCard).toBeVisible();
    await expect(page.getByTestId("empty-projected-balance")).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(chartCard.locator("svg.recharts-surface")).toBeVisible({
      timeout: 15_000,
    });

    // --- Lowest Point KPI card equals the Bank Balance card. ---
    const lowestCard = page.getByTestId("kpi-lowest-point");
    await expect(lowestCard).toContainText(SNAPSHOT_DISPLAY);

    // --- Hover the chart's first (leftmost) data point and read the
    //     tooltip the user actually sees. This is the load-bearing
    //     assertion for task #667: the projected balance chart's first
    //     visible point reads as the bank snapshot to the cent, and the
    //     tooltip carries no "Pending plans dragging this day" section
    //     on day 0. Recharts triggers its tooltip via native mousemove
    //     over the SVG surface, so we drive Playwright's mouse straight
    //     onto the leftmost plotted x. ---
    const surface = chartCard.locator("svg.recharts-surface");
    const surfaceBox = await surface.boundingBox();
    expect(surfaceBox).not.toBeNull();
    if (!surfaceBox) throw new Error("chart surface has no bounding box");
    // YAxis width is configured at 60 in forecast.tsx; the plot area
    // begins immediately after it. Nudging a couple px past that lands
    // squarely on the first data point's x coordinate.
    const firstPointX = surfaceBox.x + 60 + 2;
    const midY = surfaceBox.y + surfaceBox.height / 2;
    // Move the mouse off the chart first so the subsequent move
    // generates a fresh mouseenter Recharts will pick up.
    await page.mouse.move(0, 0);
    await page.mouse.move(firstPointX, midY, { steps: 5 });

    const tooltip = page.locator(".recharts-tooltip-wrapper").first();
    // The tooltip header line is the formatted day-0 date — exactly
    // matching `Intl.DateTimeFormat("en-US", { month: "short", day:
    // "numeric", year: "numeric" })` from src/lib/utils.ts:formatDate.
    const todayLabel = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(today);
    await expect(tooltip).toContainText(todayLabel, { timeout: 10_000 });
    // The user-visible balance row on day 0 must read as the bank
    // snapshot — to the cent — exactly as displayed in the Bank
    // Balance card above.
    await expect(tooltip).toContainText(`Balance: ${SNAPSHOT_DISPLAY}`);
    // No "Pending plans dragging this day" section may render on
    // day 0; the #666 fix dropped every pre-snapshot event, so that
    // tooltip group must be entirely absent.
    await expect(tooltip).not.toContainText("Pending plans dragging this day");

    // --- Belt & suspenders on the underlying contract: read the same
    //     /api/forecast/cash-signal payload the chart consumes and
    //     assert daily[0] and lowestProjected match the snapshot to the
    //     cent. The UI tooltip above formats currency (which can hide
    //     sub-cent drift); the raw fields cannot. ---
    const cashSignal = await apiCall<{
      fromDate: string;
      daily: Array<{ date: string; balance: string }>;
      events: Array<{ date: string; originalDate?: string }>;
      lowestProjected: string;
    }>(page, "GET", "/api/forecast/cash-signal?horizonDays=90");

    expect(cashSignal.daily.length).toBeGreaterThan(0);
    expect(cashSignal.daily[0].date).toBe(todayISO);
    expect(cashSignal.daily[0].balance).toBe(SNAPSHOT_BALANCE);
    expect(cashSignal.lowestProjected).toBe(SNAPSHOT_BALANCE);
  });
});
