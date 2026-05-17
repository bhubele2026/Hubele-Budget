import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #686 — the past-due plans summary card
 * (#683) on the Forecast page.
 *
 * The cash-signal projection collapses every still-pending pre-snapshot/today
 * expense onto today+1 ("dragging" them forward). The forecast page surfaces
 * that group as a discoverable summary card so users understand why
 * tomorrow's projection looks lower than the calendar suggests.
 *
 * This spec locks in:
 *   - The card (`card-dragging-plans-summary`) appears only when at least
 *     one plan is dragging.
 *   - It shows the seeded plan's label + amount + "Originally due …".
 *   - The header reports the right count and the running total
 *     (`dragging-plans-total`).
 *   - The header's target date matches today+1.
 *   - Clicking a row jumps to the matching `data-plan-key` row in the
 *     planned-items register (the register row scrolls into view).
 *   - Marking the plan as missed makes the card disappear (no more
 *     dragging plans).
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function postJson<T>(
  page: Page,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await page.request.post(path, { data: body });
  if (!resp.ok()) {
    const text = await resp.text().catch(() => "");
    throw new Error(`POST ${path} ${resp.status()}: ${text}`);
  }
  return (await resp.json()) as T;
}

test.describe("Forecast past-due plans summary card (#686)", () => {
  test("renders for a dragging plan, deep-links to its register row, and disappears once the plan is marked missed", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "forecast-dragging-686",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/forecast");
    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The Forecast page's first render fans out to /budget/categories,
    // which `ensureSeededDefaults` uses to populate a fresh household
    // with the canonical recurring-bill seed (Mortgage, HELOC, …).
    // That seed includes plenty of past-due expenses that would flood
    // the dragging-plans card with noise, so we wipe the slate before
    // exercising the assertions on our own deterministic plan.
    const seeded = await page.request.get("/api/recurring-items");
    expect(seeded.ok()).toBeTruthy();
    const seededItems = (await seeded.json()) as Array<{ id: string }>;
    for (const r of seededItems) {
      const del = await page.request.delete(`/api/recurring-items/${r.id}`);
      if (!del.ok()) {
        throw new Error(
          `DELETE /api/recurring-items/${r.id} ${del.status()}`,
        );
      }
    }

    // Seed a one-time expense anchored two days in the past. Past-due
    // unresolved expenses are exactly what the (#681) drag-to-tomorrow
    // rule re-hops onto today+1, and `expandStart` reaches back to the
    // prior month so the occurrence is also surfaced in the planned-items
    // register (which is what gives us a real `data-plan-key` row to
    // jump to).
    // Anchor the seeded one-time item on TODAY (not yesterday): the
    // forecast GET runs `archiveExpiredOneTime`, which flips every
    // one-time recurring with `anchorDate < today` to active=false on
    // first load and would erase our fixture before we could assert
    // on it. Today's date is still <= the drag cutoff, so the
    // drag-to-tomorrow rule still kicks in and surfaces the row in
    // the dragging-plans card.
    const today = new Date();
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const pastISO = fmtISO(t);
    const tomorrow = new Date(t);
    tomorrow.setDate(t.getDate() + 1);
    const tomorrowISO = fmtISO(tomorrow);

    const suffix = Math.random().toString(36).slice(2, 8);
    const itemName = `Drag-Test-${suffix}`;
    const amount = "73.45";

    const item = await postJson<{ id: string; name: string }>(
      page,
      "/api/recurring-items",
      {
        name: itemName,
        kind: "expense",
        amount,
        frequency: "onetime",
        anchorDate: pastISO,
        active: "true",
      },
    );

    // Reload so /api/forecast and /api/forecast/cash-signal pick up the
    // new seeded item.
    await page.goto("/forecast");
    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Card surfaces with the expected row.
    const card = page.getByTestId("card-dragging-plans-summary");
    await expect(card).toBeVisible({ timeout: 15_000 });

    // One past-due plan → singular header copy + the seeded amount as
    // the running total. We assert the formatted currency since
    // `formatCurrency` is locale-stable for USD.
    await expect(card).toContainText("1 past-due plan is weighing on");
    const total = card.getByTestId("dragging-plans-total");
    await expect(total).toHaveText(/\$73\.45/);

    // The dragging row uses `dragging-plan-{itemId}-{originalDate}` and
    // shows the seeded label + amount + "Originally due …" sublabel.
    const rowTestId = `dragging-plan-${item.id}-${pastISO}`;
    const row = card.getByTestId(rowTestId);
    await expect(row).toBeVisible();
    await expect(row).toContainText(itemName);
    await expect(row).toContainText(/Originally due/i);
    await expect(row).toContainText(/\$73\.45/);

    // The target date the header references must be today+1. We compute
    // the expected formatted label *inside the page* so it mirrors the
    // exact `formatDate(...)` output the component renders (locale + TZ
    // line up by construction, regardless of how the harness's host
    // resolves "YYYY-MM-DD").
    const expectedTargetLabel = await page.evaluate((iso) => {
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(iso));
    }, tomorrowISO);
    await expect(card).toContainText(expectedTargetLabel);

    // --- Deep-link: clicking the row scrolls/highlights the matching
    // `data-plan-key` row in the planned-items register. The register
    // row exists at the seeded occurrence's original date.
    const planKey = `${item.id}|${pastISO}`;
    const planRow = page.locator(
      `[data-plan-key="${planKey.replace(/"/g, '\\"')}"]`,
    );
    await expect(planRow).toHaveCount(1, { timeout: 10_000 });

    // The row hosts several action buttons (jump, mark-missed, skip,
    // match-trigger). Click the explicit "jump" button rather than the
    // generic locator so the deep-link assertion targets the right one.
    await page
      .getByTestId(`dragging-plan-jump-${item.id}-${pastISO}`)
      .click();

    // The page calls scrollIntoView inside a requestAnimationFrame, so
    // give the smooth-scroll a beat before asserting the row is in view.
    await expect(planRow).toBeInViewport({ timeout: 10_000 });

    // --- Mark missed: the card disappears once no plans are dragging.
    // We drive the API directly (the mark-missed button lives on the
    // same plan-row but the register is virtualized, and we already
    // proved the deep-link wiring above). A `missed` resolution is
    // exactly what the cash signal checks to stop the drag.
    await postJson(page, "/api/forecast/resolutions", {
      status: "missed",
      recurringItemId: item.id,
      occurrenceDate: pastISO,
    });

    await page.goto("/forecast");
    await expect(
      page.getByRole("heading", { name: /plan register/i }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByTestId("card-dragging-plans-summary"),
    ).toHaveCount(0, { timeout: 15_000 });

    await context.close();
  });
});
