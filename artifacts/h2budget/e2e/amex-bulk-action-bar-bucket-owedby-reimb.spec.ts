import { test, expect, type Page, type Request } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #592 — the remaining Amex bulk action
 * verbs that #531 didn't pin: Bucket, Owed by, and Reimbursable.
 *
 * Why it matters:
 *   - Bucket is the only verb that exercises `runBulkPatch`'s
 *     patch-grouping path. `bulkSetBucket("weekly", …)` derives a
 *     per-row `weeklyBucket` from each row's category, so selecting
 *     rows whose categories resolve to *different* default buckets
 *     fans the action out into one POST /transactions/bulk-update per
 *     derived `weeklyBucket` value (each with its own ids[]). A
 *     regression in the JSON-stringified patch grouping or per-group
 *     toast accounting would silently undercount or smear values
 *     across rows.
 *   - Owed by exercises the Enter-to-submit path on
 *     `input-bulk-owed-by` plus `button-bulk-clear-owed-by`, which
 *     is the only bulk verb whose user input comes from a free-text
 *     field rather than a button.
 *   - Reimbursable is the same single-group shape as Mark reviewed
 *     (#531) but flips a different column and the visible RE bubble.
 *
 * Mirrors `amex-bulk-action-bar.spec.ts` for setup/seed style.
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

function isBulkUpdateRequest(req: Request): boolean {
  return (
    req.method() === "POST" &&
    new URL(req.url()).pathname === "/api/transactions/bulk-update"
  );
}

test.describe("Amex bulk action bar — Bucket / Owed by / Reimbursable (#592)", () => {
  test("bulk Bucket fans into per-derived-bucket groups; bulk Owed by set+Clear and bulk Reimbursable Mark+Unmark each fire one bulk-update and update every row", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-bulk-bar-bucket-owedby-reimb-592",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    const suffix = Math.random().toString(36).slice(2, 8);

    // Two destination categories whose names hit different branches
    // of `defaultWeeklyBucketFor` on the page:
    //   "grocer"  → TransactionWeeklyBucket.groceries
    //   "dining"  → TransactionWeeklyBucket.dining
    // That difference is what forces `runBulkPatch` to produce *two*
    // groups (one POST /transactions/bulk-update per derived
    // `weeklyBucket`) for the bulk Bucket=Weekly action below.
    const groceriesCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: `BulkBar Grocer-${suffix}`, kind: "expense", groupName: "Other" },
    );
    const diningCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: `BulkBar Dining-${suffix}`, kind: "expense", groupName: "Other" },
    );

    // Three same-day Amex rows. A → groceries cat, B → dining cat,
    // C is the control and stays unselected so we can prove the bulk
    // verbs only touched the chosen ids.
    const today = todayIso();
    const seedSpecs = [
      {
        description: `AMEX BULK BAR2 ${suffix} — TARGET A (grocer)`,
        amount: "11.00",
        categoryId: groceriesCat.id,
      },
      {
        description: `AMEX BULK BAR2 ${suffix} — TARGET B (dining)`,
        amount: "22.00",
        categoryId: diningCat.id,
      },
      {
        description: `AMEX BULK BAR2 ${suffix} — CONTROL`,
        amount: "33.00",
        categoryId: null as string | null,
      },
    ];
    const seeded: { id: string; description: string }[] = [];
    for (const s of seedSpecs) {
      const row = await apiCall<{ id: string }>(
        page,
        "POST",
        "/api/transactions",
        {
          occurredOn: today,
          description: s.description,
          amount: s.amount,
          source: "amex",
          categoryId: s.categoryId,
          reviewed: false,
          // Seed buckets/owedBy/reimbursable in their default states
          // so each verb's "before → after" assertion is meaningful.
          weeklyAllowance: false,
          monthlyAllowance: false,
          unplannedAllowance: false,
          reimbursable: false,
          owedBy: null,
        },
      );
      seeded.push({ id: row.id, description: s.description });
    }
    const [targetA, targetB, control] = seeded;

    await page.goto("/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    const rowA = page.getByTestId(`row-amex-${targetA.id}`);
    const rowB = page.getByTestId(`row-amex-${targetB.id}`);
    const rowC = page.getByTestId(`row-amex-${control.id}`);
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await expect(rowB).toBeVisible();
    await expect(rowC).toBeVisible();

    // Row-scoped bubble locators. Each row renders one <BucketBubbles>,
    // so `aria-pressed` on the Weekly/Reimbursable buttons is unique
    // and reflects the row's flag at render time (see
    // `src/components/bucket-bubbles.tsx`).
    const weeklyBubble = (row: ReturnType<typeof page.getByTestId>) =>
      row.getByRole("button", { name: "Weekly bucket" });
    const reimbBubble = (row: ReturnType<typeof page.getByTestId>) =>
      row.getByRole("button", { name: "Reimbursable" });

    // Baselines: every seeded row starts with no bucket and not
    // reimbursable, which is what the assertions below flip.
    await expect(weeklyBubble(rowA)).toHaveAttribute("aria-pressed", "false");
    await expect(weeklyBubble(rowB)).toHaveAttribute("aria-pressed", "false");
    await expect(weeklyBubble(rowC)).toHaveAttribute("aria-pressed", "false");
    await expect(reimbBubble(rowA)).toHaveAttribute("aria-pressed", "false");
    await expect(reimbBubble(rowB)).toHaveAttribute("aria-pressed", "false");
    await expect(reimbBubble(rowC)).toHaveAttribute("aria-pressed", "false");

    // Select target A and target B; leave the control untouched.
    // bulkSetBucket / bulkSetOwedBy / bulkSetReimbursable do NOT
    // clear the selection on success (only bulkSetCategory does), so
    // a single selection survives all three verbs below.
    await rowA.getByRole("checkbox", { name: /select/i }).check();
    await rowB.getByRole("checkbox", { name: /select/i }).check();
    await expect(page.getByText("2 selected").first()).toBeVisible();

    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });

    // -----------------------------------------------------------------
    // Action 1: bulk Bucket = Weekly
    //
    // Both selected rows have categories, but the names resolve to
    // *different* default `weeklyBucket` values (groceries vs dining).
    // `runBulkPatch` groups by JSON-stringified patch, so we expect
    // exactly two POST /transactions/bulk-update requests, each
    // carrying one id and a different `weeklyBucket`. That's the only
    // place in the codebase that exercises the multi-group path.
    // -----------------------------------------------------------------
    const bucketRequests: Request[] = [];
    const onBucketRequest = (req: Request) => {
      if (isBulkUpdateRequest(req)) bucketRequests.push(req);
    };
    page.on("request", onBucketRequest);

    await page.getByRole("button", { name: /^Weekly$/ }).click();

    await expect(
      notifications.getByText(/Tagged 2 transactions/i),
    ).toBeVisible({ timeout: 10_000 });

    page.off("request", onBucketRequest);

    // Pin the grouping: more than one bulk-update fired, the union
    // of ids covers exactly the two selected rows, the patches all
    // set weeklyAllowance=true, and the per-group `weeklyBucket`
    // values are distinct (groceries vs dining).
    expect(bucketRequests.length).toBeGreaterThan(1);
    const bucketPayloads = bucketRequests.map(
      (r) =>
        JSON.parse(r.postData() ?? "{}") as {
          ids: string[];
          patch: {
            weeklyAllowance: boolean;
            monthlyAllowance: boolean;
            unplannedAllowance: boolean;
            weeklyBucket: string | null;
          };
        },
    );
    const sentIds = new Set(bucketPayloads.flatMap((p) => p.ids));
    expect(sentIds).toEqual(new Set([targetA.id, targetB.id]));
    for (const p of bucketPayloads) {
      expect(p.patch.weeklyAllowance).toBe(true);
      expect(p.patch.monthlyAllowance).toBe(false);
      expect(p.patch.unplannedAllowance).toBe(false);
    }
    const weeklyBucketsSent = new Set(
      bucketPayloads.map((p) => p.patch.weeklyBucket),
    );
    expect(weeklyBucketsSent.size).toBeGreaterThan(1);

    // Both affected rows visibly pick up the WK bubble without a
    // reload; the control row stays off.
    await expect(weeklyBubble(rowA)).toHaveAttribute("aria-pressed", "true", {
      timeout: 10_000,
    });
    await expect(weeklyBubble(rowB)).toHaveAttribute("aria-pressed", "true", {
      timeout: 10_000,
    });
    await expect(weeklyBubble(rowC)).toHaveAttribute("aria-pressed", "false");

    // -----------------------------------------------------------------
    // Action 2: bulk Owed by — set via Enter, then Clear via the button.
    //
    // The Enter handler on `input-bulk-owed-by` calls bulkSetOwedBy
    // with the typed value; `button-bulk-clear-owed-by` calls it with
    // "". Both ids share the same patch, so each step is exactly one
    // bulk-update request. The Amex page does not render owedBy in
    // the row markup, so we verify the post-state via GET
    // /api/transactions (the same endpoint the page reads).
    // -----------------------------------------------------------------
    const owedByValue = `Payer-${suffix}`;

    const owedSetReqPromise = page.waitForRequest(isBulkUpdateRequest, {
      timeout: 10_000,
    });
    const owedSetResPromise = page.waitForResponse(
      (res) => isBulkUpdateRequest(res.request()),
      { timeout: 10_000 },
    );

    const owedByInput = page.getByTestId("input-bulk-owed-by");
    await owedByInput.click();
    await owedByInput.fill(owedByValue);
    await owedByInput.press("Enter");

    const owedSetReq = await owedSetReqPromise;
    const owedSetRes = await owedSetResPromise;
    expect(owedSetRes.status()).toBe(200);
    const owedSetSent = JSON.parse(owedSetReq.postData() ?? "{}") as {
      ids: string[];
      patch: { owedBy: string | null };
    };
    expect(new Set(owedSetSent.ids)).toEqual(
      new Set([targetA.id, targetB.id]),
    );
    expect(owedSetSent.patch.owedBy).toBe(owedByValue);

    await expect(
      notifications.getByText(
        new RegExp(`Set owed by to ${owedByValue} on 2 transactions`, "i"),
      ),
    ).toBeVisible({ timeout: 10_000 });

    // Verify post-state through the same list endpoint the page reads
    // (the Amex row markup does not surface owedBy; the only source
    // of truth visible to the user is the data behind the page).
    const afterSet = await apiCall<
      { id: string; owedBy: string | null }[]
    >(page, "GET", `/api/transactions?source=amex&from=${today}&to=${today}`);
    const afterSetById = new Map(afterSet.map((r) => [r.id, r.owedBy]));
    expect(afterSetById.get(targetA.id)).toBe(owedByValue);
    expect(afterSetById.get(targetB.id)).toBe(owedByValue);
    expect(afterSetById.get(control.id) ?? null).toBeNull();

    // Now Clear. Re-assert the toast wording flips to "Cleared …".
    const owedClearReqPromise = page.waitForRequest(isBulkUpdateRequest, {
      timeout: 10_000,
    });
    const owedClearResPromise = page.waitForResponse(
      (res) => isBulkUpdateRequest(res.request()),
      { timeout: 10_000 },
    );
    await page.getByTestId("button-bulk-clear-owed-by").click();
    const owedClearReq = await owedClearReqPromise;
    const owedClearRes = await owedClearResPromise;
    expect(owedClearRes.status()).toBe(200);
    const owedClearSent = JSON.parse(owedClearReq.postData() ?? "{}") as {
      ids: string[];
      patch: { owedBy: string | null };
    };
    expect(new Set(owedClearSent.ids)).toEqual(
      new Set([targetA.id, targetB.id]),
    );
    expect(owedClearSent.patch.owedBy).toBeNull();

    await expect(
      notifications.getByText(/Cleared owed by on 2 transactions/i),
    ).toBeVisible({ timeout: 10_000 });

    const afterClear = await apiCall<
      { id: string; owedBy: string | null }[]
    >(page, "GET", `/api/transactions?source=amex&from=${today}&to=${today}`);
    const afterClearById = new Map(afterClear.map((r) => [r.id, r.owedBy]));
    expect(afterClearById.get(targetA.id) ?? null).toBeNull();
    expect(afterClearById.get(targetB.id) ?? null).toBeNull();

    // -----------------------------------------------------------------
    // Action 3: bulk Reimbursable Mark, then Unmark.
    //
    // Same single-group shape as Mark reviewed (#531) — one
    // bulk-update with both ids and `{ reimbursable }`. Pin the
    // visible RE bubble flips on then off so a styling regression
    // (the bubble is what the user actually sees, not just the
    // response payload) wouldn't ship silently.
    // -----------------------------------------------------------------
    const reimbMarkReqPromise = page.waitForRequest(isBulkUpdateRequest, {
      timeout: 10_000,
    });
    const reimbMarkResPromise = page.waitForResponse(
      (res) => isBulkUpdateRequest(res.request()),
      { timeout: 10_000 },
    );

    // Two "Mark" buttons live in the bulk bar (Reimb + Reviewed —
    // and the Reviewed one has a data-testid; the Reimb one doesn't).
    // Scope the click to the immediate parent of the "Reimb:" label,
    // which is the inline-flex div that wraps just the Mark/Unmark
    // pair for reimbursable.
    const reimbGroup = page
      .getByText("Reimb:", { exact: true })
      .locator("..");
    await reimbGroup.getByRole("button", { name: /^Mark$/ }).click();

    const reimbMarkReq = await reimbMarkReqPromise;
    const reimbMarkRes = await reimbMarkResPromise;
    expect(reimbMarkRes.status()).toBe(200);
    const reimbMarkSent = JSON.parse(reimbMarkReq.postData() ?? "{}") as {
      ids: string[];
      patch: { reimbursable: boolean };
    };
    expect(new Set(reimbMarkSent.ids)).toEqual(
      new Set([targetA.id, targetB.id]),
    );
    expect(reimbMarkSent.patch.reimbursable).toBe(true);

    await expect(
      notifications.getByText(/Marked 2 as reimbursable/i),
    ).toBeVisible({ timeout: 10_000 });

    await expect(reimbBubble(rowA)).toHaveAttribute("aria-pressed", "true", {
      timeout: 10_000,
    });
    await expect(reimbBubble(rowB)).toHaveAttribute("aria-pressed", "true", {
      timeout: 10_000,
    });
    await expect(reimbBubble(rowC)).toHaveAttribute("aria-pressed", "false");

    // Unmark — same shape, flips reimbursable=false and the bubble.
    const reimbUnmarkReqPromise = page.waitForRequest(isBulkUpdateRequest, {
      timeout: 10_000,
    });
    const reimbUnmarkResPromise = page.waitForResponse(
      (res) => isBulkUpdateRequest(res.request()),
      { timeout: 10_000 },
    );
    await reimbGroup.getByRole("button", { name: /^Unmark$/ }).click();
    const reimbUnmarkReq = await reimbUnmarkReqPromise;
    const reimbUnmarkRes = await reimbUnmarkResPromise;
    expect(reimbUnmarkRes.status()).toBe(200);
    const reimbUnmarkSent = JSON.parse(reimbUnmarkReq.postData() ?? "{}") as {
      ids: string[];
      patch: { reimbursable: boolean };
    };
    expect(new Set(reimbUnmarkSent.ids)).toEqual(
      new Set([targetA.id, targetB.id]),
    );
    expect(reimbUnmarkSent.patch.reimbursable).toBe(false);

    await expect(
      notifications.getByText(/Unmarked 2 as reimbursable/i),
    ).toBeVisible({ timeout: 10_000 });

    await expect(reimbBubble(rowA)).toHaveAttribute("aria-pressed", "false", {
      timeout: 10_000,
    });
    await expect(reimbBubble(rowB)).toHaveAttribute("aria-pressed", "false", {
      timeout: 10_000,
    });
  });
});
