import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #107:
 *
 * The Forecast page exposes a per-row "Move to…" button that opens a date
 * picker dialog. Saving a future date creates a one-off "rescheduled"
 * resolution; the original occurrence is re-listed at the new date and a
 * "Rescheduled into <month>" bucket panel surfaces an Undo affordance that
 * deletes the override and restores the row at its original date.
 *
 * The dialog rejects a day outside today…today+30 and the day the row is
 * already on with a visible inline error (data-testid="move-error") instead
 * of POSTing to the API.
 *
 * (C13 repair) The spec had drifted from the page before the cut-over:
 * - #888 changed the move rules: any day from today through today+30 (an
 *   EARLIER day than the original included); only the row's current day and
 *   days outside that window are refused ("Pick a day within the next 30
 *   days." / "That's already its current day."). The server bounds it to
 *   today-1 … today+60 and no longer requires a later date.
 * - The dialog is "Move occurrence to another day"; the buckets read
 *   "Moved · <month>" and "Missed · <month>"; clicking a plan row marks it
 *   missed at once with an Undo toast (#480), no confirm().
 * - The screen (C13) is the shared forecast layout: its h1 is "Forecast",
 *   and the month is picked with `select-month-filter` in the "Month & bank"
 *   view, which is what `/forecast` shows.
 *
 * This spec drives the full UI flow (open dialog → reject yesterday & today
 * → accept a future date → assert re-listing → undo) end-to-end against a
 * fresh Clerk-provisioned user, seeding a one-time recurring item via the
 * REST API so we own a deterministic plan row to move.
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
 * Pick deterministic anchor + new dates that always land in the same calendar
 * month. The rescheduled-bucket-panel only renders rows whose rescheduledTo
 * monthKey matches the page's `monthFilter`, so anchoring both dates to a
 * single month lets us assert the panel without juggling closed-month state.
 *
 * If today is too late in the month for a same-month newD, we push both
 * dates into next month and signal the caller to switch the month filter.
 */
function pickMoveDates(): {
  anchorISO: string;
  newDISO: string;
  todayISO: string;
  yesterdayISO: string;
  monthKey: string;
  needSwitchMonth: boolean;
  currentMonthKey: string;
} {
  const today = new Date();
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const currentMonthKey = `${t.getFullYear()}-${pad(t.getMonth() + 1)}`;
  let anchor = new Date(t);
  anchor.setDate(t.getDate() + 2);
  let newD = new Date(t);
  newD.setDate(t.getDate() + 9);
  let needSwitchMonth = false;
  if (
    anchor.getMonth() !== t.getMonth() ||
    newD.getMonth() !== t.getMonth()
  ) {
    const next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
    anchor = new Date(next.getFullYear(), next.getMonth(), 3);
    newD = new Date(next.getFullYear(), next.getMonth(), 10);
    needSwitchMonth = true;
  }
  const monthKey = `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}`;
  const yesterday = new Date(t);
  yesterday.setDate(t.getDate() - 1);
  return {
    anchorISO: fmtDate(anchor),
    newDISO: fmtDate(newD),
    todayISO: fmtDate(t),
    yesterdayISO: fmtDate(yesterday),
    monthKey,
    needSwitchMonth,
    currentMonthKey,
  };
}

/** The forecast screen's own title (C13: "Forecast" on /forecast). */
const forecastHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /^forecast$/i });

/** Pick the register's month in the "Month & bank" view (`/forecast`). */
async function pickMonth(page: Page, monthKey: string): Promise<void> {
  const trigger = page.getByTestId("select-month-filter");
  await expect(trigger).toBeVisible({ timeout: 5_000 });
  await trigger.click();
  await page.getByRole("option", { name: monthKey, exact: true }).click();
}

/** A household-calendar-agnostic local ISO day `n` days from today. */
function dayFromToday(n: number): string {
  const t = new Date();
  return fmtDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n));
}

/** Drive React's controlled date input directly so we can submit values that
 *  the dialog's `min={tomorrow}` constraint would otherwise filter out at
 *  the browser level. We need to surface the dialog's JS-side guards
 *  (data-testid="move-error") for past/today, not the native picker. */
async function setDateInput(page: Page, value: string): Promise<void> {
  const input = page.getByTestId("input-move-date");
  await input.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("HTMLInputElement value setter missing");
    setter.call(el as HTMLInputElement, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

test.describe("Forecast Move-to date picker (#107)", () => {
  test("refuses days outside the window and the current day, accepts a day inside it, re-lists the row at the new date, and Undo restores it", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-move-107",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/forecast");

    await expect(forecastHeading(page)).toBeVisible({ timeout: 15_000 });

    // --- Compute deterministic anchor / new-date pair, then seed a
    // one-time recurring item via the API so the page has a plan row we
    // own and can move. One-time anchored in the future lands as a
    // "future" plan row, which the Move button is enabled on.
    const dates = pickMoveDates();
    const suffix = Math.random().toString(36).slice(2, 8);
    const itemName = `Move-Test-${suffix}`;

    const item = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/recurring-items",
      {
        name: itemName,
        kind: "expense",
        amount: "42.00",
        frequency: "onetime",
        anchorDate: dates.anchorISO,
        active: "true",
      },
    );

    // Reload so the GET /api/forecast query picks up the new event.
    await page.goto("/forecast");
    await expect(forecastHeading(page)).toBeVisible({ timeout: 15_000 });

    // If anchor/newD live in next month, switch the register's month so the
    // rescheduled-bucket-panel is reachable later.
    if (dates.needSwitchMonth) await pickMonth(page, dates.monthKey);

    const moveButton = page.getByTestId(
      `move-plan-${item.id}-${dates.anchorISO}`,
    );
    await expect(moveButton).toBeVisible({ timeout: 15_000 });

    // --- Open the dialog.
    await moveButton.click();

    const dialogTitle = page.getByRole("heading", {
      name: /Move occurrence to another day/i,
    });
    await expect(dialogTitle).toBeVisible({ timeout: 5_000 });

    const saveButton = page.getByTestId("button-save-move");
    await expect(saveButton).toBeVisible();

    // --- Past-date rejection: yesterday must surface the inline error
    // and must NOT POST to /api/forecast/resolutions. Listening for any
    // such request during the assertion window proves the JS guard runs
    // client-side before any network call.
    let resolutionPostsDuringInvalid = 0;
    const countResolutionPosts = (req: import("@playwright/test").Request) => {
      if (
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/forecast/resolutions"
      ) {
        resolutionPostsDuringInvalid += 1;
      }
    };
    page.on("request", countResolutionPosts);

    await setDateInput(page, dates.yesterdayISO);
    await saveButton.click();
    const errorYesterday = page.getByTestId("move-error");
    await expect(errorYesterday).toBeVisible({ timeout: 5_000 });
    await expect(errorYesterday).toHaveText(/Pick a day within the next 30 days/i);
    await expect(dialogTitle).toBeVisible();

    // --- Past the window (today+31): same inline error, dialog stays mounted.
    await setDateInput(page, dayFromToday(31));
    await saveButton.click();
    const errorFar = page.getByTestId("move-error");
    await expect(errorFar).toBeVisible({ timeout: 5_000 });
    await expect(errorFar).toHaveText(/Pick a day within the next 30 days/i);
    await expect(dialogTitle).toBeVisible();

    // --- The day it is already on: a no-op, refused.
    await setDateInput(page, dates.anchorISO);
    await saveButton.click();
    const errorSame = page.getByTestId("move-error");
    await expect(errorSame).toBeVisible({ timeout: 5_000 });
    await expect(errorSame).toHaveText(/already its current day/i);
    await expect(dialogTitle).toBeVisible();

    // Give the page a beat for any (unwanted) request to flush before
    // we stop counting.
    await page.waitForTimeout(250);
    page.off("request", countResolutionPosts);
    expect(resolutionPostsDuringInvalid).toBe(0);

    // --- Valid future date: the POST succeeds, the dialog closes, and
    // a "Moved to …" toast surfaces.
    const savePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/forecast/resolutions",
      { timeout: 10_000 },
    );

    await setDateInput(page, dates.newDISO);
    await saveButton.click();

    const saveRes = await savePromise;
    expect(saveRes.status()).toBe(200);
    const savedBody = (await saveRes.json()) as {
      id: string;
      status: string;
      rescheduledTo: string | null;
      recurringItemId: string | null;
      occurrenceDate: string | null;
    };
    expect(savedBody.status).toBe("rescheduled");
    expect(savedBody.rescheduledTo).toBe(dates.newDISO);
    expect(savedBody.recurringItemId).toBe(item.id);
    expect(savedBody.occurrenceDate).toBe(dates.anchorISO);

    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(/Moved to/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    // Dialog closes itself on success.
    await expect(dialogTitle).toBeHidden({ timeout: 5_000 });

    // --- The plan row is re-listed at the new date. The Move button's
    // testid encodes the row date, so the original-date button is gone
    // and a new-date button has taken its place.
    await expect(
      page.getByTestId(`move-plan-${item.id}-${dates.anchorISO}`),
    ).toHaveCount(0, { timeout: 10_000 });
    const movedButton = page.getByTestId(
      `move-plan-${item.id}-${dates.newDISO}`,
    );
    await expect(movedButton).toBeVisible({ timeout: 10_000 });

    // --- The rescheduled-bucket-panel surfaces the override with an Undo
    // affordance. The panel is monthFilter-scoped, so we already switched
    // monthFilter above when needed. We assert the panel is wired up
    // (visible + undo testid present) before exercising the missed-panel
    // path below — they're complementary affordances for the same
    // resolution row.
    const rescheduledPanel = page.getByTestId("rescheduled-bucket-panel");
    await expect(rescheduledPanel).toBeVisible({ timeout: 10_000 });
    await expect(rescheduledPanel).toContainText(
      `Moved · ${dates.monthKey}`,
    );
    await expect(
      rescheduledPanel.getByTestId(`rescheduled-undo-${savedBody.id}`),
    ).toBeVisible();

    // --- "Another action moves it there": clicking the moved plan row
    // marks it missed at once (#480: no confirm, an Undo toast instead),
    // upserting a `missed` resolution. Because the upsert key is
    // (recurringItemId, anchor), it replaces the prior rescheduled override
    // — so the row reverts to its original date with status=missed, the
    // rescheduled panel disappears, and the missed-bucket-panel takes over
    // with its own missed-undo-{id} affordance. That panel is the acceptance
    // target for task #107's Undo coverage.

    const upsertMissedPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/forecast/resolutions",
      { timeout: 10_000 },
    );
    // The Move-to button has stopPropagation; clicking the row's label
    // bubbles up to the row's onSelect handler which fires the confirm().
    const rowEl = movedButton.locator(
      'xpath=ancestor::div[@role="button"][1]',
    );
    await rowEl.getByText(itemName).click();
    const missedRes = await upsertMissedPromise;
    expect(missedRes.status()).toBe(200);
    const missedBody = (await missedRes.json()) as {
      id: string;
      status: string;
      recurringItemId: string | null;
      occurrenceDate: string | null;
    };
    expect(missedBody.status).toBe("missed");
    expect(missedBody.recurringItemId).toBe(item.id);
    expect(missedBody.occurrenceDate).toBe(dates.anchorISO);
    // Server replaced the prior rescheduled resolution, so the missed
    // resolution is a fresh row with a different id.
    expect(missedBody.id).not.toBe(savedBody.id);

    await expect(
      notifications.getByText(/Marked missed/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    // The rescheduled panel hides (no rescheduled rows remain in monthFilter)
    // and the row reverts to the original anchor date with the missed badge,
    // surfaced in the missed-bucket-panel.
    await expect(rescheduledPanel).toHaveCount(0, { timeout: 10_000 });
    await expect(
      page.getByTestId(`move-plan-${item.id}-${dates.newDISO}`),
    ).toHaveCount(0, { timeout: 10_000 });

    const missedPanel = page.getByTestId("missed-bucket-panel");
    await expect(missedPanel).toBeVisible({ timeout: 10_000 });
    await expect(missedPanel).toContainText(`Missed · ${dates.monthKey}`);

    const missedUndo = missedPanel.getByTestId(`missed-undo-${missedBody.id}`);
    await expect(missedUndo).toBeVisible();

    // --- Undo from the missed panel: deletes the missed resolution, the
    // panel hides, and the row is fully restored at its original date
    // (Move-to button reappears + active register row is movable again).
    const undoPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "DELETE" &&
        new URL(res.url()).pathname ===
          `/api/forecast/resolutions/${missedBody.id}`,
      { timeout: 10_000 },
    );
    await missedUndo.click();
    const undoRes = await undoPromise;
    expect(undoRes.status()).toBe(204);

    await expect(
      notifications.getByText(/^Undone$/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    await expect(missedPanel).toHaveCount(0, { timeout: 10_000 });
    await expect(
      page.getByTestId(`move-plan-${item.id}-${dates.anchorISO}`),
    ).toBeVisible({ timeout: 10_000 });

    await context.close();
  });

  /**
   * Task #300, as #888 changed it: an occurrence may now move EARLIER than
   * its original date, inside the window (anchor = today + 7, draft =
   * today + 5): the dialog POSTs, the row re-lists at the earlier day. The
   * server mirrors the window (today-1 … today+60): a day past it, or before
   * it, is refused with 400 "rescheduledTo out of allowed window".
   * (C13 repair: the old guard "Pick a date after the original occurrence"
   * and the server's "rescheduledTo must be after occurrenceDate" are gone.)
   */
  test("moves an occurrence earlier than its original date inside the window (#888), and the server mirrors the window", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-move-300",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/forecast");
    await expect(forecastHeading(page)).toBeVisible({ timeout: 15_000 });

    // Pick anchor = today + 7, draft = today + 5, in one month (shift both
    // into next month's 8th/6th when today + 7 crosses the month end; the
    // 6th of next month is still inside today+30).
    const today = new Date();
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let anchor = new Date(t);
    anchor.setDate(t.getDate() + 7);
    let draft = new Date(t);
    draft.setDate(t.getDate() + 5);
    let needSwitchMonth = false;
    if (
      anchor.getMonth() !== t.getMonth() ||
      draft.getMonth() !== t.getMonth()
    ) {
      const next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
      anchor = new Date(next.getFullYear(), next.getMonth(), 8);
      draft = new Date(next.getFullYear(), next.getMonth(), 6);
      needSwitchMonth = true;
    }
    const anchorISO = fmtDate(anchor);
    const draftISO = fmtDate(draft);
    const monthKey = `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    const itemName = `Move-Test-300-${suffix}`;
    const item = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/recurring-items",
      {
        name: itemName,
        kind: "expense",
        amount: "42.00",
        frequency: "onetime",
        anchorDate: anchorISO,
        active: "true",
      },
    );

    await page.goto("/forecast");
    await expect(forecastHeading(page)).toBeVisible({ timeout: 15_000 });
    if (needSwitchMonth) await pickMonth(page, monthKey);

    const moveButton = page.getByTestId(`move-plan-${item.id}-${anchorISO}`);
    await expect(moveButton).toBeVisible({ timeout: 15_000 });
    await moveButton.click();

    const dialogTitle = page.getByRole("heading", {
      name: /Move occurrence to another day/i,
    });
    await expect(dialogTitle).toBeVisible({ timeout: 5_000 });

    const savePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/forecast/resolutions",
      { timeout: 10_000 },
    );
    await setDateInput(page, draftISO);
    await page.getByTestId("button-save-move").click();
    const saveRes = await savePromise;
    expect(saveRes.status()).toBe(200);
    const savedBody = (await saveRes.json()) as {
      status: string;
      rescheduledTo: string | null;
      occurrenceDate: string | null;
    };
    expect(savedBody.status).toBe("rescheduled");
    expect(savedBody.rescheduledTo).toBe(draftISO);
    expect(savedBody.occurrenceDate).toBe(anchorISO);
    await expect(dialogTitle).toBeHidden({ timeout: 5_000 });
    await expect(
      page.getByTestId(`move-plan-${item.id}-${draftISO}`),
    ).toBeVisible({ timeout: 10_000 });

    // --- The server's own window: outside today-1 … today+60 is a 400.
    const probe = async (rescheduledTo: string) =>
      page.evaluate(
        async (args) => {
          const res = await fetch("/api/forecast/resolutions", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "rescheduled",
              recurringItemId: args.recurringItemId,
              occurrenceDate: args.occurrenceDate,
              rescheduledTo: args.rescheduledTo,
            }),
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
          return { status: res.status, body: parsed };
        },
        {
          recurringItemId: item.id,
          occurrenceDate: anchorISO,
          rescheduledTo,
        },
      );

    for (const outside of [dayFromToday(62), dayFromToday(-3)]) {
      const res = await probe(outside);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/out of allowed window/i);
    }

    await context.close();
  });

  /**
   * Task #298: end-to-end coverage for the "Moved · <month>" sub-panel
   * Undo affordance. Spec #107 above already covers Move + Undo via the
   * missed-bucket-panel path (where a follow-up missed resolution overwrites
   * the rescheduled one). This case exercises the *direct* rescheduled
   * Undo button:
   *   - seed a one-time plan row in month A
   *   - open the Move-to dialog and reschedule it into month B (a different
   *     calendar month), so the row leaves month A entirely
   *   - keep monthFilter on month A so the "Moved · <A>" panel surfaces
   *     the rescheduled override with its rescheduled-undo-<id> button
   *   - click that Undo, assert the DELETE /api/forecast/resolutions/<id>
   *     fires and 204s, the panel disappears (no rescheduled rows left in
   *     month A), and the plan re-materializes in the active register at
   *     its original date (Move-to button at the original anchor returns).
   */
  test("rescheduled-bucket Undo deletes the override and restores the plan at its original date (#298)", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-move-298",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/forecast");

    await expect(forecastHeading(page)).toBeVisible({ timeout: 15_000 });

    // Anchor in month A (today + 2, or first week of next month if today
    // is too late in the current month). newD lives in month B, the
    // calendar month *after* the anchor's month, on the 15th — that
    // guarantees a different monthKey and stays well inside the default
    // 90-day forecast horizon.
    const today = new Date();
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const currentMonthKey = `${t.getFullYear()}-${pad(t.getMonth() + 1)}`;
    let anchor = new Date(t);
    anchor.setDate(t.getDate() + 2);
    let needSwitchMonth = false;
    if (anchor.getMonth() !== t.getMonth()) {
      const next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
      anchor = new Date(next.getFullYear(), next.getMonth(), 3);
      needSwitchMonth = true;
    }
    // (C13 repair) #888 bounds a move to today…today+30, so month B is the
    // 1st of the month after the anchor's when that is inside the window;
    // on the rare day it is not (the 1st of a 31-day month), the move stays
    // in month A — the rescheduled Undo under test is the same either way.
    let newD = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    if (fmtDate(newD) > dayFromToday(30)) {
      newD = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7);
    }
    const anchorISO = fmtDate(anchor);
    const newDISO = fmtDate(newD);
    const anchorMonthKey = `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}`;

    const suffix = Math.random().toString(36).slice(2, 8);
    const itemName = `Move-Test-298-${suffix}`;
    const item = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/recurring-items",
      {
        name: itemName,
        kind: "expense",
        amount: "42.00",
        frequency: "onetime",
        anchorDate: anchorISO,
        active: "true",
      },
    );

    await page.goto("/forecast");
    await expect(forecastHeading(page)).toBeVisible({ timeout: 15_000 });

    // monthFilter must sit on the anchor's month so (a) the Move-to button
    // is visible in the active register and (b) the rescheduled-bucket
    // panel surfaces the override after we move it to month B. Default
    // monthFilter is the current calendar month, so we only need to flip
    // it when the anchor was pushed into next month.
    if (needSwitchMonth) await pickMonth(page, anchorMonthKey);
    // currentMonthKey is captured for log readability if this test ever
    // fails on a month-boundary edge case.
    expect(currentMonthKey).toMatch(/^\d{4}-\d{2}$/);

    const moveButton = page.getByTestId(`move-plan-${item.id}-${anchorISO}`);
    await expect(moveButton).toBeVisible({ timeout: 15_000 });
    await moveButton.click();

    const dialogTitle = page.getByRole("heading", {
      name: /Move occurrence to another day/i,
    });
    await expect(dialogTitle).toBeVisible({ timeout: 5_000 });

    const saveButton = page.getByTestId("button-save-move");
    await expect(saveButton).toBeVisible();

    const savePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/forecast/resolutions",
      { timeout: 10_000 },
    );
    await setDateInput(page, newDISO);
    await saveButton.click();

    const saveRes = await savePromise;
    expect(saveRes.status()).toBe(200);
    const savedBody = (await saveRes.json()) as {
      id: string;
      status: string;
      rescheduledTo: string | null;
      recurringItemId: string | null;
      occurrenceDate: string | null;
    };
    expect(savedBody.status).toBe("rescheduled");
    expect(savedBody.rescheduledTo).toBe(newDISO);
    expect(savedBody.recurringItemId).toBe(item.id);
    expect(savedBody.occurrenceDate).toBe(anchorISO);

    await expect(dialogTitle).toBeHidden({ timeout: 5_000 });

    // The original-date Move button is gone from the active register
    // (the row was rescheduled out of monthFilter=anchorMonthKey into
    // month B), and the rescheduled-bucket panel surfaces the override
    // with the per-row Undo button keyed by resolution id.
    await expect(
      page.getByTestId(`move-plan-${item.id}-${anchorISO}`),
    ).toHaveCount(0, { timeout: 10_000 });

    const rescheduledPanel = page.getByTestId("rescheduled-bucket-panel");
    await expect(rescheduledPanel).toBeVisible({ timeout: 10_000 });
    await expect(rescheduledPanel).toContainText(
      `Moved · ${anchorMonthKey}`,
    );
    const rescheduledRow = rescheduledPanel.getByTestId(
      `rescheduled-row-${savedBody.id}`,
    );
    await expect(rescheduledRow).toBeVisible();
    await expect(rescheduledRow).toContainText(itemName);

    // --- Click the rescheduled Undo: DELETE the resolution, panel
    // disappears (no rescheduled rows remain in monthFilter), and the
    // plan re-materializes at its original anchor date in the active
    // register (Move-to button reappears).
    const undoButton = rescheduledPanel.getByTestId(
      `rescheduled-undo-${savedBody.id}`,
    );
    await expect(undoButton).toBeVisible();

    const undoPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "DELETE" &&
        new URL(res.url()).pathname ===
          `/api/forecast/resolutions/${savedBody.id}`,
      { timeout: 10_000 },
    );
    await undoButton.click();
    const undoRes = await undoPromise;
    expect(undoRes.status()).toBe(204);

    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(/^Undone$/i).first(),
    ).toBeVisible({ timeout: 5_000 });

    await expect(rescheduledPanel).toHaveCount(0, { timeout: 10_000 });
    await expect(
      page.getByTestId(`move-plan-${item.id}-${anchorISO}`),
    ).toBeVisible({ timeout: 10_000 });

    await context.close();
  });
});
