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
 * Task #684 — UI coverage for task #682.
 *
 * The "Pending plans dragging this day" tooltip on the today+1 dip
 * exposes a per-plan "Mark missed" affordance so the user can clear
 * the drag from the chart itself. Tapping it writes a `missed`
 * forecast_resolution and the dip disappears on next refresh.
 *
 * Seed: one recurring expense dated yesterday (past-due, unresolved).
 * It is the only plan dragging onto today+1, so day-1 == snapshot
 * minus its amount before the click, and day-1 == snapshot after.
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

test.describe("Forecast tooltip Mark missed (#682)", () => {
  test("tapping 'Mark missed' on the today+1 dragging-plan row writes a missed resolution and removes the drag", async ({
    page,
  }) => {
    const { userId, email, password } = await createTestUser(
      "forecast-tooltip-mark-missed",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);

    await signInAndOpen(page, email, password, "/forecast");
    await expect(page.getByTestId("card-bank-snapshot")).toBeVisible({
      timeout: 15_000,
    });

    // Wipe any seeded plans so we control exactly what drags.
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

    // Seed one past-due unresolved expense ANCHORED ON TODAY. The
    // (#666) rule drops events strictly before the snapshot (which
    // the API stamps as `now`); anchoring on today survives that
    // filter, and the (#681) drag (dragCutoff = today) still rolls
    // it onto today+1 as the sole entry in the tooltip's "Pending
    // plans dragging this day" section.
    const seedName = `DragMe-${Math.random().toString(36).slice(2, 7)}`;
    await apiCall(page, "POST", "/api/recurring-items", {
      name: seedName,
      kind: "bill",
      amount: "75.00",
      frequency: "onetime",
      anchorDate: todayISO,
      active: "true",
    });

    await apiCall(page, "POST", "/api/forecast/bank-snapshot", {
      balance: "2000.00",
    });

    await page.reload();
    await expect(page.getByTestId("text-bank-balance")).toHaveText(
      "$2,000.00",
      { timeout: 15_000 },
    );

    const chartCard = page.getByTestId("card-projected-balance-chart");
    await expect(chartCard).toBeVisible();
    const surface = chartCard.locator("svg.recharts-surface");
    await expect(surface).toBeVisible({ timeout: 15_000 });
    // Hover events only fire at the actual viewport position the mouse
    // lands on. The chart sits below the bank-balance card, so without
    // scrolling it can be entirely below the fold and mouse.move() will
    // dispatch over an unrelated DOM element — never activating
    // Recharts. Scroll it fully into view before computing hover x.
    await surface.scrollIntoViewIfNeeded();

    // Read the cash-signal payload directly to discover the planned
    // item id (the API generated it server-side) and confirm exactly
    // one expense is dragging onto today+1 before we click.
    type CashSig = {
      daily: Array<{ date: string; balance: string }>;
      events: Array<{
        date: string;
        originalDate?: string;
        itemId?: string;
        label: string;
        amount: string;
      }>;
    };
    // Mirror the chart's default 90-day horizon (forecast.tsx line ~954)
    // so the index of `targetDate` in `daily` matches the chart's
    // band-scale spacing we use below to position the mouse hover.
    const before = await apiCall<CashSig>(
      page,
      "GET",
      "/api/forecast/cash-signal?horizonDays=90",
    );
    const draggingBefore = before.events.filter(
      (e) =>
        e.originalDate &&
        e.originalDate !== e.date &&
        Number(e.amount) < 0 &&
        e.label === seedName,
    );
    expect(draggingBefore).toHaveLength(1);
    const dragRow = draggingBefore[0];
    const itemId = dragRow.itemId!;
    const origDate = dragRow.originalDate!;
    const targetDate = dragRow.date;

    // Hover the chart's today+1 point so the tooltip renders with our
    // dragging row. The plot starts immediately after the y-axis
    // (width=60 in forecast.tsx); today+1 is the second column.
    const surfaceBox = await surface.boundingBox();
    expect(surfaceBox).not.toBeNull();
    if (!surfaceBox) throw new Error("chart surface has no bounding box");
    // Wait for Recharts' entry animation to settle. While the area is
    // still animating, hover doesn't reliably activate a data point's
    // tooltip — Recharts hasn't bound final coordinates yet.
    await page.waitForTimeout(1500);

    // YAxis width is 60 in forecast.tsx; right margin is 16. Compute a
    // per-day step from the actual plot width and walk over to today+1.
    const targetIdx = before.daily.findIndex((d) => d.date === targetDate);
    expect(targetIdx, "targetDate not in daily series").toBeGreaterThan(0);
    const horizonDays = Math.max(1, before.daily.length - 1);
    const day0X = surfaceBox.x + 60 + 2;
    const step = (surfaceBox.width - 60 - 16 - 2) / horizonDays;
    const midY = surfaceBox.y + surfaceBox.height / 2;
    const tooltip = page.locator(".recharts-tooltip-wrapper").first();

    // Sweep: start at the computed targetIdx position and walk +/- a few
    // sub-steps until the tooltip surfaces the dragging-plans section.
    // This is resilient to small Recharts band-scale rounding without
    // needing to query the SVG's internal coords.
    const baseX = day0X + step * targetIdx;
    const offsets = [0, -2, 2, -4, 4, -6, 6, -8, 8, -step / 4, step / 4];
    let lastText = "";
    let matched = false;
    for (const off of offsets) {
      await page.mouse.move(0, 0);
      await page.mouse.move(baseX + off, midY, { steps: 4 });
      await page.waitForTimeout(120);
      lastText = await tooltip.innerText().catch(() => "");
      // CSS textTransform: uppercase turns the section header into
      // "PENDING PLANS DRAGGING THIS DAY" in rendered innerText —
      // match case-insensitively.
      if (/pending plans dragging this day/i.test(lastText)) {
        matched = true;
        break;
      }
    }
    expect(
      matched,
      `Tooltip never showed dragging section. baseX=${baseX} surfaceBox.width=${surfaceBox.width} horizonDays=${horizonDays} targetIdx=${targetIdx} lastText=${JSON.stringify(lastText.slice(0, 200))}`,
    ).toBe(true);
    // CSS uppercases the section header; assert with a case-insensitive
    // regex so the test isn't coupled to the textTransform style.
    await expect(tooltip).toContainText(/pending plans dragging this day/i);
    await expect(tooltip).toContainText(seedName);

    // Tap the Mark missed button inside the tooltip.
    const markBtn = page.getByTestId(
      `tooltip-mark-missed-${itemId}-${origDate}`,
    );
    await expect(markBtn).toBeVisible();
    // Recharts hides its tooltip wrapper the instant the mouse leaves
    // a "live" data-point x. Playwright's default click moves the
    // pointer toward the button center, which can cross a dead zone
    // first and dismiss the tooltip mid-action. Skip actionability and
    // dispatch the click straight at the button.
    await markBtn.click({ force: true, timeout: 10_000 });

    // Toast confirms the mutation fired.
    await expect(page.getByTestId("toast-undo-mark-missed")).toBeVisible({
      timeout: 10_000,
    });

    // A missed resolution row now exists for this plan occurrence.
    const resolutions = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.householdId, householdId));
    const missed = resolutions.filter(
      (r) =>
        r.recurringItemId === itemId &&
        r.occurrenceDate === origDate &&
        r.status === "missed",
    );
    expect(missed).toHaveLength(1);

    // And the dragging row is gone from the cash-signal payload —
    // day-1 now equals day-0 (the snapshot) because nothing else
    // drags or is naturally due then.
    const after = await apiCall<CashSig>(
      page,
      "GET",
      "/api/forecast/cash-signal?horizonDays=30",
    );
    const draggingAfter = after.events.filter(
      (e) =>
        e.originalDate &&
        e.originalDate !== e.date &&
        Number(e.amount) < 0 &&
        e.label === seedName,
    );
    expect(draggingAfter).toHaveLength(0);
    const dayOneAfter = after.daily.find((d) => d.date === targetDate);
    expect(dayOneAfter?.balance).toBe("2000.00");
  });
});
