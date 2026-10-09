import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #208:
 *
 * The MatchedRuleChip says why a row is in its category: a "rule: <pattern>"
 * link that deep-links to /mapping-rules?focus=<id> when the row's
 * `categoryId` matches the mapping rule auto-categorize would attribute
 * *right now*, or a "Manual" hint when the row has a category but no current
 * rule matches in it.
 *
 * (C9 repair) #208 put the chip on three surfaces. Two of them — the old
 * `/dashboard` "Recent Transactions" widget and its ReimbursementsBox — are
 * gone (`/dashboard` redirects to `/banking`, which has neither), so the
 * spec now pins the surfaces that carry the chip today, both reached from
 * the Chase page:
 *
 *   - the transaction Edit dialog's category field (CH-38): the
 *     rule-attributed row shows the rule link, the hand-filed row "Manual";
 *   - the recategorize-by-pattern preview Dialog (CH-28), reached from the
 *     row's CategoryPicker (`button-category-picker`; the old CategorizeChip
 *     `badge-uncategorized-*` is gone), where each historical row shows
 *     "Manual" once the rule has been repointed away from its category.
 *
 * Plaid pull surfaces no preview UI today — the sync just imports.
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
  test("the Chase Edit dialog and the recategorize preview dialog surface the chip with the same rule-vs-manual semantics", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "matched-rule-chip-208",
      provisionedUserIds,
    );

    const monthStart = thisMonthStart();
    await signInAndOpen(page, email, password, `/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed deterministic categories + mapping rules + transactions.
    // The rule pattern must be ≥ 2 whitespace-separated tokens so the
    // auto-relearn flow treats it as "specific" (see isPatternSpecific
    // in api-server/routes/transactions.ts) and therefore eligible for
    // the bulk-recategorize preview dialog later in the test.
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
    await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: reimbName, kind: "expense", groupName: "Other" },
    );

    // Pattern A: attributes the auto-categorized row (rule link).
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

    // Pattern B: powers the recategorize-by-pattern preview dialog. Two
    // historical rows in `diningCat` plus a trigger row we quick-categorize
    // into reimbCat.
    const patternB = `E2EROW B-${suffix.toUpperCase()}`;
    await apiCall<{ id: string }>(page, "POST", "/api/mapping-rules", {
      pattern: patternB,
      matchType: "contains",
      categoryId: diningCat.id,
      priority: 50,
    });

    // Auto-categorized row — rule A matches in groceriesCat.
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
    // Manually categorized row — has a category but no rule matches its
    // description, so the chip should read "Manual".
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
        // Server-side auto-categorize on POST /transactions would otherwise
        // pre-assign this row to diningCat via ruleB. Pass an explicit null
        // so the trigger stays uncategorized.
        categoryId: null,
      },
    );

    await page.goto(`/transactions?month=${monthStart}`);
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // ===== Surface 1: the Edit dialog's category field.
    await expect(page.getByTestId(`row-tx-${recentAuto.id}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`button-edit-tx-${recentAuto.id}`).click();
    const editDialog = page.getByRole("dialog");
    await expect(editDialog.getByText("Edit Transaction")).toBeVisible();
    const ruleChip = page.getByTestId("link-matched-rule-new-tx-dialog");
    await expect(ruleChip).toBeVisible();
    await expect(ruleChip).toContainText(patternA);
    await expect(ruleChip).toHaveAttribute(
      "href",
      new RegExp(`/mapping-rules\\?focus=${ruleA.id}$`),
    );
    await page.keyboard.press("Escape");
    await expect(editDialog).toBeHidden();

    await page.getByTestId(`button-edit-tx-${recentManual.id}`).click();
    await expect(page.getByRole("dialog").getByText("Edit Transaction")).toBeVisible();
    await expect(page.getByTestId("text-no-rule-new-tx-dialog")).toBeVisible();
    await expect(page.getByTestId("link-matched-rule-new-tx-dialog")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // ===== Surface 2: recategorize-by-pattern preview dialog.
    const triggerRow = page.getByTestId(`row-tx-${triggerB.id}`);
    await expect(triggerRow).toBeVisible({ timeout: 15_000 });
    // The row's CategoryPicker; "Remember" unticked so the PATCH carries the
    // category alone and the server's own auto-relearn repoints ruleB.
    await triggerRow.getByTestId("button-category-picker").click();
    await page.getByTestId("checkbox-remember-picker").click();
    await expect(page.getByTestId("checkbox-remember-picker")).toHaveAttribute(
      "data-state",
      "unchecked",
    );

    const picker = page.getByPlaceholder(/^search/i);
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
    // were computed, the chip reads "Manual" — there's no longer a rule
    // pointing at diningCat for these descriptions.
    await expect(
      page.getByTestId(`text-no-rule-rule-match-${histB1.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`text-no-rule-rule-match-${histB2.id}`),
    ).toBeVisible();
  });
});
