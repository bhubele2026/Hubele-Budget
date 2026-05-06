import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the per-source filter chip row added to the
 * Dashboard's WK/MO/UN buckets in task #278 (which replaced the legacy
 * single "Include other sources" toggle from #28).
 *
 * Unit tests in `dashboardSourceChips.test.tsx` already cover the
 * label/detection helpers and the in-process toggle behavior. This spec
 * locks down the *rendered* contract end-to-end:
 *   - Every detected source for the current month surfaces a chip in the
 *     `dashboard-source-chips` row.
 *   - Toggling a chip off removes that source's transactions from the
 *     WK row list and drops its amount from the WEEKLY total.
 *   - The selection persists across a full page reload via the
 *     `h2budget:dashboardSelectedSources` localStorage key.
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
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type Seeded = { id: string; description: string };

async function seedWeeklyTxn(
  page: Page,
  source: string,
  description: string,
  amount: string,
): Promise<Seeded> {
  const row = await apiCall<{ id: string; description: string }>(
    page,
    "POST",
    "/api/transactions",
    {
      occurredOn: todayIso(),
      description,
      amount,
      source,
      weeklyAllowance: true,
      weeklyBucket: "misc",
      categoryId: null,
    },
  );
  return { id: row.id, description: row.description };
}

test.describe("Dashboard source filter chips (#278)", () => {
  test("toggles a source's rows + WK total in/out and persists selection across reload", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "dashboard-source-chips-278",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    await signInAndOpen(page, email, password, "/");

    // The h1 "Dashboard" only renders in the loading skeleton; once the
    // dashboard payload resolves, the buckets section ("Life spending")
    // becomes the stable anchor we can wait on.
    await expect(
      page.getByRole("heading", { name: /^life spending$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Wait for the chip row to mount with the empty-state copy first so we
    // know `DashboardMonthlyBuckets` has rendered before we seed rows.
    const chipRow = page.getByTestId("dashboard-source-chips");
    await expect(chipRow).toBeVisible({ timeout: 15_000 });
    await expect(chipRow).toContainText(/no tagged sources yet/i);

    // Seed three weekly-tagged rows in the current month, one per source
    // we want to assert chips for. Distinct amounts keep the WEEKLY total
    // arithmetic unambiguous: $11 + $22 + $33 = $66.
    const amex = await seedWeeklyTxn(page, "amex", "AMEX-CHIP-TEST", "-11.00");
    const chase = await seedWeeklyTxn(
      page,
      "plaid:chase",
      "CHASE-CHIP-TEST",
      "-22.00",
    );
    const manual = await seedWeeklyTxn(
      page,
      "manual",
      "MANUAL-CHIP-TEST",
      "-33.00",
    );

    // Reload so the dashboard's `useListTransactions` query picks up the
    // seeded rows on its initial fetch (avoids racing the cache).
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /^life spending$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const amexChip = page.getByTestId("chip-source-amex");
    const chaseChip = page.getByTestId("chip-source-chase");
    const manualChip = page.getByTestId("chip-source-manual");
    await expect(amexChip).toBeVisible({ timeout: 15_000 });
    await expect(chaseChip).toBeVisible();
    await expect(manualChip).toBeVisible();

    // Default selection (no prior pref) is Amex-only — preserves the #28
    // historical default. The Amex row is in the WK list; the others aren't.
    await expect(amexChip).toHaveAttribute("aria-pressed", "true");
    await expect(chaseChip).toHaveAttribute("aria-pressed", "false");
    await expect(manualChip).toHaveAttribute("aria-pressed", "false");

    const amexRow = page.getByTestId(`row-weekly-${amex.id}`);
    const chaseRow = page.getByTestId(`row-weekly-${chase.id}`);
    const manualRow = page.getByTestId(`row-weekly-${manual.id}`);
    await expect(amexRow).toBeVisible();
    await expect(chaseRow).toHaveCount(0);
    await expect(manualRow).toHaveCount(0);

    // Locate the WEEKLY total (the big tabular-nums number sitting next to
    // the "/ $cap" inline editor in the WEEKLY card). Scoping to the WEEKLY
    // section avoids matching the MONTHLY/UNPLANNED totals.
    const weeklySection = page
      .locator("section", { hasText: /^WEEKLY/ })
      .first();
    const weeklyTotal = weeklySection
      .locator(".text-4xl, .md\\:text-5xl")
      .first();
    await expect(weeklyTotal).toHaveText(/\$11\.00/);

    // Toggle Chase ON → its row joins the list and the WEEKLY total grows
    // to $33 ($11 amex + $22 chase).
    await chaseChip.click();
    await expect(chaseChip).toHaveAttribute("aria-pressed", "true");
    await expect(chaseRow).toBeVisible();
    await expect(amexRow).toBeVisible();
    await expect(manualRow).toHaveCount(0);
    await expect(weeklyTotal).toHaveText(/\$33\.00/);

    // Toggle Amex OFF → only Chase remains; total drops to $22.
    await amexChip.click();
    await expect(amexChip).toHaveAttribute("aria-pressed", "false");
    await expect(amexRow).toHaveCount(0);
    await expect(chaseRow).toBeVisible();
    await expect(weeklyTotal).toHaveText(/\$22\.00/);

    // localStorage now reflects the explicit selection (Chase only).
    const stored = await page.evaluate(() =>
      window.localStorage.getItem("h2budget:dashboardSelectedSources"),
    );
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).sort()).toEqual(["chase"]);

    // Full reload — selection survives, totals/rows match the persisted
    // Chase-only state, NOT the Amex-only default.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^life spending$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const amexChip2 = page.getByTestId("chip-source-amex");
    const chaseChip2 = page.getByTestId("chip-source-chase");
    await expect(chaseChip2).toHaveAttribute("aria-pressed", "true");
    await expect(amexChip2).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId(`row-weekly-${chase.id}`)).toBeVisible();
    await expect(page.getByTestId(`row-weekly-${amex.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`row-weekly-${manual.id}`)).toHaveCount(0);
    const weeklyTotal2 = page
      .locator("section", { hasText: /^WEEKLY/ })
      .first()
      .locator(".text-4xl, .md\\:text-5xl")
      .first();
    await expect(weeklyTotal2).toHaveText(/\$22\.00/);

    await context.close();
  });
});
