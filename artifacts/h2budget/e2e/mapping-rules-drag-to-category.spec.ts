import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * E2E coverage for task #202: dragging a Mapping Rule's drag handle
 * onto a category chip in the new "Drag a rule onto a category" strip
 * reassigns the rule via PATCH /api/mapping-rules/:id and surfaces a
 * confirmation toast — without breaking the existing reorder behavior.
 *
 * dnd-kit's PointerSensor needs a small initial movement (>= 4px) before
 * it begins the drag, so the helper below replays a press, a tiny nudge,
 * a multi-step move to the target, and a release. This is the same
 * pattern other dnd-kit-driven Playwright suites use.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

type Category = { id: string; name: string };
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
      if (!res.ok) return { ok: false, status: res.status, body: parsed };
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

async function dragTo(
  page: Page,
  sourceTestId: string,
  targetTestId: string,
): Promise<void> {
  const source = page.getByTestId(sourceTestId);
  const target = page.getByTestId(targetTestId);
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  // Pull the drag source into view once. The target is in the strip
  // immediately above the rules list, so a single scroll keeps both ends
  // visible without any layout shift mid-drag.
  await source.scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);

  // Measure both boxes after the scroll has settled and BEFORE we start
  // the drag — this avoids any reflow shifting the chip we're aiming for.
  const sb = await source.boundingBox();
  const tb = await target.boundingBox();
  if (!sb || !tb) throw new Error("Missing bounding box for drag source/target");
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;

  // dnd-kit's PointerSensor listens for native pointerdown on the
  // activator node. Playwright's page.mouse helper sometimes fails to
  // wake up the sensor in headless Chromium because the synthesized
  // pointer events don't reach the activator's pointerdown listener.
  // Dispatching pointerdown directly on the activator + nudging the
  // page.mouse past the 4px activation distance is the most reliable
  // pattern.
  await source.dispatchEvent("pointerdown", {
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: sx,
    clientY: sy,
  });
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 12, { steps: 6 });
  await page.waitForTimeout(80);
  await page.mouse.move(tx, ty, { steps: 30 });
  await page.waitForTimeout(80);
  await page.mouse.up();
}

test.describe("Mapping Rules · drag rule onto category (#202)", () => {
  test("dragging a rule onto a category chip PATCHes its categoryId and toasts", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "rule-drag-cat-202",
      provisionedUserIds,
    );
    const context = await browser.newContext();
    const page = await context.newPage();

    // Land on /budget so first-visit seeding fires and we have categories.
    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    let categories: Category[] = [];
    await expect
      .poll(
        async () => {
          categories = await apiCall<Category[]>(
            page,
            "GET",
            "/api/budget/categories",
          );
          return categories.length;
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThan(1);

    const dining = categories.find((c) => c.name === "Dining & Coffee");
    const groceries = categories.find((c) => c.name === "Groceries");
    if (!dining) throw new Error("Seed missing 'Dining & Coffee' category");
    if (!groceries) throw new Error("Seed missing 'Groceries' category");

    const rule = await apiCall<{ id: string; categoryId: string | null }>(
      page,
      "POST",
      "/api/mapping-rules",
      {
        pattern: `DRAGTEST-${Math.random().toString(36).slice(2, 8)}`,
        matchType: "contains",
        categoryId: dining.id,
        priority: 99999,
      },
    );
    expect(rule.categoryId).toBe(dining.id);

    await page.goto("/mapping-rules");
    await expect(
      page.getByRole("heading", { name: /mapping rules/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The new category drop strip should be visible above the rules list,
    // with one droppable chip per category and the helper hint text.
    const strip = page.getByTestId("category-drop-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText(/Drag a rule onto a category/i);
    await expect(page.getByTestId(`category-drop-${dining.id}`)).toBeVisible();
    await expect(page.getByTestId(`category-drop-${groceries.id}`)).toBeVisible();

    const ruleRow = page.getByTestId(`rule-row-${rule.id}`);
    await expect(ruleRow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`rule-category-${rule.id}`)).toHaveText(
      /Dining & Coffee/i,
    );

    // Watch for the PATCH triggered by the drop so we can lock the wire
    // contract (full body, new categoryId).
    const patchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/mapping-rules/${rule.id}`,
      { timeout: 10_000 },
    );
    const patchResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/mapping-rules/${rule.id}`,
      { timeout: 10_000 },
    );

    await dragTo(
      page,
      `rule-drag-${rule.id}`,
      `category-drop-${groceries.id}`,
    );

    const patchReq = await patchPromise;
    const patchRes = await patchResponsePromise;
    expect(patchRes.status()).toBe(200);
    const sentBody = JSON.parse(patchReq.postData() ?? "{}");
    expect(sentBody.categoryId).toBe(groceries.id);
    // The PATCH endpoint requires the full MappingRuleInput shape, so the
    // client must echo pattern + matchType + priority alongside the new
    // category — guard against a regression that drops them.
    expect(typeof sentBody.pattern).toBe("string");
    expect(sentBody.pattern.length).toBeGreaterThan(0);
    expect(sentBody.matchType).toBe("contains");
    expect(sentBody.priority).toBe(99999);

    // The row's category label flips to the new category, and a toast
    // confirms the reassignment.
    await expect(page.getByTestId(`rule-category-${rule.id}`)).toHaveText(
      /Groceries/i,
      { timeout: 10_000 },
    );
    await expect(page.getByText(/Rule reassigned/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Belt-and-suspenders: confirm via the API.
    const persisted = await apiCall<Array<{ id: string; categoryId: string }>>(
      page,
      "GET",
      "/api/mapping-rules",
    );
    const persistedRow = persisted.find((r) => r.id === rule.id);
    expect(persistedRow?.categoryId).toBe(groceries.id);

    // Dropping onto the same category should be a no-op (no PATCH fired).
    let extraPatchSeen = false;
    const extraPatchListener = (req: import("@playwright/test").Request) => {
      if (
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/mapping-rules/${rule.id}`
      ) {
        extraPatchSeen = true;
      }
    };
    page.on("request", extraPatchListener);
    await dragTo(
      page,
      `rule-drag-${rule.id}`,
      `category-drop-${groceries.id}`,
    );
    // Give the network a beat to settle so a stray PATCH would have fired.
    await page.waitForTimeout(500);
    page.off("request", extraPatchListener);
    expect(extraPatchSeen).toBe(false);

    await context.close();
  });
});
