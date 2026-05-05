import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * Touch-path coverage for task #226: the existing
 * mapping-rules-drag-to-category.spec.ts exercises dnd-kit's PointerSensor
 * via mouse events. This spec drives the same drop interaction through
 * dnd-kit's TouchSensor on a mobile viewport so the long-press activation
 * (delay: 200ms, tolerance: 8px) and the touchmove path are covered too.
 *
 * Touch events are dispatched via a CDP session because Playwright's
 * `page.touchscreen` only exposes `tap()` — it can't model the
 * press-hold-drag-release sequence the TouchSensor's `delay` requires.
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

async function touchDragTo(
  context: BrowserContext,
  page: Page,
  sourceTestId: string,
  targetTestId: string,
): Promise<void> {
  const source = page.getByTestId(sourceTestId);
  const target = page.getByTestId(targetTestId);
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  await source.scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);

  const sb = await source.boundingBox();
  const tb = await target.boundingBox();
  if (!sb || !tb) throw new Error("Missing bounding box for drag source/target");
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;

  // Drive raw touch events through CDP. dnd-kit's TouchSensor wires its
  // touchstart listener directly on the activator node and the touchmove
  // / touchend listeners on the document, so we just need a real
  // sequence the browser will dispatch as TouchEvents.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: sx, y: sy, id: 1 }],
  });

  // The TouchSensor is configured with `delay: 200, tolerance: 8`. We
  // must keep the finger essentially still for the full delay window —
  // any movement past 8px during this window cancels the activation.
  // Add a generous margin on top of the 200ms delay so a slow CI host
  // can't race the timer.
  await page.waitForTimeout(350);

  // Nudge past the activation distance to begin the drag, then walk to
  // the target in small steps so collision detection has a chance to
  // pick up the chip under the finger.
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: sx + 6, y: sy + 6, id: 1 }],
  });
  await page.waitForTimeout(40);

  const STEPS = 24;
  for (let i = 1; i <= STEPS; i++) {
    const x = sx + ((tx - sx) * i) / STEPS;
    const y = sy + ((ty - sy) * i) / STEPS;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.waitForTimeout(15);
  }

  // A final settle move directly on the target's center, then release.
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: tx, y: ty, id: 1 }],
  });
  await page.waitForTimeout(80);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test.describe("Mapping Rules · touch drag rule onto category (#226)", () => {
  test("touch-dragging a rule onto a category chip PATCHes its categoryId and toasts", async ({
    browser,
  }) => {
    const { email, password } = await createTestUser(
      "rule-drag-cat-touch-226",
      provisionedUserIds,
    );
    // Mobile-style context: enables TouchEvent dispatch end-to-end so
    // dnd-kit's TouchSensor activator listener actually fires. iPhone-ish
    // viewport gives us roughly the layout the touch user sees.
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 414, height: 896 },
      deviceScaleFactor: 2,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    });
    const page = await context.newPage();

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
        pattern: `TOUCHDRAG-${Math.random().toString(36).slice(2, 8)}`,
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

    const strip = page.getByTestId("category-drop-strip");
    await expect(strip).toBeVisible();
    await expect(page.getByTestId(`category-drop-${dining.id}`)).toBeVisible();
    await expect(page.getByTestId(`category-drop-${groceries.id}`)).toBeVisible();

    const ruleRow = page.getByTestId(`rule-row-${rule.id}`);
    await expect(ruleRow).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`rule-category-${rule.id}`)).toHaveText(
      /Dining & Coffee/i,
    );

    const patchPromise = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        new URL(req.url()).pathname === `/api/mapping-rules/${rule.id}`,
      { timeout: 15_000 },
    );
    const patchResponsePromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/mapping-rules/${rule.id}`,
      { timeout: 15_000 },
    );

    await touchDragTo(
      context,
      page,
      `rule-drag-${rule.id}`,
      `category-drop-${groceries.id}`,
    );

    const patchReq = await patchPromise;
    const patchRes = await patchResponsePromise;
    expect(patchRes.status()).toBe(200);
    const sentBody = JSON.parse(patchReq.postData() ?? "{}");
    expect(sentBody.categoryId).toBe(groceries.id);
    expect(typeof sentBody.pattern).toBe("string");
    expect(sentBody.pattern.length).toBeGreaterThan(0);
    expect(sentBody.matchType).toBe("contains");
    expect(sentBody.priority).toBe(99999);

    await expect(page.getByTestId(`rule-category-${rule.id}`)).toHaveText(
      /Groceries/i,
      { timeout: 10_000 },
    );
    await expect(page.getByText(/Rule reassigned/i).first()).toBeVisible({
      timeout: 10_000,
    });

    const persisted = await apiCall<Array<{ id: string; categoryId: string }>>(
      page,
      "GET",
      "/api/mapping-rules",
    );
    const persistedRow = persisted.find((r) => r.id === rule.id);
    expect(persistedRow?.categoryId).toBe(groceries.id);

    await context.close();
  });
});
