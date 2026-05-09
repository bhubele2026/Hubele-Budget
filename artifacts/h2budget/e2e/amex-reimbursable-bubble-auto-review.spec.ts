import { test, expect, type Page, type Request } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #617 — the Reimbursable (RE) bucket
 * bubble on the Amex page is the auto-review surface added in #616.
 * The behavior is already pinned by a vitest component test
 * (`amexPageBucketAutoReview.test.tsx`), but that test mocks
 * `<BucketBubbles>` and the network layer entirely. This spec
 * exercises the real bubble UI, the real PATCH /transactions/:id
 * request, and the row's `data-reviewed` attribute under real
 * conditions, so a regression in any of those layers (the bubble's
 * `aria-pressed` plumbing, the network shape produced by
 * `setRowReimbursable`, or the optimistic cache update that drives
 * the row styling) trips the test.
 *
 * The three scenarios mirror the auto-review branches in
 * `setRowReimbursable`:
 *   1) RE on  -> single PATCH with `reimbursable:true` AND
 *      `reviewed:true`; row gains `data-reviewed="true"`.
 *   2) RE off (no other bucket active) -> single PATCH with
 *      `reimbursable:false`, `reimbursed:false`, AND `reviewed:false`;
 *      row drops to `data-reviewed="false"`.
 *   3) RE off on a row that still has WK active -> single PATCH with
 *      `reimbursable:false`, `reimbursed:false`, and NO `reviewed`
 *      key (WK keeps carrying the reviewed signal); row stays
 *      `data-reviewed="true"`.
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

function isPatchFor(req: Request, txnId: string): boolean {
  if (req.method() !== "PATCH") return false;
  const path = new URL(req.url()).pathname;
  return path === `/api/transactions/${txnId}`;
}

test.describe("Amex Reimbursable bubble auto-review (#617)", () => {
  test("clicking RE on/off drives data-reviewed and the right reviewed key in the PATCH", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-re-bubble-auto-review-617",
      provisionedUserIds,
    );

    // Sign in first so the Clerk session cookie is in place before
    // any /api/* seeding calls. We reload after seeding.
    await signInAndOpen(page, email, password, "/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    const today = todayIso();
    const suffix = Math.random().toString(36).slice(2, 8);

    // Three rows, one per scenario, with distinct descriptions so
    // failure messages are easy to read:
    //   - CLEAN: starts unreviewed, no bucket flags. Toggle RE ON.
    //   - RE-ONLY: pre-seeded reimbursable=true, reviewed=true.
    //     Toggle RE OFF — no other bucket carries reviewed, so the
    //     PATCH must clear reviewed too.
    //   - RE+WK: pre-seeded with both reimbursable=true AND weekly
    //     allowance on (with a weeklyBucket so it's a complete WK
    //     row). Toggle RE OFF — WK keeps carrying reviewed, so the
    //     PATCH must NOT include reviewed.
    const cleanDesc = `AMEX RE BUBBLE ${suffix} — CLEAN`;
    const reOnlyDesc = `AMEX RE BUBBLE ${suffix} — RE ONLY`;
    const reAndWkDesc = `AMEX RE BUBBLE ${suffix} — RE+WK`;

    const cleanRow = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: today,
        description: cleanDesc,
        amount: "11.00",
        source: "amex",
        categoryId: null,
        reviewed: false,
      },
    );
    const reOnlySeed = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: today,
        description: reOnlyDesc,
        amount: "22.00",
        source: "amex",
        categoryId: null,
        reimbursable: true,
        reviewed: true,
      },
    );
    const reAndWkSeed = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: today,
        description: reAndWkDesc,
        amount: "33.00",
        source: "amex",
        categoryId: null,
        reimbursable: true,
        weeklyAllowance: true,
        weeklyBucket: "misc",
        reviewed: true,
      },
    );

    await page.goto("/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Playwright's default 1280px viewport renders the desktop
    // table layout, where each row's `<tr>` is the `row-amex-${id}`
    // element carrying `data-reviewed`. Only one `<BucketBubbles>`
    // renders inside that row, so scoping by the row testid yields
    // a unique Reimbursable button.
    const cleanTr = page.getByTestId(`row-amex-${cleanRow.id}`);
    const reOnlyTr = page.getByTestId(`row-amex-${reOnlySeed.id}`);
    const reAndWkTr = page.getByTestId(`row-amex-${reAndWkSeed.id}`);
    await expect(cleanTr).toBeVisible({ timeout: 15_000 });
    await expect(reOnlyTr).toBeVisible();
    await expect(reAndWkTr).toBeVisible();

    // Baselines that make each scenario's flip observable.
    await expect(cleanTr).toHaveAttribute("data-reviewed", "false");
    await expect(reOnlyTr).toHaveAttribute("data-reviewed", "true");
    await expect(reAndWkTr).toHaveAttribute("data-reviewed", "true");

    // --- Scenario 1: click RE on a clean row.
    {
      const reqPromise = page.waitForRequest(
        (req) => isPatchFor(req, cleanRow.id),
        { timeout: 10_000 },
      );
      const resPromise = page.waitForResponse(
        (res) => isPatchFor(res.request(), cleanRow.id),
        { timeout: 10_000 },
      );

      await cleanTr
        .getByRole("button", { name: /reimbursable/i })
        .click();

      const req = await reqPromise;
      const res = await resPromise;
      expect(res.status()).toBe(200);
      const sent = JSON.parse(req.postData() ?? "{}") as Record<
        string,
        unknown
      >;
      // The single PATCH carries BOTH the bucket flip AND the
      // auto-review side-effect. `reimbursed` is intentionally not
      // in the next=true branch (only the "off" branch clears it).
      expect(sent.reimbursable).toBe(true);
      expect(sent.reviewed).toBe(true);

      // The optimistic cache update flips `data-reviewed` without a
      // reload — this also pins the opacity-50 styling path.
      await expect(cleanTr).toHaveAttribute("data-reviewed", "true", {
        timeout: 10_000,
      });
    }

    // --- Scenario 2: click RE off on a row with no other bucket.
    {
      const reqPromise = page.waitForRequest(
        (req) => isPatchFor(req, reOnlySeed.id),
        { timeout: 10_000 },
      );
      const resPromise = page.waitForResponse(
        (res) => isPatchFor(res.request(), reOnlySeed.id),
        { timeout: 10_000 },
      );

      await reOnlyTr
        .getByRole("button", { name: /reimbursable/i })
        .click();

      const req = await reqPromise;
      const res = await resPromise;
      expect(res.status()).toBe(200);
      const sent = JSON.parse(req.postData() ?? "{}") as Record<
        string,
        unknown
      >;
      // RE off with no other bucket: clear reimbursable, clear the
      // paired reimbursed flag, AND clear reviewed (no other bucket
      // is carrying the reviewed signal).
      expect(sent.reimbursable).toBe(false);
      expect(sent.reimbursed).toBe(false);
      expect(sent.reviewed).toBe(false);

      await expect(reOnlyTr).toHaveAttribute("data-reviewed", "false", {
        timeout: 10_000,
      });
    }

    // --- Scenario 3: click RE off on a row that still has WK on.
    {
      const reqPromise = page.waitForRequest(
        (req) => isPatchFor(req, reAndWkSeed.id),
        { timeout: 10_000 },
      );
      const resPromise = page.waitForResponse(
        (res) => isPatchFor(res.request(), reAndWkSeed.id),
        { timeout: 10_000 },
      );

      await reAndWkTr
        .getByRole("button", { name: /reimbursable/i })
        .click();

      const req = await reqPromise;
      const res = await resPromise;
      expect(res.status()).toBe(200);
      const sent = JSON.parse(req.postData() ?? "{}") as Record<
        string,
        unknown
      >;
      // RE off with WK still active: clear reimbursable + reimbursed
      // but DO NOT touch reviewed — WK keeps carrying the reviewed
      // signal independently. Pinning the absence of the key (not
      // just `reviewed: true`) is the whole point of the third
      // branch in setRowReimbursable.
      expect(sent.reimbursable).toBe(false);
      expect(sent.reimbursed).toBe(false);
      expect("reviewed" in sent).toBe(false);

      // The row stays reviewed because WK is still on. Use a short
      // poll window to give the optimistic update a chance to run
      // and confirm it doesn't drop the attribute.
      await expect(reAndWkTr).toHaveAttribute("data-reviewed", "true", {
        timeout: 5_000,
      });
    }
  });
});
