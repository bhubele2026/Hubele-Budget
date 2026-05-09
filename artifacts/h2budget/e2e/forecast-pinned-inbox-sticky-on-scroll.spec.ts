import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #518:
 *
 * Task #517 pinned the unmatched inbox card area on the Forecast → Active
 * Register tab so it stays visible while the planned-items list scrolls
 * underneath it (data-testid `pinned-inbox-area` with
 * `data-pinned="true"` on tall+wide viewports). This spec locks in that
 * pin behavior:
 *   - With one unmatched bank inbox row plus enough planned forecast items
 *     to make the page scroll, the pinned region — including its pager
 *     (`bank-inbox-pager`) and the active inbox card — stays visible at
 *     the top of the viewport (just below the page's own sticky header)
 *     after the user scrolls the page down.
 *   - When the inbox empties (no unmatched rows left), the pinned area
 *     unmounts entirely so no empty pinned bar lingers.
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

function currentMonthDay(day: number): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

test.describe("Forecast pinned inbox stays visible on scroll (#518)", () => {
  test("pinned-inbox-area sticks below the page header while scrolling, and unmounts when the inbox empties", async ({
    page,
  }) => {
    // (#517) The pin only engages on viewports that satisfy the
    // `(min-height: 720px) and (min-width: 768px)` media query — short or
    // narrow viewports keep the legacy non-pinned layout. We size the
    // viewport tall+wide so `data-pinned="true"` is the path under test,
    // and tall enough that there's real headroom to scroll past where the
    // unpinned card would have left the viewport.
    await page.setViewportSize({ width: 1280, height: 800 });

    const { email, password } = await createTestUser(
      "forecast-pinned-inbox-sticky-518",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });

    // --- Seed enough planned items + one unmatched bank inbox row.
    //
    // Planned items: 18 monthly bills on different days of the current
    // month. With distinct names + amounts none of them collide with the
    // single unmatched bank txn we add below, so the inbox stays at
    // exactly 1 pending row (which keeps the pager assertions stable).
    // 18 rows is plenty to push the planned list below the fold on an
    // 800px viewport.
    const suffix = Math.random().toString(36).slice(2, 8);
    const billCount = 18;
    for (let i = 0; i < billCount; i++) {
      const dayOfMonth = (i % 27) + 1;
      await apiCall<{ id: string }>(page, "POST", "/api/recurring-items", {
        name: `PinScroll-${suffix}-${i}`,
        kind: "bill",
        amount: (10 + i).toFixed(2),
        frequency: "monthly",
        dayOfMonth,
        active: "true",
      });
    }

    // One pending bank inbox row with an amount that does not match any
    // of the seeded bills (bills are 10.00..27.00; this is 999.99). Manual
    // rows with `forecastFlag: true` land in the Active Register inbox.
    const unmatched = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: currentMonthDay(15),
        description: `PIN-SCROLL-${suffix} UNMATCHED`,
        amount: "-999.99",
        forecastFlag: true,
      },
    );

    await page.goto("/review");
    await expect(page.getByTestId("card-from-bank")).toBeVisible({
      timeout: 15_000,
    });

    const pinnedArea = page.getByTestId("pinned-inbox-area");
    const pager = page.getByTestId("bank-inbox-pager");
    const inboxCheckbox = page.getByTestId(`select-bank-${unmatched.id}`);

    // --- The pinned region renders, in pinned mode, with the pager + the
    // active inbox card visible. (`data-pinned="true"` proves the
    // viewport-gated pin path is the one under test, not the legacy
    // non-pinned fallback.)
    await expect(pinnedArea).toBeVisible({ timeout: 15_000 });
    await expect(pinnedArea).toHaveAttribute("data-pinned", "true");
    await expect(pager).toBeVisible();
    await expect(inboxCheckbox).toBeVisible();
    await expect(page.getByTestId("bank-inbox-pager-indicator")).toHaveText(
      "1 of 1",
    );

    // --- Capture the pinned region's natural on-screen position before
    // we scroll. We compare this against its position *after* scrolling
    // to prove it actually pinned (a non-sticky element would have moved
    // up by ~the scroll delta and gone off-screen).
    const measure = () =>
      page.evaluate(() => {
        const pinned = document.querySelector(
          '[data-testid="pinned-inbox-area"]',
        ) as HTMLElement | null;
        const pagerEl = document.querySelector(
          '[data-testid="bank-inbox-pager"]',
        ) as HTMLElement | null;
        const cardEl = document.querySelector(
          '[data-testid="card-from-bank"]',
        ) as HTMLElement | null;
        const main = document.querySelector("main");
        const pinnedRect = pinned?.getBoundingClientRect();
        const pagerRect = pagerEl?.getBoundingClientRect();
        return {
          mainScrollTop: main?.scrollTop ?? 0,
          mainScrollHeight: main?.scrollHeight ?? 0,
          mainClientHeight: main?.clientHeight ?? 0,
          viewportHeight: window.innerHeight,
          pinnedTop: pinnedRect?.top ?? null,
          pinnedBottom: pinnedRect?.bottom ?? null,
          pagerTop: pagerRect?.top ?? null,
          pagerBottom: pagerRect?.bottom ?? null,
          cardPresent: !!cardEl,
        };
      });

    const before = await measure();
    expect(before.pinnedTop).not.toBeNull();
    // Sanity: the planned list is tall enough to actually require
    // scrolling — otherwise the "stays visible while scrolling"
    // assertion below would be vacuously true.
    expect(before.mainScrollHeight).toBeGreaterThan(
      before.mainClientHeight + 400,
    );

    // --- Scroll the app shell well past where the inbox card would
    // normally have left the viewport. The shell scrolls inside its
    // `<main>` element (h-screen, overflow-y-auto), not the window, so
    // drive that scroller directly.
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main) main.scrollTop = 1500;
    });
    await page.waitForTimeout(200);

    const after = await measure();
    // Confirm the scroll actually happened and was substantial. (If
    // 1500 exceeded scrollHeight, the browser will clamp; either way
    // we want at least 400px of scroll for the assertion to be
    // meaningful.)
    expect(after.mainScrollTop).toBeGreaterThan(400);

    // --- The pinned region (and the pager + active inbox card inside
    // it) is still visible after the scroll.
    await expect(pinnedArea).toBeVisible();
    await expect(pager).toBeVisible();
    await expect(inboxCheckbox).toBeVisible();
    expect(after.cardPresent).toBe(true);

    // The smoking gun for "actually pinned": after scrolling the planned
    // list down by hundreds of pixels, the pinned region's top edge is
    // still in the upper portion of the viewport — i.e. its sticky
    // `top:` offset clamped it in place. A non-sticky element with the
    // same starting position would have moved up by ~`after.mainScrollTop`
    // and ended up well off-screen (very negative top).
    expect(after.pinnedTop).not.toBeNull();
    expect(before.pinnedTop).not.toBeNull();
    expect(after.pinnedTop as number).toBeGreaterThanOrEqual(0);
    expect(after.pinnedTop as number).toBeLessThan(
      after.viewportHeight / 2,
    );
    // Without sticky, scrolling by `after.mainScrollTop` would have
    // pulled the pinned region's viewport top down by the same amount.
    // Sticky should leave it well above that no-sticky baseline.
    const noStickyExpectedTop =
      (before.pinnedTop as number) - after.mainScrollTop;
    expect(after.pinnedTop as number).toBeGreaterThan(
      noStickyExpectedTop + 200,
    );
    // The pager + active card are within the visible viewport.
    expect(after.pagerTop as number).toBeGreaterThanOrEqual(0);
    expect(after.pagerBottom as number).toBeLessThanOrEqual(
      after.viewportHeight,
    );

    // --- Empty-state: resolve the only pending row and assert the entire
    // pinned region unmounts (no empty pinned bar left behind).
    await page.evaluate(() => window.scrollTo(0, 0));
    const unplannedBtn = pinnedArea.getByRole("button", {
      name: /^unplanned$/i,
    });
    await expect(unplannedBtn).toBeVisible();
    await unplannedBtn.click();

    await expect(page.getByTestId("pinned-inbox-area")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("bank-inbox-pager")).toHaveCount(0);
    // The Active Register's empty-state copy takes over (no lingering
    // pinned bar).
    await expect(page.getByTestId("card-from-bank")).toContainText(
      /Send a bank transaction|Reconciled to bank/i,
    );
  });
});
