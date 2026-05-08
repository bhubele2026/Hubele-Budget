import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #389:
 *
 * Task #336 introduced per-category collapse state on the Mapping Rules
 * page that persists in localStorage under the
 * `h2budget:mappingRules:collapsedCategories` key, with a "Collapse all
 * / Expand all" toggle and a few subtle force-expand rules (active
 * search, focus deep-link). This spec locks in:
 *
 *   (a) collapsing one card via its toggle and reloading the page keeps
 *       the card collapsed (rule list hidden, chevron-right icon,
 *       data-collapsed="true" on the card);
 *   (b) typing in the search box force-expands a collapsed card whose
 *       rules match, and clearing the search restores the persisted
 *       collapsed state;
 *   (c) the "Collapse all / Expand all" button (`rule-collapse-all`)
 *       flips every rendered card's state in one click.
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

test.describe("Mapping Rules collapsed-card persistence (#389)", () => {
  test("persists per-card collapse across reload, force-expands on search, and bulk-toggles via the Collapse/Expand all button", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "map-rules-collapsed-389",
      provisionedUserIds,
    );

    // Land on the Mapping Rules page so the user is provisioned.
    await signInAndOpen(page, email, password, "/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Seed: two categories, each with one rule. We use random
    // suffixes so the seed cannot collide with default-seeded categories
    // and so the search query in step (b) is unambiguous.
    const suffix = Math.random().toString(36).slice(2, 8);
    const catAName = `Aaa-${suffix}`;
    const catBName = `Bbb-${suffix}`;

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

    const patternA = `E2ECOLLAPSE-A-${suffix.toUpperCase()}`;
    const patternB = `E2ECOLLAPSE-B-${suffix.toUpperCase()}`;
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

    // Reload so the page hydrates with the seeded categories + rules
    // and a clean (empty) localStorage entry for collapse state.
    await page.goto("/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    const cardA = page.getByTestId(`rule-category-card-${catA.id}`);
    const cardB = page.getByTestId(`rule-category-card-${catB.id}`);
    const toggleA = page.getByTestId(`rule-category-card-toggle-${catA.id}`);
    const toggleB = page.getByTestId(`rule-category-card-toggle-${catB.id}`);
    const listA = page.getByTestId(`rule-category-card-list-${catA.id}`);
    const listB = page.getByTestId(`rule-category-card-list-${catB.id}`);

    await expect(cardA).toBeVisible();
    await expect(cardB).toBeVisible();
    // Both cards start expanded.
    await expect(cardA).not.toHaveAttribute("data-collapsed", "true");
    await expect(cardB).not.toHaveAttribute("data-collapsed", "true");
    await expect(listA).toBeVisible();
    await expect(listB).toBeVisible();

    // --- (a) Collapse cardA via its toggle. The card should pick up
    // data-collapsed="true", swap its chevron from down to right, hide
    // its rule list, and report aria-expanded="false".
    await toggleA.click();
    await expect(cardA).toHaveAttribute("data-collapsed", "true");
    await expect(toggleA).toHaveAttribute("aria-expanded", "false");
    await expect(toggleA.locator("svg.lucide-chevron-right")).toBeVisible();
    await expect(toggleA.locator("svg.lucide-chevron-down")).toHaveCount(0);
    await expect(listA).toHaveCount(0);
    // cardB is unaffected.
    await expect(cardB).not.toHaveAttribute("data-collapsed", "true");
    await expect(listB).toBeVisible();

    // The collapse choice was written to localStorage under the
    // documented key — assert it by name so a future rename can't
    // silently break the persistence contract.
    const persisted = await page.evaluate(() =>
      window.localStorage.getItem(
        "h2budget:mappingRules:collapsedCategories",
      ),
    );
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(persisted!) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed as string[]).toContain(catA.id);

    // Reload — cardA must come back collapsed, cardB expanded.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(cardA).toBeVisible();
    await expect(cardA).toHaveAttribute("data-collapsed", "true");
    await expect(toggleA).toHaveAttribute("aria-expanded", "false");
    await expect(toggleA.locator("svg.lucide-chevron-right")).toBeVisible();
    await expect(listA).toHaveCount(0);
    await expect(cardB).not.toHaveAttribute("data-collapsed", "true");
    await expect(listB).toBeVisible();

    // --- (b) Typing in the search box should force-expand the
    // collapsed cardA when its rule matches, without clearing the
    // persisted collapsed state. Clearing the search restores the
    // collapsed view.
    const search = page.getByTestId("input-search-rules");
    await search.fill(patternA);
    await expect(cardA).not.toHaveAttribute("data-collapsed", "true");
    await expect(listA).toBeVisible();
    await expect(
      listA.getByTestId(`rule-row-${ruleA.id}`),
    ).toBeVisible();
    // While the search is active the chevron should reflect the
    // (force-)expanded state.
    await expect(toggleA.locator("svg.lucide-chevron-down")).toBeVisible();

    await search.fill("");
    await expect(cardA).toHaveAttribute("data-collapsed", "true");
    await expect(listA).toHaveCount(0);
    await expect(toggleA.locator("svg.lucide-chevron-right")).toBeVisible();

    // --- (c) "Collapse all / Expand all" flips every rendered card in
    // one click. cardA is currently collapsed and cardB expanded, so
    // the button reads "Collapse all" and a click should collapse both.
    const collapseAll = page.getByTestId("rule-collapse-all");
    await expect(collapseAll).toHaveText(/collapse all/i);
    await collapseAll.click();
    await expect(cardA).toHaveAttribute("data-collapsed", "true");
    await expect(cardB).toHaveAttribute("data-collapsed", "true");
    await expect(listA).toHaveCount(0);
    await expect(listB).toHaveCount(0);
    // Now every visible card is collapsed, so the button flips to
    // "Expand all" and a click should expand them all.
    await expect(collapseAll).toHaveText(/expand all/i);
    await collapseAll.click();
    await expect(cardA).not.toHaveAttribute("data-collapsed", "true");
    await expect(cardB).not.toHaveAttribute("data-collapsed", "true");
    await expect(listA).toBeVisible();
    await expect(listB).toBeVisible();
    await expect(
      listA.getByTestId(`rule-row-${ruleA.id}`),
    ).toBeVisible();
    await expect(
      listB.getByTestId(`rule-row-${ruleB.id}`),
    ).toBeVisible();
  });
});
