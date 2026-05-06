import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #337:
 *
 * Task #282 split the Mapping Rules page into one card per category. This
 * spec locks in the per-category grouping itself:
 *
 *   (a) one card renders per category that has at least one rule;
 *   (b) categories with zero rules are hidden entirely;
 *   (c) saving an inline edit that flips a rule's category visibly moves
 *       the rule row from the old card's list into the new card's list;
 *   (d) the per-card "N rule(s)" badge updates accordingly (and the now
 *       empty old card disappears).
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

test.describe("Mapping Rules per-category cards (#337)", () => {
  test("renders one card per non-empty category, hides empty categories, and moves a rule between cards on edit-save", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "map-rules-per-cat-cards-337",
      provisionedUserIds,
    );

    // Land on the Mapping Rules page so the user is provisioned.
    await signInAndOpen(page, email, password, "/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed: three categories, two of which each own exactly one rule;
    // the third is intentionally left empty so the spec can assert the
    // "categories with zero rules are hidden" half of the contract.
    const suffix = Math.random().toString(36).slice(2, 8);
    const catAName = `Aaa-${suffix}`;
    const catBName = `Bbb-${suffix}`;
    const catCName = `Ccc-${suffix}`;

    const catA = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: catAName, kind: "expense", groupName: "Other" },
    );
    const catB = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: catBName, kind: "expense", groupName: "Other" },
    );
    const catC = await apiCall<{ id: string; name: string }>(
      page,
      "POST",
      "/api/budget/categories",
      { name: catCName, kind: "expense", groupName: "Other" },
    );

    const patternA = `E2EPCC-A-${suffix.toUpperCase()}`;
    const patternB = `E2EPCC-B-${suffix.toUpperCase()}`;
    const ruleA = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/mapping-rules",
      {
        pattern: patternA,
        matchType: "contains",
        categoryId: catA.id,
        priority: 50,
      },
    );
    const ruleB = await apiCall<{ id: string }>(
      page,
      "POST",
      "/api/mapping-rules",
      {
        pattern: patternB,
        matchType: "contains",
        categoryId: catB.id,
        priority: 40,
      },
    );

    // Reload so the page picks up the seeded categories + rules.
    await page.goto("/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- (a) + (b): exactly the two non-empty categories render as cards.
    const cardsContainer = page.getByTestId("rule-category-cards");
    await expect(cardsContainer).toBeVisible({ timeout: 10_000 });

    const cardA = page.getByTestId(`rule-category-card-${catA.id}`);
    const cardB = page.getByTestId(`rule-category-card-${catB.id}`);
    const cardC = page.getByTestId(`rule-category-card-${catC.id}`);
    await expect(cardA).toBeVisible();
    await expect(cardB).toBeVisible();
    // The empty third category must NOT have a card on the page.
    // (Other default categories the app auto-seeds for a new user may
    // have their own cards — that's the whole point of the per-category
    // grouping — so we only assert that *empty* catC is hidden.)
    await expect(cardC).toHaveCount(0);

    // Card titles + per-card count badges reflect the seed.
    await expect(
      page.getByTestId(`rule-category-card-name-${catA.id}`),
    ).toHaveText(catAName);
    await expect(
      page.getByTestId(`rule-category-card-name-${catB.id}`),
    ).toHaveText(catBName);
    await expect(
      page.getByTestId(`rule-category-card-count-${catA.id}`),
    ).toHaveText("1 rule");
    await expect(
      page.getByTestId(`rule-category-card-count-${catB.id}`),
    ).toHaveText("1 rule");

    // Each rule lives inside its category's card list — not the other one.
    const listA = page.getByTestId(`rule-category-card-list-${catA.id}`);
    const listB = page.getByTestId(`rule-category-card-list-${catB.id}`);
    await expect(listA.getByTestId(`rule-row-${ruleA.id}`)).toBeVisible();
    await expect(listB.getByTestId(`rule-row-${ruleB.id}`)).toBeVisible();
    await expect(listA.getByTestId(`rule-row-${ruleB.id}`)).toHaveCount(0);
    await expect(listB.getByTestId(`rule-row-${ruleA.id}`)).toHaveCount(0);

    // --- (c) + (d): edit ruleA, flip its category to the (currently
    // empty) catC, save, and assert the row migrates and the count
    // badges + card visibility update.
    await page.getByTestId(`rule-edit-btn-${ruleA.id}`).click();
    const editRow = page.getByTestId(`rule-edit-${ruleA.id}`);
    await expect(editRow).toBeVisible();

    await page.getByTestId(`rule-edit-category-${ruleA.id}`).click();
    await page.getByRole("option", { name: catCName }).first().click();

    // No historical transactions exist for ruleA's pattern, so no
    // preview banner should appear and the chained bulk recategorize
    // shouldn't fire — just the PATCH.
    await expect(
      page.getByTestId(`rule-edit-preview-${ruleA.id}`),
    ).toHaveCount(0);

    const patchResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/mapping-rules/${ruleA.id}`,
      { timeout: 10_000 },
    );
    await page.getByTestId(`rule-save-${ruleA.id}`).click();
    const patchRes = await patchResponsePromise;
    expect(patchRes.status()).toBe(200);

    // The old card (catA) had only ruleA, so it should now be hidden
    // because zero-rule categories are pruned from cardGroups.
    await expect(
      page.getByTestId(`rule-category-card-${catA.id}`),
    ).toHaveCount(0, { timeout: 10_000 });

    // catC, previously empty and hidden, should now render with the
    // migrated rule row inside it.
    const cardCAfter = page.getByTestId(`rule-category-card-${catC.id}`);
    await expect(cardCAfter).toBeVisible();
    await expect(
      page.getByTestId(`rule-category-card-name-${catC.id}`),
    ).toHaveText(catCName);
    await expect(
      page.getByTestId(`rule-category-card-count-${catC.id}`),
    ).toHaveText("1 rule");
    await expect(
      page
        .getByTestId(`rule-category-card-list-${catC.id}`)
        .getByTestId(`rule-row-${ruleA.id}`),
    ).toBeVisible();

    // catB is unchanged: still one rule, still ruleB.
    await expect(
      page.getByTestId(`rule-category-card-count-${catB.id}`),
    ).toHaveText("1 rule");
    await expect(
      page
        .getByTestId(`rule-category-card-list-${catB.id}`)
        .getByTestId(`rule-row-${ruleB.id}`),
    ).toBeVisible();

  });
});
