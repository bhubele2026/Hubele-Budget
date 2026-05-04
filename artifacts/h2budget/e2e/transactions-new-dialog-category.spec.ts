import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #230:
 *
 * The Add-Transaction dialog now exposes a "Category" combobox that:
 *   1. Auto-fills with the categoryId of the highest-priority mapping rule
 *      whose pattern matches the description as the user types (mirroring
 *      the server-side auto-categorize from POST /transactions in tasks
 *      #207 / #218).
 *   2. Surfaces a small inline `MatchedRuleChip` linking to the matched
 *      rule on the Mapping Rules page so the user can see *why* a
 *      category was suggested.
 *   3. Submitting with an explicit pick passes that `categoryId` in the
 *      POST body so the server respects the user's choice instead of
 *      re-running its own auto-categorize fallback (the "Categorized by
 *      rule X" toast is suppressed in that path because the response's
 *      `autoCategorizedRuleId` comes back null).
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

test.describe("Add-Transaction dialog Category combobox (#230)", () => {
  test("auto-picks the matching rule's category as the user types, surfaces the chip, and POSTs an explicit override when the user picks a different category", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "txn-new-cat-230",
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

    // --- Seed two distinct categories + a mapping rule whose pattern is
    // known to fire on a controlled description fragment. The auto-pick
    // is expected to land on `coffeeCat`; the explicit override picks
    // `treatsCat` instead, mirroring the task's "STARBUCKS COFFEE in
    // 'Treats'" example.
    const suffix = Math.random().toString(36).slice(2, 8);
    const coffeeName = `Coffee230-${suffix}`;
    const treatsName = `Treats230-${suffix}`;
    const pattern = `E2ESBUX-${suffix.toUpperCase()}`;

    const coffeeCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: coffeeName, kind: "expense", groupName: "Food" },
    );
    const treatsCat = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: treatsName, kind: "expense", groupName: "Food" },
    );
    const rule = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/mapping-rules",
      {
        pattern,
        matchType: "contains",
        categoryId: coffeeCat.id,
        priority: 50,
      },
    );

    // Reload so the Transactions page picks up the freshly-created rule
    // in its `useListMappingRules` cache (the dialog's auto-pick effect
    // reads from that cache).
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Open the Add-Transaction dialog and type a description that
    // matches the seeded rule. The Category combobox should auto-fill
    // with the rule's category ("Coffee230-…") and the matched-rule chip
    // should link to /mapping-rules?focus=<ruleId>.
    await page.getByTestId("button-add-transaction").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("New Transaction")).toBeVisible();

    const combobox = page.getByTestId("combobox-new-tx-category");
    await expect(combobox).toBeVisible();
    await expect(combobox).toContainText(/uncategorized/i);

    const descriptionInput = dialog.getByPlaceholder("Trader Joe's");
    await descriptionInput.fill(`MORNING ${pattern} #221`);

    await expect(combobox).toContainText(coffeeName, { timeout: 5_000 });

    // The matched-rule chip should be a link to /mapping-rules?focus=<id>
    // and announce the rule's pattern.
    const chip = page.getByTestId("link-matched-rule-new-tx-dialog");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(pattern);
    await expect(chip).toHaveAttribute(
      "href",
      `/mapping-rules?focus=${encodeURIComponent(rule.id)}`,
    );

    // --- Override the auto-pick with the Treats category. After picking
    // explicitly, the chip's "matched by rule" attribution should
    // disappear (the auto-matched rule's categoryId no longer equals the
    // selected categoryId), even though the description still matches
    // the rule.
    await combobox.click();
    await page.getByTestId(`option-new-tx-category-${treatsCat.id}`).click();
    await expect(combobox).toContainText(treatsName);
    await expect(
      page.getByTestId("link-matched-rule-new-tx-dialog"),
    ).toHaveCount(0);

    // --- Fill the remaining required fields and submit. Capture the
    // POST /api/transactions request to assert the body carried our
    // explicit `categoryId` override.
    await dialog.getByLabel("Amount").fill("4.75");

    const createReqPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname === "/api/transactions",
      { timeout: 10_000 },
    );
    const createResPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/transactions",
      { timeout: 10_000 },
    );

    await dialog.getByRole("button", { name: /^save$/i }).click();

    const createReq = await createReqPromise;
    const createRes = await createResPromise;
    expect(createRes.status()).toBe(201);

    const sentBody = JSON.parse(createReq.postData() ?? "{}");
    expect(sentBody.categoryId).toBe(treatsCat.id);
    expect(sentBody.description).toContain(pattern);

    // Server's auto-categorize fallback is only run when the body OMITS
    // categoryId. Since we passed it explicitly, the response's
    // autoCategorizedRuleId must come back null and the redundant
    // "Categorized by rule X" toast must NOT fire.
    const createdRow = await createRes.json();
    expect(createdRow.autoCategorizedRuleId).toBeNull();
    expect(createdRow.categoryId).toBe(treatsCat.id);

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(notifications.getByText(/^Transaction created$/)).toBeVisible({
      timeout: 5_000,
    });
    await expect(notifications.getByText(/^Categorized$/)).toHaveCount(0);
  });
});
