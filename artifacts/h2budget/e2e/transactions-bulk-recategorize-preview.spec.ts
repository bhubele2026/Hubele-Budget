import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #187:
 *
 * After the quick-categorize flow on the Chase / Transactions page repoints
 * an existing mapping rule (PATCH /api/transactions/:id → repointedRules[]),
 * the page surfaces a follow-up toast offering to re-categorize the older
 * transactions still sitting in the rule's previous category. The toast now:
 *
 *   1. Reads "Move N past payment(s) into <category name>?" using the
 *      `candidateCount` returned for the repointed rule.
 *   2. Includes a "Show matches" link that opens a preview Dialog listing
 *      the first ~10 affected transactions (description, date, amount).
 *   3. The dialog's apply button still triggers the existing
 *      POST /api/transactions/recategorize-by-pattern flow.
 *
 * The unit + integration tests already lock the API contract; this spec
 * exercises the full UI flow against a fresh Clerk-provisioned user since
 * the app is invite-only and not reachable via the runTest harness.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

type ApiResult<T> = { ok: true; status: number; body: T } | {
  ok: false;
  status: number;
  body: unknown;
};

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

test.describe("Transactions bulk re-categorize preview (#187)", () => {
  test("toast says 'Move N past payments into <cat>?' and the Show-matches dialog lists the affected transactions, then Apply re-categorizes them", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-bulk-recat-187",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    // Land on the Transactions page so the user is provisioned in the DB
    // and the deep-link `?month=` param scopes the view to the current
    // month where the seeded test rows live.
    const monthStart = thisMonthStart();
    await signInAndOpen(
      page,
      email,
      password,
      `/transactions?month=${monthStart}`,
    );

    // The Transactions route renders as "Chase" — that's the page-under-test
    // (the user's checking activity, day by day).
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed deterministic categories + rule + transactions via the API.
    // The trigger row is uncategorized so the CategorizeChip is rendered;
    // the two historical rows sit in the "Misc Buffer" category that the
    // mapping rule currently points at, so picking the new debt category
    // on the trigger should repoint the rule and report candidateCount=2.
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

    // Pattern must be ≥ 2 whitespace-separated tokens — the auto-relearn
    // flow only repoints "specific" matching rules (see
    // `isPatternSpecific` in api-server/routes/transactions.ts), so a
    // single-token pattern would be treated as a generic catch-all and
    // left alone, suppressing the bulk-recategorize toast we're testing.
    const pattern = `E2EAMEX TEST-${suffix.toUpperCase()}`;
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
        description: `${pattern} PMT XXXX1006`,
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
        description: `${pattern} PMT XXXX1007`,
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
      },
    );

    // Reload so the page picks up the seeded rows in its initial query.
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const triggerRow = page.getByTestId(`row-tx-${trigger.id}`);
    await expect(triggerRow).toBeVisible({ timeout: 15_000 });

    // --- Open the CategorizeChip popover on the trigger row and pick the
    // debt category. The PATCH that fires from this click is what triggers
    // the auto-relearn + repoint-rule flow under test.
    await triggerRow
      .getByTestId(`badge-uncategorized-${trigger.id}`)
      .click();

    const picker = page.getByPlaceholder(/search category/i);
    await expect(picker).toBeVisible();
    await picker.fill(debtName);
    await page.getByRole("option", { name: debtName }).first().click();

    // --- The follow-up toast should surface with the new copy + the
    // "Show matches" link tied to candidateCount = 2 (the two historical
    // rows still in MiscBuf). Scope under the Notifications region to
    // avoid colliding with the Radix sr-only aria-live mirror span that
    // also contains the title text.
    const notifications = page.getByRole("region", {
      name: /notifications/i,
    });
    const toastTitle = notifications.getByText(
      `Move 2 past payments into ${debtName}?`,
    );
    await expect(toastTitle).toBeVisible({ timeout: 10_000 });

    const showMatchesLink = page.getByTestId("link-show-rule-matches");
    await expect(showMatchesLink).toBeVisible();
    await showMatchesLink.click();

    // --- Preview dialog opens with the dialog title mirroring the toast,
    // and lists exactly the two historical rows (the trigger row is
    // excluded from the sample by the server because it's the one that
    // just got patched).
    const dialog = page.getByTestId("dialog-rule-matches-preview");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      `Move 2 past payments into ${debtName}?`,
    );

    const list = page.getByTestId("list-rule-matches");
    await expect(list).toBeVisible();
    const rows = list.locator('[data-testid^="row-rule-match-"]');
    await expect(rows).toHaveCount(2);
    await expect(
      page.getByTestId(`row-rule-match-${hist1.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`row-rule-match-${hist2.id}`),
    ).toBeVisible();
    // The trigger row must NOT appear in the preview — the server-side
    // sample explicitly excludes the just-patched txn id.
    await expect(
      page.getByTestId(`row-rule-match-${trigger.id}`),
    ).toHaveCount(0);

    // --- Apply: dialog closes, POST /api/transactions/recategorize-by-pattern
    // fires, and a confirmation toast appears.
    const recatRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );
    const recatResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname ===
          "/api/transactions/recategorize-by-pattern",
      { timeout: 10_000 },
    );

    await page.getByTestId("button-rule-matches-apply").click();

    const recatReq = await recatRequestPromise;
    const recatRes = await recatResponsePromise;
    expect(recatRes.status()).toBe(200);
    const sentBody = JSON.parse(recatReq.postData() ?? "{}");
    expect(sentBody.pattern).toBe(pattern);
    expect(sentBody.matchType).toBe("contains");
    expect(sentBody.fromCategoryId).toBe(miscCat.id);
    expect(sentBody.toCategoryId).toBe(debtCat.id);

    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await expect(
      notifications.getByText(/Re-categorized 2 past transaction/i),
    ).toBeVisible({ timeout: 5_000 });

    // Belt-and-suspenders: confirm both historical txns now point at the
    // debt category server-side too.
    const allTxns = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions?limit=500");
    const byId = new Map(allTxns.map((t) => [t.id, t.categoryId] as const));
    expect(byId.get(hist1.id)).toBe(debtCat.id);
    expect(byId.get(hist2.id)).toBe(debtCat.id);

    // --- Task #199: the success toast also offers an Undo button so the
    // user can back out of a wrong-category bulk in one click. Clicking
    // it should restore each affected transaction to its previous
    // category AND re-point the originating mapping rule back so future
    // matching charges no longer auto-snap onto the mistaken category.
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
    const undoSent = JSON.parse(undoReq.postData() ?? "{}");
    // The Undo POST mirrors the Apply POST with from/to swapped, the
    // affected ids whitelisted, and the originating rule's id passed
    // through so the server can also re-point it back.
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

    // Both historical txns are back on miscCat.
    const afterUndoTxns = await apiCall<
      Array<{ id: string; categoryId: string | null }>
    >(page, "GET", "/api/transactions?limit=500");
    const afterUndoById = new Map(
      afterUndoTxns.map((t) => [t.id, t.categoryId] as const),
    );
    expect(afterUndoById.get(hist1.id)).toBe(miscCat.id);
    expect(afterUndoById.get(hist2.id)).toBe(miscCat.id);
    // The trigger row was the user's explicit single-row pick — it
    // stays on debtCat because it wasn't part of the bulk affectedIds.
    expect(afterUndoById.get(trigger.id)).toBe(debtCat.id);

    // The mapping rule itself is also back on miscCat — without this,
    // future matching payments would keep auto-snapping onto debtCat.
    const rulesAfterUndo = await apiCall<
      Array<{ id: string; pattern: string; categoryId: string | null }>
    >(page, "GET", "/api/mapping-rules");
    const seedRule = rulesAfterUndo.find((r) => r.pattern === pattern);
    expect(seedRule).toBeDefined();
    expect(seedRule!.categoryId).toBe(miscCat.id);

    await context.close();
  });
});
