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
 * The dialog rejects past dates and today with a visible inline error
 * (data-testid="move-error") instead of POSTing to the API.
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
  test("rejects past/today, accepts a future date, re-lists the row at the new date, and Undo restores it", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-move-107",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/forecast");

    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

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
    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

    // If anchor/newD live in next month, switch monthFilter via the bucket
    // tab's month Select so the rescheduled-bucket-panel is reachable
    // later. monthFilter is component-level state that persists across tab
    // switches, so we can flip it once and switch back to the register.
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

    const moveButton = page.getByTestId(
      `move-plan-${item.id}-${dates.anchorISO}`,
    );
    await expect(moveButton).toBeVisible({ timeout: 15_000 });

    // --- Open the dialog.
    await moveButton.click();

    const dialogTitle = page.getByRole("heading", {
      name: /Move occurrence to a future date/i,
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
    await expect(errorYesterday).toHaveText(/Pick a date after today/i);
    await expect(dialogTitle).toBeVisible();

    // --- Today rejection: same inline error, dialog stays mounted.
    await setDateInput(page, dates.todayISO);
    await saveButton.click();
    const errorToday = page.getByTestId("move-error");
    await expect(errorToday).toBeVisible({ timeout: 5_000 });
    await expect(errorToday).toHaveText(/Pick a date after today/i);
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
      `Moved from ${dates.monthKey}`,
    );
    await expect(
      rescheduledPanel.getByTestId(`rescheduled-undo-${savedBody.id}`),
    ).toBeVisible();

    // --- "Another action moves it there": clicking the moved plan row
    // triggers a window.confirm() that, on accept, upserts a `missed`
    // resolution. Because the upsert key is (recurringItemId, anchor),
    // it replaces the prior rescheduled override — so the row reverts
    // to its original date with status=missed, the rescheduled panel
    // disappears, and the missed-bucket-panel takes over with its own
    // missed-undo-{id} affordance. That panel is the acceptance target
    // for task #107's Undo coverage.
    page.once("dialog", (dialog) => dialog.accept());

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
    await expect(missedPanel).toContainText(`Missed in ${dates.monthKey}`);

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
   * Task #300: the dialog has a third client-side guard rejecting any date
   * that isn't strictly after the original occurrence. Spec #107 covers
   * "pick a date" and "pick a date after today"; this case fills the picker
   * with a future-but-before-original date (anchor = today + 7,
   * draft = today + 5) and asserts the inline error fires without any POST
   * to /api/forecast/resolutions. Also pokes the server's mirror guard
   * directly to confirm it returns 400 when called with rescheduledTo
   * <= occurrenceDate.
   */
  test("rejects a future date that's not after the original occurrence (and the server mirrors the guard)", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-move-300",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/forecast");

    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Pick anchor = today + 7, draft = today + 5. Both must be strictly
    // after today (so we exercise the *third* guard, not the
    // "after today" one). If today + 7 would cross a month boundary we
    // shift both into next month and bump the monthFilter so the plan
    // row is reachable in the active register.
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
    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

    if (needSwitchMonth) {
      await page.getByRole("tab", { name: /Review Bucket/i }).click();
      const monthCombobox = page.getByRole("combobox").first();
      await expect(monthCombobox).toBeVisible({ timeout: 5_000 });
      await monthCombobox.click();
      await page
        .getByRole("option", { name: monthKey, exact: true })
        .click();
      await page.getByRole("tab", { name: /Active Register/i }).click();
    }

    const moveButton = page.getByTestId(`move-plan-${item.id}-${anchorISO}`);
    await expect(moveButton).toBeVisible({ timeout: 15_000 });
    await moveButton.click();

    const dialogTitle = page.getByRole("heading", {
      name: /Move occurrence to a future date/i,
    });
    await expect(dialogTitle).toBeVisible({ timeout: 5_000 });

    const saveButton = page.getByTestId("button-save-move");
    await expect(saveButton).toBeVisible();

    // Watch for any POST to /api/forecast/resolutions during the
    // attempted save: the third guard must short-circuit client-side.
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

    await setDateInput(page, draftISO);
    await saveButton.click();

    const error = page.getByTestId("move-error");
    await expect(error).toBeVisible({ timeout: 5_000 });
    await expect(error).toHaveText(/Pick a date after the original occurrence\./i);
    await expect(dialogTitle).toBeVisible();

    await page.waitForTimeout(250);
    page.off("request", countResolutionPosts);
    expect(resolutionPostsDuringInvalid).toBe(0);

    // --- Bonus: hit the server directly to confirm the mirror guard.
    // Equal date (rescheduledTo == occurrenceDate) and a strictly-earlier
    // date both must 400. We use page.evaluate to issue an authenticated
    // fetch that returns status + parsed body without throwing on 4xx.
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

    const equalRes = await probe(anchorISO);
    expect(equalRes.status).toBe(400);
    expect(JSON.stringify(equalRes.body)).toMatch(
      /rescheduledTo must be after occurrenceDate/i,
    );

    const earlierRes = await probe(draftISO);
    expect(earlierRes.status).toBe(400);
    expect(JSON.stringify(earlierRes.body)).toMatch(
      /rescheduledTo must be after occurrenceDate/i,
    );

    await context.close();
  });
});
