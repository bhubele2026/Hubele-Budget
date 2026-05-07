import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #488 (tap-to-jump from the dashboard's
 * Unplanned spending recent list).
 *
 * Each row in MonthlyLikeSection's Unplanned bucket renders as a Link to
 * `/transactions?tx=<id>&month=<YYYY-MM-01>`. The Transactions page reads
 * `?tx=` on mount, scrolls the matching `[data-testid="row-tx-<id>"]`
 * into view, pulses a `ring-2 ring-amber-500` highlight, then strips the
 * `tx` param from the URL so a reload doesn't re-pulse the highlight.
 *
 * Without this spec a future refactor of either the dashboard row testid
 * (`row-unplanned-<id>`) or the Transactions page's `?tx=` handling /
 * row testid (`row-tx-<id>`) could silently break the deep-link.
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

function currentMonthStartISO(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

test.describe("Dashboard Unplanned row tap-to-jump (#488)", () => {
  test("clicking a row in the Unplanned recent list navigates to the matching Transactions row with a pulse highlight", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "dashboard-unplanned-jump-488",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/");

    // Wait for the dashboard payload to resolve — "Life spending" is the
    // stable anchor that renders after loading completes.
    await expect(
      page.getByRole("heading", { name: /^life spending$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Pre-pin the dashboard's per-source filter chip selection (#278) to
    // "manual" so our seeded manual unplanned row passes the chip gate
    // (otherwise the default selection — `["amex"]` — would hide it).
    // We pick `manual` over `amex` because `manual` is also a Chase
    // fallback source (`isChaseFallbackSource("manual") === true`), so
    // the same seeded row will show up on the Transactions page (which
    // scopes to chase txns) for the post-click assertions.
    await page.evaluate(() => {
      window.localStorage.setItem(
        "h2budget:dashboardSelectedSources",
        JSON.stringify(["manual"]),
      );
    });

    // Seed an unplanned txn for the current month. `unplannedAllowance:
    // true` is the manual-tag path that lands the row in the dashboard's
    // Unplanned recent list (MonthlyLikeSection filters on this flag).
    const suffix = Math.random().toString(36).slice(2, 8);
    const unplanned = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: currentMonthDay(5),
        description: `UNPLANNED-JUMP-${suffix}`,
        amount: "-42.42",
        source: "manual",
        unplannedAllowance: true,
      },
    );

    // Reload so the dashboard query picks up the new unplanned row and
    // the chip-selection localStorage seed takes effect.
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /^life spending$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const dashRow = page.getByTestId(`row-unplanned-${unplanned.id}`);
    await expect(dashRow).toBeVisible({ timeout: 10_000 });
    await expect(dashRow).toContainText(`UNPLANNED-JUMP-${suffix}`);

    // The row is an <a> Link — verify the deep-link href shape (#488)
    // before we click, so a refactor that strips `?tx=` or `?month=`
    // from the href fails this spec independently of the timing-sensitive
    // post-navigation assertions below.
    const monthISO = currentMonthStartISO();
    await expect(dashRow).toHaveAttribute(
      "href",
      `/transactions?tx=${encodeURIComponent(unplanned.id)}&month=${monthISO}`,
    );

    await dashRow.click();

    // After the focus effect runs, the Transactions page strips `?tx=`
    // from the URL but keeps `?month=`. Either intermediate state is
    // acceptable depending on timing; assert we land on /transactions
    // with at least the month param preserved.
    await page.waitForURL(/\/transactions(\?|$)/, { timeout: 10_000 });
    await expect
      .poll(() => new URL(page.url()).searchParams.get("month"), {
        timeout: 10_000,
      })
      .toBe(monthISO);

    // The matching Transactions row must be mounted, scrolled into view,
    // and carry the pulse-highlight ring (ring-2 ring-amber-500). The
    // highlight is cleared after ~2s, so we capture the class before it
    // fades.
    const txRow = page.getByTestId(`row-tx-${unplanned.id}`);
    await expect(txRow).toBeVisible({ timeout: 10_000 });
    await expect(txRow).toHaveClass(/ring-amber-500/);
    await expect(txRow).toContainText(`UNPLANNED-JUMP-${suffix}`);

    // Confirm the row is actually in the viewport (scrollIntoView fired),
    // not merely present in the DOM off-screen.
    const inViewport = await txRow.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      return r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
    });
    expect(inViewport).toBe(true);

    // After the pulse window closes, the `?tx=` param should be gone so
    // a reload doesn't re-trigger the highlight.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("tx"), {
        timeout: 10_000,
      })
      .toBeNull();
  });
});
