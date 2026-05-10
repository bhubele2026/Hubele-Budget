import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #626 — toggling the WK bubble on an
 * Amex row used to add/remove the weekly-bucket Select, which changed
 * the row's footprint and made the virtualized day group re-measure
 * (via measureElement / ResizeObserver) and shift every row below it.
 *
 * The original #626 fix added a fixed-size weekly-bucket slot
 * (`h-7 w-28 shrink-0`) that was always present in the DOM, with
 * `visibility: hidden` when WK was off, so the row height stayed
 * stable across WK toggles. A later commit (8694ee19, "Remove
 * unnecessary dropdown menus from the Amex screen") deleted the
 * weekly-bucket dropdown altogether, which means there is no longer
 * a conditionally-rendered dropdown for the WK bubble to gate. The
 * test from the task brief that asserted "weekly-bucket dropdown is
 * visible/usable when WK is on and not interactive when WK is off"
 * no longer has a UI to assert against and has been intentionally
 * dropped here — see the drift note in the task commit message.
 *
 * The row-stability core of #626 still matters: if anyone re-adds a
 * WK-conditional control in a future iteration without reserving
 * space for it, the virtualized list will bounce again. So this
 * spec keeps the bounding-box assertion: it seeds three rows on the
 * same day so they share a DayGroup, records the document-relative
 * top of two sibling rows below the target, toggles WK on and then
 * off on the target via the bubble, and asserts the siblings don't
 * shift by more than ~1px in either direction.
 *
 * Runs on both desktop (1280px) and mobile (390px) viewports because
 * the WK bubble lives in both layouts and #626 had to fix both.
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Allow up to 1px of jitter — sub-pixel rendering differences from
// focus rings / pressed state styling can nudge layout by fractions
// of a pixel without indicating a real reflow. Anything larger means
// the row re-measured, which is exactly what #626 fixed.
const MAX_DRIFT_PX = 1;

// Document-relative top so any incidental scroll between samples
// (e.g. the optimistic re-render scrolling focus) doesn't pollute
// the drift calculation. A real layout reflow would still move the
// row in document coordinates; a pure scroll wouldn't.
async function rowTop(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate(
    (el) => el.getBoundingClientRect().top + window.scrollY,
  );
}

type Layout = {
  name: string;
  viewport: { width: number; height: number };
  rowTestId: (id: string) => string;
};

const LAYOUTS: Layout[] = [
  {
    name: "desktop",
    viewport: { width: 1280, height: 800 },
    rowTestId: (id) => `row-amex-${id}`,
  },
  {
    name: "mobile",
    viewport: { width: 390, height: 844 },
    rowTestId: (id) => `row-amex-mobile-${id}`,
  },
];

test.describe("Amex WK toggle row stability (#626)", () => {
  for (const layout of LAYOUTS) {
    test.describe(layout.name, () => {
      test.use({ viewport: layout.viewport });

      test(`toggling WK on/off keeps sibling rows in place`, async ({
        page,
      }) => {
        const { email, password } = await createTestUser(
          `amex-wk-stability-626-${layout.name}`,
          provisionedUserIds,
        );

        await signInAndOpen(page, email, password, "/amex");
        await expect(
          page.getByRole("heading", { name: /american express/i }),
        ).toBeVisible({ timeout: 15_000 });

        // Seed five Amex rows on the same date so they land in the
        // same DayGroup. Within-day order on the Amex page is
        // determined by `compareNewestFirst` (occurredOn, then
        // occurredAt, then id) — NOT amount — so we cannot pick
        // which seeded row will be the "target" up front. Instead,
        // we seed five rows, render the page, read the actual DOM
        // order, and choose a target that has at least two siblings
        // *below* it. Five gives plenty of room even if the target
        // happens to land near the bottom of the seeded set.
        const today = todayIso();
        const suffix = Math.random().toString(36).slice(2, 8);
        const seedDesc = (i: number) => `AMEX WK STABILITY ${suffix} R${i}`;

        const seededIds: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const row = await apiCall<{ id: string }>(
            page,
            "POST",
            "/api/transactions",
            {
              occurredOn: today,
              description: seedDesc(i),
              amount: `${100 + i * 10}.00`,
              source: "amex",
              categoryId: null,
              reviewed: false,
            },
          );
          seededIds.push(row.id);
        }

        // Reload so the freshly-seeded rows are fetched into the
        // list. Wait for every seeded row to be present in the DOM
        // so we can read a complete and stable visual ordering —
        // the seeded rows themselves are a stronger readiness
        // signal than the page header (which can be hidden behind
        // the mobile sidebar collapse).
        await page.goto("/amex");
        for (const id of seededIds) {
          await expect(page.getByTestId(layout.rowTestId(id))).toBeVisible({
            timeout: 20_000,
          });
        }

        await page.evaluate(() => window.scrollTo(0, 0));

        // Read each seeded row's document-relative top and sort
        // ascending — that's the on-screen top→bottom order. Pick
        // the row at index 0 as the target so indices 1 and 2 are
        // guaranteed siblings *below* it. Verified by an explicit
        // precondition assertion below before any toggling happens.
        const tops: Array<{ id: string; top: number }> = [];
        for (const id of seededIds) {
          tops.push({ id, top: await rowTop(page, layout.rowTestId(id)) });
        }
        tops.sort((a, b) => a.top - b.top);

        const targetId = tops[0].id;
        const sibling1Id = tops[1].id;
        const sibling2Id = tops[2].id;

        const targetTestId = layout.rowTestId(targetId);
        const sibling1TestId = layout.rowTestId(sibling1Id);
        const sibling2TestId = layout.rowTestId(sibling2Id);

        const targetTr = page.getByTestId(targetTestId);
        const sibling1Tr = page.getByTestId(sibling1TestId);
        const sibling2Tr = page.getByTestId(sibling2TestId);

        // Precondition: both measured siblings must sit strictly
        // below the target, otherwise a target row-height change
        // wouldn't shift them and the test would silently pass.
        const targetTopInitial = await rowTop(page, targetTestId);
        expect(tops[1].top).toBeGreaterThan(targetTopInitial);
        expect(tops[2].top).toBeGreaterThan(targetTopInitial);

        await expect(targetTr).toBeVisible();
        await expect(sibling1Tr).toBeVisible();
        await expect(sibling2Tr).toBeVisible();

        const sibling1TopBefore = await rowTop(page, sibling1TestId);
        const sibling2TopBefore = await rowTop(page, sibling2TestId);

        // --- Toggle WK ON on the target row ---
        const wkButton = targetTr.getByRole("button", {
          name: /weekly bucket/i,
        });
        await expect(wkButton).toBeVisible();
        // Both the page sticky header and the day-group sticky
        // header can overlap the target row at the top of the
        // viewport, intercepting Playwright's hit-tested click.
        // Dispatch the click directly on the bubble — its onClick
        // handler does the toggling regardless of viewport
        // hit-testing, and we verify the result via aria-pressed.
        await wkButton.dispatchEvent("click");

        // Wait until the optimistic cache update flips the bubble's
        // pressed state, so any layout side-effects of the new
        // weeklyAllowance value have had a chance to flush before
        // we re-measure the siblings.
        await expect(wkButton).toHaveAttribute(
          "aria-pressed",
          "true",
          { timeout: 10_000 },
        );

        const sibling1TopAfterOn = await rowTop(page, sibling1TestId);
        const sibling2TopAfterOn = await rowTop(page, sibling2TestId);

        expect(
          Math.abs(sibling1TopAfterOn - sibling1TopBefore),
        ).toBeLessThanOrEqual(MAX_DRIFT_PX);
        expect(
          Math.abs(sibling2TopAfterOn - sibling2TopBefore),
        ).toBeLessThanOrEqual(MAX_DRIFT_PX);

        // --- Toggle WK back OFF on the target row ---
        await wkButton.dispatchEvent("click");
        await expect(wkButton).toHaveAttribute(
          "aria-pressed",
          "false",
          { timeout: 10_000 },
        );

        const sibling1TopAfterOff = await rowTop(page, sibling1TestId);
        const sibling2TopAfterOff = await rowTop(page, sibling2TestId);

        expect(
          Math.abs(sibling1TopAfterOff - sibling1TopBefore),
        ).toBeLessThanOrEqual(MAX_DRIFT_PX);
        expect(
          Math.abs(sibling2TopAfterOff - sibling2TopBefore),
        ).toBeLessThanOrEqual(MAX_DRIFT_PX);
      });
    });
  }
});
