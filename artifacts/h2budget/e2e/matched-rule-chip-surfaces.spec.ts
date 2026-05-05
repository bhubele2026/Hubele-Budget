import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #208:
 *
 * The MatchedRuleChip (introduced in #192 for the Transactions and Amex
 * pages) was extended to three additional transaction-list surfaces:
 *
 *   - Dashboard "Recent Transactions" widget.
 *   - Dashboard "ReimbursementsBox" rows.
 *   - The recategorize-by-pattern preview Dialog on the Transactions page.
 *
 * For each surface the chip should:
 *
 *   - Render a "rule: <pattern>" link that deep-links to
 *     /mapping-rules?focus=<id> when the row's `categoryId` matches the
 *     mapping rule that auto-categorize would attribute *right now*.
 *   - Render a "manually categorized" hint when the row has a category
 *     but no current rule matches in that category.
 *
 * Plaid pull surfaces no preview UI today — the sync just imports — so
 * this spec covers all UI surfaces actually shipped under #208.
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

test.describe("MatchedRuleChip on extra transaction-list surfaces (#208)", () => {
  test("dashboard recent activity, reimbursements box, and recategorize preview dialog all surface the chip with the same rule-vs-manual semantics", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "matched-rule-chip-208",
      provisionedUserIds,
    );

    // Land on the dashboard so the user is provisioned in the DB.
    // The dashboard route is `/dashboard` (root `/` redirects there);
    // the page's only h1 lives in the loading branch, and CardTitle is
    // a styled div, so anchor on the persistent "Recent Transactions"
    // text instead.
    await signInAndOpen(page, email, password, "/dashboard");
    await expect(
      page.getByText("Recent Transactions", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // --- Seed deterministic categories + a mapping rule + transactions.
    // The rule pattern must be ≥ 2 whitespace-separated tokens so the
    // auto-relearn flow treats it as "specific" (see isPatternSpecific
    // in api-server/routes/transactions.ts) and therefore eligible for
    // both rule-attributed chip rendering and the bulk-recategorize
    // preview dialog later in the test.
    const suffix = Math.random().toString(36).slice(2, 8);
    const groceriesName = `Groceries-${suffix}`;
    const diningName = `Dining-${suffix}`;
    const reimbName = `Reimbursable-${suffix}`;

    const groceriesCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: groceriesName, kind: "expense", groupName: "Other" },
    );
    const diningCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: diningName, kind: "expense", groupName: "Other" },
    );
    const reimbCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: reimbName, kind: "expense", groupName: "Other" },
    );

    // Pattern A: matches the auto-categorized "recent" row on the
    // dashboard (will render the rule chip).
    const patternA = `E2EROW-A-${suffix.toUpperCase()}`;
    const ruleA = await apiCall<{ id: string; pattern: string }>(
      page,
      "POST",
      "/api/mapping-rules",
      {
        pattern: patternA,
        matchType: "contains",
        categoryId: groceriesCat.id,
        priority: 50,
      },
    );

    // Pattern B: powers the recategorize-by-pattern preview dialog
    // later. Two historical rows in `diningCat` plus a trigger row
    // we'll quick-categorize into reimbCat. Must be ≥ 2
    // whitespace-separated tokens so isPatternSpecific() in
    // api-server/routes/transactions.ts treats it as "specific" and
    // therefore eligible to repoint — single-token patterns are
    // treated as catch-alls and the bulk-recategorize toast won't fire.
    const patternB = `E2EROW B-${suffix.toUpperCase()}`;
    await apiCall<{ id: string }>(page, "POST", "/api/mapping-rules", {
      pattern: patternB,
      matchType: "contains",
      categoryId: diningCat.id,
      priority: 50,
    });

    // Auto-categorized recent row — rule A matches in groceriesCat.
    const recentAuto = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-1),
        description: `${patternA} STORE 1234`,
        amount: "-25.00",
        categoryId: groceriesCat.id,
      },
    );
    // Manually categorized recent row — has a category but no rule
    // matches its description, so the chip should read "manually
    // categorized".
    const recentManual = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-2),
        description: `MANUAL-ONLY-${suffix} CHARGE`,
        amount: "-12.34",
        categoryId: diningCat.id,
      },
    );

    // Reimbursable row — feeds the ReimbursementsBox. Manually
    // categorized so its chip reads "manually categorized".
    const reimbursable = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-1),
        description: `REIMB-${suffix} LUNCH`,
        amount: "-15.00",
        categoryId: reimbCat.id,
        reimbursable: true,
      },
    );

    // Two historical rows in diningCat + a trigger row used to drive
    // the recategorize-by-pattern preview dialog.
    const histB1 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-3),
        description: `${patternB} CAFE 1`,
        amount: "-8.00",
        categoryId: diningCat.id,
      },
    );
    const histB2 = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-2),
        description: `${patternB} CAFE 2`,
        amount: "-9.00",
        categoryId: diningCat.id,
      },
    );
    const triggerB = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/transactions",
      {
        occurredOn: isoDay(-1),
        description: `${patternB} CAFE TRIGGER`,
        amount: "-10.00",
        // Server-side auto-categorize on POST /transactions (added in
        // main-repl/main) would otherwise pre-assign this row to
        // diningCat via ruleB. Pass an explicit null so the trigger
        // stays uncategorized and the test can drive the picker via
        // `badge-uncategorized-…`.
        categoryId: null,
      },
    );

    // ===== Surface 1 + 2: Dashboard recent activity + reimbursements.
    await page.goto("/dashboard");
    await expect(
      page.getByText("Recent Transactions", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    const recentAutoRow = page.getByTestId(`row-recent-${recentAuto.id}`);
    await expect(recentAutoRow).toBeVisible({ timeout: 15_000 });
    const recentAutoChip = page.getByTestId(
      `link-matched-rule-recent-${recentAuto.id}`,
    );
    await expect(recentAutoChip).toBeVisible();
    await expect(recentAutoChip).toContainText(patternA);
    await expect(recentAutoChip).toHaveAttribute(
      "href",
      `/mapping-rules?focus=${ruleA.id}`,
    );

    const recentManualRow = page.getByTestId(`row-recent-${recentManual.id}`);
    await expect(recentManualRow).toBeVisible();
    await expect(
      page.getByTestId(`text-no-rule-recent-${recentManual.id}`),
    ).toBeVisible();

    // ReimbursementsBox row chip — manually categorized.
    await expect(
      page.getByTestId(`text-no-rule-reimburse-${reimbursable.id}`),
    ).toBeVisible({ timeout: 10_000 });

    // ===== Surface 3: recategorize-by-pattern preview dialog.
    const monthStart = thisMonthStart();
    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    const triggerRow = page.getByTestId(`row-tx-${triggerB.id}`);
    await expect(triggerRow).toBeVisible({ timeout: 15_000 });
    await triggerRow
      .getByTestId(`badge-uncategorized-${triggerB.id}`)
      .click();

    const picker = page.getByPlaceholder(/search category/i);
    await expect(picker).toBeVisible();
    await picker.fill(reimbName);
    await page.getByRole("option", { name: reimbName }).first().click();

    // Toast offers the "Show matches" link → opens the preview Dialog.
    const showMatchesLink = page.getByTestId("link-show-rule-matches");
    await expect(showMatchesLink).toBeVisible({ timeout: 10_000 });
    await showMatchesLink.click();

    const dialog = page.getByTestId("dialog-rule-matches-preview");
    await expect(dialog).toBeVisible();

    // Each historical row in the dialog renders the chip. Because the
    // bulk repoint already happened on the server side before samples
    // were computed, the chip reads "manually categorized" — there's
    // no longer a rule pointing at diningCat for these descriptions.
    await expect(
      page.getByTestId(`text-no-rule-rule-match-${histB1.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`text-no-rule-rule-match-${histB2.id}`),
    ).toBeVisible();
  });
});
