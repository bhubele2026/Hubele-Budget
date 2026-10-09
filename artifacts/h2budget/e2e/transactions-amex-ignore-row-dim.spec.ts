import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #629:
 *
 * Rows whose category is the system-managed "Ignore" get a purely
 * visual dim treatment (`opacity-50`) on the Transactions page and on
 * the Amex page (both layouts). The dim is gated on
 * `data-ignored="true"` and is independent of the WK/MO/UN/RE bubble
 * state, so toggling a bubble afterwards must not cancel it. Switching
 * the row back to a non-Ignore category restores full opacity and
 * `data-ignored="false"`.
 *
 * (C9 repair) The Chase rows are the shared account-page row now: the
 * category is the row's `CategoryPicker` (`button-category-picker`, its
 * options in a command list), not the old inline badge
 * (`badge-category-*`), and the dim is `opacity-50`, not
 * `opacity-60 bg-muted/20`. A Chase row ALSO dims when it is in the
 * forecast (CH-37), and a posted checking row always is — so the Chase
 * case seeds a row dated TOMORROW (unflagged, so not in the forecast)
 * to see the Ignore dim on its own.
 *
 * The behavior was previously verified only by inspection — this
 * spec locks it in.
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

function thisMonthStart(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** A day on the HOUSEHOLD calendar (America/Chicago), `offset` days from today. */
function householdIso(offset = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + offset)).toISOString().slice(0, 10);
}

type Category = { id: string; name: string };

async function fetchCategories(page: Page): Promise<Category[]> {
  // Hitting GET /api/budget/categories lazy-seeds the system-managed
  // "Ignore" row (server-side `ensureIgnoreCategory`), so subsequent
  // reads see it in the list.
  return apiCall<Category[]>(page, "GET", "/api/budget/categories");
}

test.describe("Ignore'd row dimming (#629)", () => {
  test("Transactions page: picking Ignore dims the row, WK bubble doesn't undo the dim, restoring the category clears it", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "txn-ignore-dim-629",
      provisionedUserIds,
    );

    // Tomorrow, on the household calendar, and the month it falls in: the
    // Month view lists a day after today (labelled, never totalled).
    const tomorrow = householdIso(1);
    const monthStart = `${tomorrow.slice(0, 7)}-01`;
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Lazy-seed Ignore + grab its id.
    const cats = await fetchCategories(page);
    const ignoreCat = cats.find((c) => c.name === "Ignore");
    expect(ignoreCat, "Ignore should be lazy-seeded").toBeTruthy();

    // A real (non-system) category to start the row on, and a second one to
    // restore it to after Ignore.
    const suffix = Math.random().toString(36).slice(2, 8);
    const groceriesName = `Groceries629-${suffix}`;
    const diningName = `Dining629-${suffix}`;
    const groceries = await apiCall<Category>(
      page,
      "POST",
      "/api/budget/categories",
      { name: groceriesName, kind: "expense", groupName: "Food" },
    );
    const dining = await apiCall<Category>(
      page,
      "POST",
      "/api/budget/categories",
      { name: diningName, kind: "expense", groupName: "Food" },
    );

    // Dated tomorrow and not flagged: not in the forecast, so not dimmed for
    // that reason (a posted checking row always is — CH-37).
    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: tomorrow,
        description: `IGNORE-DIM-${suffix.toUpperCase()} MARKET`,
        amount: "-12.34",
        categoryId: groceries.id,
        forecastFlag: false,
      },
    );

    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.getByTestId(`row-tx-${txn.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Baseline: not ignored, not in the forecast, no dim.
    await expect(row).toHaveAttribute("data-ignored", "false");
    await expect(row).toHaveAttribute("data-sent", "false");
    await expect(row).not.toHaveClass(/opacity-50/);

    const isPatch = (req: { method: () => string; url: () => string }) =>
      req.method() === "PATCH" &&
      new URL(req.url()).pathname === `/api/transactions/${txn.id}`;

    // --- Pick Ignore through the row's category picker.
    {
      const reqP = page.waitForRequest(isPatch, { timeout: 10_000 });
      await row.getByTestId("button-category-picker").click();
      await page.getByTestId("option-ignore").click();
      const req = await reqP;
      const sent = JSON.parse(req.postData() ?? "{}") as Record<
        string,
        unknown
      >;
      expect(sent.categoryId).toBe(ignoreCat!.id);
    }

    // The row picks up data-ignored + the dim.
    await expect(row).toHaveAttribute("data-ignored", "true", {
      timeout: 10_000,
    });
    await expect(row).toHaveClass(/opacity-50/);

    // --- Toggling a WK bubble must not undo the dim. Bubble is a
    // button labeled "Weekly bucket" (BucketBubbles' `title` prop).
    {
      const reqP = page.waitForRequest(isPatch, { timeout: 10_000 });
      await row.getByRole("button", { name: /weekly bucket/i }).click();
      const req = await reqP;
      const sent = JSON.parse(req.postData() ?? "{}") as Record<
        string,
        unknown
      >;
      expect(sent.weeklyAllowance).toBe(true);
    }
    await expect(row).toHaveAttribute("data-ignored", "true");
    await expect(row).toHaveClass(/opacity-50/);

    // --- Restoring to a non-Ignore category clears the dim.
    {
      const reqP = page.waitForRequest(isPatch, { timeout: 10_000 });
      await row.getByTestId("button-category-picker").click();
      await page.getByRole("option", { name: diningName }).click();
      const req = await reqP;
      const sent = JSON.parse(req.postData() ?? "{}") as Record<
        string,
        unknown
      >;
      expect(sent.categoryId).toBe(dining.id);
    }
    await expect(row).toHaveAttribute("data-ignored", "false", {
      timeout: 10_000,
    });
    await expect(row).not.toHaveClass(/opacity-50/);
  });

  test("Amex page (desktop + mobile): picking Ignore dims both row layouts, WK bubble doesn't undo the dim, restoring the category clears it", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-ignore-dim-629",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Neutralize sticky positioning on the Amex page. Its sticky
    // filter bar (z-30) and sticky day-group header overlay the row
    // when Playwright scrolls it into view on the 390px mobile
    // viewport, intercepting pointer events on the row's controls.
    // Strip `position: sticky` from every element that currently
    // has it so Playwright can click without scrolling controls
    // under an overlay. This affects only viewport stickiness, not
    // layout or the dim classes this spec asserts on.
    const killSticky = async () => {
      await page.evaluate(() => {
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>("*"),
        )) {
          if (getComputedStyle(el).position === "sticky") {
            el.style.position = "static";
          }
        }
      });
    };
    await killSticky();

    const cats = await fetchCategories(page);
    const ignoreCat = cats.find((c) => c.name === "Ignore");
    expect(ignoreCat, "Ignore should be lazy-seeded").toBeTruthy();

    const suffix = Math.random().toString(36).slice(2, 8);
    const otherCat = await apiCall<Category>(
      page,
      "POST",
      "/api/budget/categories",
      { name: `Misc629-${suffix}`, kind: "expense", groupName: "Other" },
    );

    const txn = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: todayIso(),
        description: `AMEX IGNORE-DIM ${suffix}`,
        amount: "9.99",
        source: "amex",
        categoryId: otherCat.id,
      },
    );

    const isPatch = (req: { method: () => string; url: () => string }) =>
      req.method() === "PATCH" &&
      new URL(req.url()).pathname === `/api/transactions/${txn.id}`;

    /**
     * Drives the dim assertions against whichever Amex layout
     * (`row-amex-${id}` desktop or `row-amex-mobile-${id}` mobile) is
     * visible at the current viewport. The picker (`CategoryPicker`)
     * uses the default `button-category-picker` testid; both layouts
     * may be in the DOM (`md:hidden` vs `hidden md:block`), so we
     * scope by row to disambiguate.
     */
    const exerciseLayout = async (rowTestId: string) => {
      const row = page.getByTestId(rowTestId);
      await expect(row).toBeVisible({ timeout: 15_000 });
      // Re-strip position:sticky — the day-group header that wraps
      // the row is created dynamically after a transaction is added,
      // so the initial pass-through can miss it.
      await killSticky();

      // Baseline: not Ignore-dimmed. We deliberately don't assert
      // `not.toHaveClass(/opacity-50/)` here — the Amex dim selector
      // is `(t.reviewed || isIgnored) && "opacity-50"`, so a row
      // that was already reviewed in a previous step (e.g. the
      // desktop pass's WK click) is dim independent of Ignore. The
      // `data-ignored` attribute is the unambiguous probe of the
      // Ignore branch this spec exercises.
      await expect(row).toHaveAttribute("data-ignored", "false");

      // --- Pick Ignore through the row's CategoryPicker.
      {
        const reqP = page.waitForRequest(isPatch, { timeout: 10_000 });
        await row.getByTestId("button-category-picker").click();
        await page.getByTestId("option-ignore").click();
        const req = await reqP;
        const sent = JSON.parse(req.postData() ?? "{}") as Record<
          string,
          unknown
        >;
        expect(sent.categoryId).toBe(ignoreCat!.id);
      }
      await expect(row).toHaveAttribute("data-ignored", "true", {
        timeout: 10_000,
      });
      await expect(row).toHaveClass(/opacity-50/);

      // --- WK bubble doesn't cancel the dim.
      {
        const reqP = page.waitForRequest(isPatch, { timeout: 10_000 });
        await row.getByRole("button", { name: /weekly bucket/i }).click();
        await reqP;
      }
      await expect(row).toHaveAttribute("data-ignored", "true");
      await expect(row).toHaveClass(/opacity-50/);

      // --- Restore to the non-Ignore category clears the dim.
      {
        const reqP = page.waitForRequest(isPatch, { timeout: 10_000 });
        await row.getByTestId("button-category-picker").click();
        // The user-pickable category names appear as command items —
        // pick by visible text since the picker doesn't expose
        // per-category testids.
        await page.getByRole("option", { name: otherCat.name }).click();
        const req = await reqP;
        const sent = JSON.parse(req.postData() ?? "{}") as Record<
          string,
          unknown
        >;
        expect(sent.categoryId).toBe(otherCat.id);
      }
      await expect(row).toHaveAttribute("data-ignored", "false", {
        timeout: 10_000,
      });
      // NB: we don't assert `not.toHaveClass(/opacity-50/)` here —
      // the WK click above also flipped `reviewed:true` via Amex's
      // auto-review (`setRowBucket`), and the row's dim selector
      // (`(t.reviewed || isIgnored) && "opacity-50"`) keeps the
      // class on while reviewed stays on. The point of this assertion
      // is that the Ignore-driven half of that selector cleared,
      // which is what `data-ignored="false"` proves.
    };

    // Reload once so the freshly-seeded row lands in the page's
    // react-query cache. The Amex page renders both layouts in the
    // DOM and toggles their visibility via Tailwind's `md:hidden` /
    // `hidden md:block` classes — switching viewports flips which
    // layout is visible without needing a re-navigation, which keeps
    // the Clerk session intact and avoids re-sync flakiness.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Desktop layout (≥md → table row).
    await exerciseLayout(`row-amex-${txn.id}`);

    // --- Mobile layout (<md → stacked card row).
    await page.setViewportSize({ width: 390, height: 844 });
    await exerciseLayout(`row-amex-mobile-${txn.id}`);
  });
});
