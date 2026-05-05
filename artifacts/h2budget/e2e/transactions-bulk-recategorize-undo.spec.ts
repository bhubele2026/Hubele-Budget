import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #191 (the Undo button added in task #188 /
 * #199 to the bulk-recategorize success toast on the Transactions page).
 *
 * The repointed-rule flow already has a sibling spec
 * (`transactions-bulk-recategorize-preview.spec.ts`) that exercises the
 * "Show matches" preview-dialog Apply path and verifies the Undo POST via
 * the network/API. This spec covers the *other* entry point — clicking the
 * `action-apply-rule-past` action directly on the prompt toast (no preview
 * dialog) — and explicitly asserts the affected rows visually snap back to
 * their original category badge in the UI after Undo, which is what
 * regresses if the React Query invalidations or toast wiring break.
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
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Transactions bulk re-categorize Undo (#191)", () => {
  test("clicking Apply on the toast then Undo flips the affected rows back to their original category badge", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-bulk-recat-undo-191",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    const monthStart = thisMonthStart();
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );

    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Seed the same shape used in the preview-spec sibling: two historical
    // rows already in `miscCat` matched by a specific (≥2-token) mapping
    // rule, plus one uncategorized trigger row. Picking `debtCat` on the
    // trigger repoints the rule and surfaces the bulk-recategorize prompt
    // with candidateCount = 2.
    const suffix = Math.random().toString(36).slice(2, 8);
    const miscName = `MiscBuf-${suffix}`;
    const debtName = `AmexDelta-${suffix}`;

    const miscCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: miscName, kind: "expense", groupName: "Other" },
    );
    const debtCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: debtName, kind: "expense", groupName: "Debt" },
    );

    const pattern = `E2EAMEX UNDO-${suffix.toUpperCase()}`;
    await apiCall<{ id: string }>(page, "POST", "/api/mapping-rules", {
      pattern,
      matchType: "contains",
      categoryId: miscCat.id,
      priority: 50,
    });

    const hist1 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-3),
        description: `${pattern} PMT XXXX2001`,
        amount: "-150.00",
        categoryId: miscCat.id,
      },
    );
    const hist2 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-2),
        description: `${pattern} PMT XXXX2002`,
        amount: "-150.00",
        categoryId: miscCat.id,
      },
    );
    const trigger = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-1),
        description: `${pattern} PMT TRIGGER`,
        amount: "-150.00",
        // Force the trigger uncategorized so the CategorizeChip renders;
        // omitting `categoryId` would let the server's auto-categorize
        // pipeline pre-assign it via the mapping rule we just made.
        categoryId: null,
      },
    );

    // Reload so the page picks up the seeded rows in its initial query.
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const triggerRow = page.getByTestId(`row-tx-${trigger.id}`);
    const hist1Row = page.getByTestId(`row-tx-${hist1.id}`);
    const hist2Row = page.getByTestId(`row-tx-${hist2.id}`);
    await expect(triggerRow).toBeVisible({ timeout: 15_000 });
    await expect(hist1Row).toBeVisible();
    await expect(hist2Row).toBeVisible();

    // Sanity: both historical rows render the miscCat badge before we do
    // anything (they were seeded into miscCat).
    await expect(hist1Row.getByText(miscName, { exact: true })).toBeVisible();
    await expect(hist2Row.getByText(miscName, { exact: true })).toBeVisible();

    // --- Quick-categorize the trigger onto the new debt category. The
    // PATCH that fires from this click drives the auto-relearn flow that
    // repoints the seeded rule and reports candidateCount = 2.
    await triggerRow
      .getByTestId(`badge-uncategorized-${trigger.id}`)
      .click();

    const picker = page.getByPlaceholder(/search category/i);
    await expect(picker).toBeVisible();
    await picker.fill(debtName);
    await page.getByRole("option", { name: debtName }).first().click();

    // --- The follow-up prompt toast surfaces with copy + the
    // `action-apply-rule-past` button. Scope under the Notifications
    // region to avoid Radix's sr-only aria-live mirror span.
    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    await expect(
      notifications.getByText(`Move 2 past payments into ${debtName}?`),
    ).toBeVisible({ timeout: 10_000 });

    // Click Apply directly on the toast (the path NOT covered by the
    // preview-dialog sibling spec). The success toast that follows is
    // what carries the Undo button under test.
    const applyAction = page.getByTestId("action-apply-rule-past");
    await expect(applyAction).toBeVisible();

    const applyRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );
    const applyResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );
    await applyAction.click();
    const applyReq = await applyRequestPromise;
    const applyRes = await applyResponsePromise;
    expect(applyRes.status()).toBe(200);
    const applySent = JSON.parse(applyReq.postData() ?? "{}");
    expect(applySent.pattern).toBe(pattern);
    expect(applySent.matchType).toBe("contains");
    expect(applySent.fromCategoryId).toBe(miscCat.id);
    expect(applySent.toCategoryId).toBe(debtCat.id);

    // Success toast appears + the rows visually flip to the debt
    // category. We block on the badge update (not just the toast) so the
    // React Query invalidations have actually landed before we hit Undo.
    await expect(
      notifications.getByText(/Re-categorized 2 past transaction/i),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      hist1Row.getByText(debtName, { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      hist2Row.getByText(debtName, { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    // The original miscCat badge is gone from those rows.
    await expect(hist1Row.getByText(miscName, { exact: true })).toHaveCount(0);
    await expect(hist2Row.getByText(miscName, { exact: true })).toHaveCount(0);

    // --- Click Undo and assert the rows snap back to their original
    // miscCat badge. This is the regression that breaks if the toast
    // wiring or the React Query invalidations on the swapped POST
    // response stop firing.
    const undoAction = page.getByTestId("action-undo-bulk-recategorize");
    await expect(undoAction).toBeVisible({ timeout: 5_000 });

    const undoRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );
    const undoResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );
    await undoAction.click();
    const undoReq = await undoRequestPromise;
    const undoRes = await undoResponsePromise;
    expect(undoRes.status()).toBe(200);
    // The Undo POST mirrors the Apply POST with from/to swapped, the
    // affected ids whitelisted, and the originating rule's id passed
    // through so the server can also re-point it back.
    const undoSent = JSON.parse(undoReq.postData() ?? "{}");
    expect(undoSent.pattern).toBe(pattern);
    expect(undoSent.matchType).toBe("contains");
    expect(undoSent.fromCategoryId).toBe(debtCat.id);
    expect(undoSent.toCategoryId).toBe(miscCat.id);
    expect(typeof undoSent.ruleId).toBe("string");
    expect((undoSent.ruleId as string).length).toBeGreaterThan(0);
    expect(new Set(undoSent.ids)).toEqual(new Set([hist1.id, hist2.id]));

    await expect(
      notifications.getByText(/Restored 2 transactions/i),
    ).toBeVisible({ timeout: 5_000 });

    // The headline assertion: both historical rows visibly show the
    // original miscCat badge again, and no longer carry the debtCat one.
    await expect(
      hist1Row.getByText(miscName, { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      hist2Row.getByText(miscName, { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(hist1Row.getByText(debtName, { exact: true })).toHaveCount(0);
    await expect(hist2Row.getByText(debtName, { exact: true })).toHaveCount(0);

    // The trigger row stays on debtCat — the user's explicit single-row
    // pick was never part of the bulk affectedIds the Undo whitelists.
    await expect(
      triggerRow.getByText(debtName, { exact: true }),
    ).toBeVisible();

    await context.close();
  });
});
