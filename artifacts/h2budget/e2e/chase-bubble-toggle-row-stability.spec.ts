import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #639 — proactive guard against the
 * row-bouncing failure mode that #626 fixed on the Amex page, applied
 * to the Chase Transactions page (`/transactions`). The Chase rows
 * share the same DayGroup-based virtualized layout as Amex, so any
 * future conditionally-rendered row control wired to a bucket-bubble
 * (or any other per-row toggle) could re-trigger the same
 * `measureElement` / `ResizeObserver` reflow that shifted every row
 * below the toggled one.
 *
 * Strategy mirrors `amex-wk-toggle-row-stability.spec.ts`:
 *  1. Seed five Chase-source rows on today's date so they share a
 *     single DayGroup.
 *  2. Reload, read the on-screen top→bottom order from the rendered
 *     rows, and pick the topmost as the target so two siblings sit
 *     strictly below it (precondition asserted before any toggle).
 *  3. Toggle the WK bubble on the target row via dispatchEvent
 *     (sticky day-group / page headers can intercept Playwright's
 *     hit-tested click on the topmost row), wait for aria-pressed to
 *     flip, and re-measure both siblings' document-relative tops.
 *  4. Toggle WK back off, re-measure again. Assert siblings stayed
 *     within ~1px (sub-pixel jitter from focus rings is fine; a real
 *     reflow would shift them by a row's worth of height).
 *
 * Today the Chase row template has no WK-conditional control, so
 * this test passes against the current source. That is the point —
 * it locks in row stability now so a future change that adds a
 * conditional control without reserving its slot fails CI here
 * instead of regressing the user-facing list.
 *
 * Runs at desktop (1280px) and mobile (390px) viewports. Unlike the
 * Amex page (which renders separate desktop/mobile DOM trees with
 * `md:hidden` / `hidden md:block`), the Chase row is a single DOM
 * node that re-flows responsively (`flex-col md:flex-row`), so the
 * row testid (`row-tx-${id}`) is the same on both viewports.
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

const MAX_DRIFT_PX = 1;

async function rowTop(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate(
    (el) => el.getBoundingClientRect().top + window.scrollY,
  );
}

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.describe("Chase row stability under bucket-bubble toggle (#639)", () => {
  for (const vp of VIEWPORTS) {
    test.describe(vp.name, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      test(`toggling WK on/off keeps sibling rows in place`, async ({
        page,
      }) => {
        const { email, password } = await createTestUser(
          `chase-bubble-stability-639-${vp.name}`,
          provisionedUserIds,
        );

        await signInAndOpen(page, email, password, "/transactions");
        await expect(
          page.getByRole("heading", { name: /^chase$/i }),
        ).toBeVisible({ timeout: 15_000 });

        // Seed five Chase rows on the same date so they land in the
        // same DayGroup. Within-day order is `compareNewestFirst`
        // (occurredOn, then occurredAt, then id) — NOT amount — so
        // we cannot pre-pick the target. Five gives plenty of room
        // even if the target lands near the bottom of the seeded set.
        const today = todayIso();
        const suffix = Math.random().toString(36).slice(2, 8);
        const seedDesc = (i: number) => `CHASE STABILITY ${suffix} R${i}`;

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
              source: "chase",
              categoryId: null,
              reviewed: false,
            },
          );
          seededIds.push(row.id);
        }

        await page.goto("/transactions");
        for (const id of seededIds) {
          await expect(page.getByTestId(`row-tx-${id}`)).toBeVisible({
            timeout: 20_000,
          });
        }

        await page.evaluate(() => window.scrollTo(0, 0));

        const tops: Array<{ id: string; top: number }> = [];
        for (const id of seededIds) {
          tops.push({ id, top: await rowTop(page, `row-tx-${id}`) });
        }
        tops.sort((a, b) => a.top - b.top);

        const targetId = tops[0].id;
        const sibling1Id = tops[1].id;
        const sibling2Id = tops[2].id;

        const targetTr = page.getByTestId(`row-tx-${targetId}`);
        const sibling1Tr = page.getByTestId(`row-tx-${sibling1Id}`);
        const sibling2Tr = page.getByTestId(`row-tx-${sibling2Id}`);

        const targetTopInitial = await rowTop(page, `row-tx-${targetId}`);
        expect(tops[1].top).toBeGreaterThan(targetTopInitial);
        expect(tops[2].top).toBeGreaterThan(targetTopInitial);

        await expect(targetTr).toBeVisible();
        await expect(sibling1Tr).toBeVisible();
        await expect(sibling2Tr).toBeVisible();

        const sibling1TopBefore = await rowTop(page, `row-tx-${sibling1Id}`);
        const sibling2TopBefore = await rowTop(page, `row-tx-${sibling2Id}`);

        // --- Toggle WK ON on the target row ---
        const wkButton = targetTr.getByRole("button", {
          name: /weekly bucket/i,
        });
        await expect(wkButton).toBeVisible();
        await wkButton.dispatchEvent("click");

        await expect(wkButton).toHaveAttribute("aria-pressed", "true", {
          timeout: 10_000,
        });

        const sibling1TopAfterOn = await rowTop(page, `row-tx-${sibling1Id}`);
        const sibling2TopAfterOn = await rowTop(page, `row-tx-${sibling2Id}`);

        expect(
          Math.abs(sibling1TopAfterOn - sibling1TopBefore),
        ).toBeLessThanOrEqual(MAX_DRIFT_PX);
        expect(
          Math.abs(sibling2TopAfterOn - sibling2TopBefore),
        ).toBeLessThanOrEqual(MAX_DRIFT_PX);

        // --- Toggle WK back OFF on the target row ---
        await wkButton.dispatchEvent("click");
        await expect(wkButton).toHaveAttribute("aria-pressed", "false", {
          timeout: 10_000,
        });

        const sibling1TopAfterOff = await rowTop(page, `row-tx-${sibling1Id}`);
        const sibling2TopAfterOff = await rowTop(page, `row-tx-${sibling2Id}`);

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
