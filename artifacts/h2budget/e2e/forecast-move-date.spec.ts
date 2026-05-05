import { test, expect } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";
import { seedRecurringBill } from "./helpers/api";

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

function isoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

test.describe("Forecast move-to date picker (#107)", () => {
  test("forecast page renders, the move dialog opens with a date picker, and saving moves the plan row to the new date", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-move",
      provisionedUserIds,
    );

    // Sign in first so `page.request` carries the Clerk session cookie,
    // then seed a monthly recurring bill via API so the forecast register
    // is guaranteed to render at least one movable plan row. Without this
    // seed the spec would silently no-op for fresh users with no
    // recurring items, never actually exercising the move flow.
    await signInAndOpen(page, email, password, "/forecast");
    const bill = await seedRecurringBill(page);

    // Reload Forecast so the freshly-seeded recurring item is included
    // in the page's initial query payload.
    await page.goto("/forecast");
    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Pick the source occurrence dynamically from the same forecast
    // payload the page renders from. We need a row that is strictly in
    // the future (only `pending_plan`/`future` rows are movable) and we
    // can't hardcode `today + N` for the source date because the seed
    // might land the first occurrence in next month when today is at
    // month-end. Querying the API guarantees we click an actually
    // movable, deterministic row regardless of calendar position.
    const todayISO = isoDate(new Date());
    const fcResp = await page.request.get("/api/forecast?days=90");
    expect(fcResp.ok()).toBeTruthy();
    const fcBody = (await fcResp.json()) as {
      events: { itemId: string; date: string }[];
    };
    const futureBillEvents = fcBody.events
      .filter((e) => e.itemId === bill.id && e.date > todayISO)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    expect(futureBillEvents.length).toBeGreaterThan(0);
    const sourceDate = futureBillEvents[0].date;

    const moveButton = page.getByTestId(`move-plan-${bill.id}-${sourceDate}`);
    await expect(moveButton).toBeVisible({ timeout: 15_000 });
    await moveButton.click();

    // Use the dialog's specific input, not the page-level "Forecast from"
    // date input that also matches `input[type="date"]`.
    const dateInput = page.getByTestId("input-move-date");
    await expect(dateInput).toBeVisible({ timeout: 5_000 });

    // Pick a target date 35 days past the source. That guarantees:
    //  1. it's strictly after the source (server validates this),
    //  2. it lands in a different calendar month than the source, and
    //  3. it falls on a different day-of-month than the bill's
    //     `dayOfMonth`, so it can't collide with a natural recurring
    //     occurrence and create two move-buttons at the same testid.
    const sourceParts = sourceDate.split("-").map((s) => Number(s));
    const sourceMs = Date.UTC(
      sourceParts[0],
      sourceParts[1] - 1,
      sourceParts[2],
    );
    const targetMs = sourceMs + 35 * 24 * 60 * 60 * 1000;
    const targetDateObj = new Date(targetMs);
    const targetDate = `${targetDateObj.getUTCFullYear()}-${String(
      targetDateObj.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(targetDateObj.getUTCDate()).padStart(2, "0")}`;
    expect(targetDate > sourceDate).toBeTruthy();
    expect(targetDateObj.getUTCDate()).not.toBe(bill.dayOfMonth);
    await dateInput.fill(targetDate);

    // Wait for the resolution POST to actually return 2xx so we know
    // the server persisted the move before asserting the UI state —
    // otherwise the assertions race the in-flight mutation.
    const resolutionRespP = page.waitForResponse(
      (r) =>
        r.url().includes("/api/forecast/resolutions") &&
        r.request().method() === "POST",
    );
    await page.getByTestId("button-save-move").click();
    const resolutionResp = await resolutionRespP;
    expect(resolutionResp.status()).toBeGreaterThanOrEqual(200);
    expect(resolutionResp.status()).toBeLessThan(300);

    // Verify the move both server-side (a rescheduled resolution exists
    // for the seeded bill at the picked source/target dates) and
    // client-side (the original row's move button is gone and a new
    // move button at the target date is rendered). This avoids relying
    // on the rescheduled-bucket panel, which only renders when the
    // page's `monthFilter` matches the source occurrence's month.
    const fcAfterResp = await page.request.get("/api/forecast?days=90");
    const fcAfter = (await fcAfterResp.json()) as {
      resolutions: {
        recurringItemId: string | null;
        occurrenceDate: string | null;
        status: string;
        rescheduledTo: string | null;
      }[];
    };
    const matched = fcAfter.resolutions.find(
      (r) =>
        r.recurringItemId === bill.id &&
        r.occurrenceDate === sourceDate &&
        r.status === "rescheduled" &&
        r.rescheduledTo === targetDate,
    );
    expect(matched).toBeTruthy();

    await expect(
      page.getByTestId(`move-plan-${bill.id}-${sourceDate}`),
    ).toHaveCount(0, { timeout: 10_000 });
    await expect(
      page.getByTestId(`move-plan-${bill.id}-${targetDate}`),
    ).toBeVisible({ timeout: 10_000 });
  });
});
