import { test, expect, type Page, type Request } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #619 — the WK/MO/UN bucket bubbles
 * on the Amex page are the auto-review surface added in #615.
 * The behavior is already pinned by a vitest component test
 * (`amexPageBucketAutoReview.test.tsx`), but that test mocks
 * `<BucketBubbles>` and the network layer entirely. This spec
 * exercises the real bubble UI, the real PATCH /transactions/:id
 * request, and the row's `data-reviewed` attribute under real
 * conditions, so a regression in any of those layers (the bubble's
 * `aria-pressed` plumbing, the network shape produced by
 * `setRowBucket`, or the optimistic cache update that drives the
 * row styling) trips the test.
 *
 * Mirrors `amex-reimbursable-bubble-auto-review.spec.ts` (#617) but
 * for the three sibling buckets. Each bucket gets a pair of
 * scenarios that mirror the two branches in `setRowBucket`:
 *   1) Click bucket on a clean row -> single PATCH with
 *      `<bucket>Allowance:true` AND `reviewed:true`; row gains
 *      `data-reviewed="true"`.
 *   2) Click the currently-on bucket back off -> single PATCH with
 *      `<bucket>Allowance:false` AND `reviewed:false`; row drops to
 *      `data-reviewed="false"`.
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

type BucketSpec = {
  key: "weekly" | "monthly" | "unplanned";
  label: string;
  flagField:
    | "weeklyAllowance"
    | "monthlyAllowance"
    | "unplannedAllowance";
  // The button's accessible name comes from BucketBubbles' `title`
  // prop — see `bucket-bubbles.tsx`.
  buttonName: RegExp;
  // Pre-seed payload that flips this bucket on. WK additionally
  // needs a `weeklyBucket`; MO/UN don't.
  seedExtras: Record<string, unknown>;
};

const BUCKETS: BucketSpec[] = [
  {
    key: "weekly",
    label: "WK",
    flagField: "weeklyAllowance",
    buttonName: /weekly bucket/i,
    seedExtras: { weeklyAllowance: true, weeklyBucket: "misc" },
  },
  {
    key: "monthly",
    label: "MO",
    flagField: "monthlyAllowance",
    buttonName: /monthly bucket/i,
    seedExtras: { monthlyAllowance: true },
  },
  {
    key: "unplanned",
    label: "UN",
    flagField: "unplannedAllowance",
    buttonName: /unplanned bucket/i,
    seedExtras: { unplannedAllowance: true },
  },
];

test.describe("Amex WK/MO/UN bubble auto-review (#619)", () => {
  test("clicking WK/MO/UN on/off drives data-reviewed and the right bucket+reviewed keys in the PATCH", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-bucket-bubble-auto-review-619",
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

    // Two seeds per bucket — one clean row to flip ON, one already
    // carrying the bucket+reviewed to flip OFF. Distinct
    // descriptions and amounts so failures point at the right row.
    type SeedRefs = { cleanId: string; onId: string };
    const seeds: Record<BucketSpec["key"], SeedRefs> = {
      weekly: { cleanId: "", onId: "" },
      monthly: { cleanId: "", onId: "" },
      unplanned: { cleanId: "", onId: "" },
    };

    let amount = 11;
    for (const b of BUCKETS) {
      const cleanDesc = `AMEX ${b.label} BUBBLE ${suffix} — CLEAN`;
      const onDesc = `AMEX ${b.label} BUBBLE ${suffix} — ${b.label} ON`;
      const cleanRow = await apiCall<{ id: string }>(
        page,
        "POST",
        "/api/transactions",
        {
          occurredOn: today,
          description: cleanDesc,
          amount: `${amount++}.00`,
          source: "amex",
          categoryId: null,
          reviewed: false,
        },
      );
      const onRow = await apiCall<{ id: string }>(
        page,
        "POST",
        "/api/transactions",
        {
          occurredOn: today,
          description: onDesc,
          amount: `${amount++}.00`,
          source: "amex",
          categoryId: null,
          reviewed: true,
          ...b.seedExtras,
        },
      );
      seeds[b.key] = { cleanId: cleanRow.id, onId: onRow.id };
    }

    await page.goto("/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    for (const b of BUCKETS) {
      const { cleanId, onId } = seeds[b.key];

      // Playwright's default 1280px viewport renders the desktop
      // table layout, where each row's `<tr>` is the
      // `row-amex-${id}` element carrying `data-reviewed`. Only one
      // `<BucketBubbles>` renders inside that row, so scoping by
      // the row testid yields a unique button per bucket label.
      const cleanTr = page.getByTestId(`row-amex-${cleanId}`);
      const onTr = page.getByTestId(`row-amex-${onId}`);
      await expect(cleanTr).toBeVisible({ timeout: 15_000 });
      await expect(onTr).toBeVisible();

      // Baselines that make each scenario's flip observable.
      await expect(cleanTr).toHaveAttribute("data-reviewed", "false");
      await expect(onTr).toHaveAttribute("data-reviewed", "true");

      // --- Scenario A: click bucket ON for a clean row.
      {
        const reqPromise = page.waitForRequest(
          (req) => isPatchFor(req, cleanId),
          { timeout: 10_000 },
        );
        const resPromise = page.waitForResponse(
          (res) => isPatchFor(res.request(), cleanId),
          { timeout: 10_000 },
        );

        await cleanTr
          .getByRole("button", { name: b.buttonName })
          .click();

        const req = await reqPromise;
        const res = await resPromise;
        expect(res.status()).toBe(200);
        const sent = JSON.parse(req.postData() ?? "{}") as Record<
          string,
          unknown
        >;
        // Single PATCH carries the bucket flip AND the auto-review
        // side-effect. Sibling bucket fields are explicitly false
        // because `setRowBucket` always rewrites all three.
        expect(sent[b.flagField]).toBe(true);
        for (const other of BUCKETS) {
          if (other.key === b.key) continue;
          expect(sent[other.flagField]).toBe(false);
        }
        expect(sent.reviewed).toBe(true);

        await expect(cleanTr).toHaveAttribute("data-reviewed", "true", {
          timeout: 10_000,
        });
      }

      // --- Scenario B: click the currently-on bucket OFF.
      {
        const reqPromise = page.waitForRequest(
          (req) => isPatchFor(req, onId),
          { timeout: 10_000 },
        );
        const resPromise = page.waitForResponse(
          (res) => isPatchFor(res.request(), onId),
          { timeout: 10_000 },
        );

        await onTr.getByRole("button", { name: b.buttonName }).click();

        const req = await reqPromise;
        const res = await resPromise;
        expect(res.status()).toBe(200);
        const sent = JSON.parse(req.postData() ?? "{}") as Record<
          string,
          unknown
        >;
        // Bucket off via setRowBucket(t, "") clears all three bucket
        // flags AND the reviewed signal — no other bucket is left
        // active, so the row drops back to unreviewed.
        for (const other of BUCKETS) {
          expect(sent[other.flagField]).toBe(false);
        }
        expect(sent.reviewed).toBe(false);

        await expect(onTr).toHaveAttribute("data-reviewed", "false", {
          timeout: 10_000,
        });
      }
    }
  });
});
