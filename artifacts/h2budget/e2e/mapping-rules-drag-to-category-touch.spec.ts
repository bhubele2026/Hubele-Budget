import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type Request,
} from "@playwright/test";
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
 *
 * The category chips are packed tightly in a wrap row, so a single
 * synthesized touch drag occasionally ends up resolved over a neighbour
 * chip (task #348). To stay deterministic we drive the gesture inside
 * `attemptTouchDragToCategory`, watch the PATCH that comes back, and if
 * it landed on the wrong chip we restore the rule via the API and try
 * again. Final assertions check the user-visible outcome (toast + chip
 * label) plus the wire shape of the PATCH that actually targeted the
 * intended category.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

type Category = { id: string; name: string };
type RuleSnapshot = {
  id: string;
  pattern: string;
  matchType: string;
  priority: number;
};
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

async function performTouchDrag(
  context: BrowserContext,
  page: Page,
  sourceTestId: string,
  targetTestId: string,
): Promise<void> {
  const source = page.getByTestId(sourceTestId);
  const target = page.getByTestId(targetTestId);
  await expect(source).toBeVisible();
  await expect(target).toBeAttached();

  // Make sure the source's activator is on screen for touchStart. The
  // target chip lives in the drop strip at the top of the rules card;
  // on a long rule list the strip is often scrolled out of view by the
  // time we want to drop, so we re-scroll the chip into view AFTER the
  // long-press has activated and re-measure before walking the finger
  // to it.
  await source.scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);

  const sb = await source.boundingBox();
  if (!sb) throw new Error("Missing bounding box for drag source");
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;

  // Drive raw touch events through CDP. dnd-kit's TouchSensor wires its
  // touchstart listener directly on the activator node and the touchmove
  // / touchend listeners on the document, so we just need a real
  // sequence the browser will dispatch as TouchEvents.
  const cdp = await context.newCDPSession(page);
  try {
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

    // Nudge past the activation distance to begin the drag.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: sx + 6, y: sy + 6, id: 1 }],
    });
    await page.waitForTimeout(40);

    // Now that the drag is live, scroll the target chip into view and
    // re-measure so the touch points we walk to are valid viewport
    // coordinates (and the chip is actually under the finger when we
    // release). dnd-kit listens for touchmove on the document, so a
    // post-scroll touchmove updates its `over` state correctly.
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(80);
    const tb = await target.boundingBox();
    if (!tb) throw new Error("Missing bounding box for drag target");
    const tx = tb.x + tb.width / 2;
    const ty = tb.y + tb.height / 2;

    const STEPS = 24;
    // Walk from the post-nudge position to the (re-measured) target
    // center in small steps.
    const startX = sx + 6;
    const startY = sy + 6;
    for (let i = 1; i <= STEPS; i++) {
      const x = startX + ((tx - startX) * i) / STEPS;
      const y = startY + ((ty - startY) * i) / STEPS;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y, id: 1 }],
      });
      await page.waitForTimeout(15);
    }

    // A pair of settle moves directly on the target's center, then
    // release. Two settle ticks gives dnd-kit's pointer-tracked
    // collision detection an extra frame to mark the chip as `over`.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: tx, y: ty, id: 1 }],
    });
    await page.waitForTimeout(60);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: tx, y: ty, id: 1 }],
    });
    await page.waitForTimeout(60);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function attemptTouchDragToCategory(
  context: BrowserContext,
  page: Page,
  opts: {
    rule: RuleSnapshot;
    targetCategoryId: string;
    restoreCategoryId: string;
    maxAttempts?: number;
  },
): Promise<{ patchReq: Request; attempts: number }> {
  const { rule, targetCategoryId, restoreCategoryId } = opts;
  const maxAttempts = opts.maxAttempts ?? 5;
  const patchPath = `/api/mapping-rules/${rule.id}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const patchPromise = page
      .waitForRequest(
        (req) =>
          req.method() === "PATCH" &&
          new URL(req.url()).pathname === patchPath,
        { timeout: 8_000 },
      )
      .catch(() => null);

    await performTouchDrag(
      context,
      page,
      `rule-drag-${rule.id}`,
      `category-drop-${targetCategoryId}`,
    );

    const req = await patchPromise;
    if (!req) {
      await page.waitForTimeout(200);
      continue;
    }
    const sent = JSON.parse(req.postData() ?? "{}");
    if (sent.categoryId === targetCategoryId) {
      return { patchReq: req, attempts: attempt };
    }
    await page
      .waitForResponse(
        (res) =>
          res.request().method() === "PATCH" &&
          new URL(res.url()).pathname === patchPath,
        { timeout: 8_000 },
      )
      .catch(() => null);
    await apiCall(page, "PATCH", patchPath, {
      pattern: rule.pattern,
      matchType: rule.matchType,
      categoryId: restoreCategoryId,
      priority: rule.priority,
    });
    await page.waitForTimeout(300);
    await expect(page.getByTestId(`rule-category-${rule.id}`)).toHaveText(
      /./,
      { timeout: 5_000 },
    );
  }
  throw new Error(
    `Touch drag never resolved onto category ${targetCategoryId} after ${maxAttempts} attempts`,
  );
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

    const rule = await apiCall<{
      id: string;
      categoryId: string | null;
      pattern: string;
      matchType: string;
      priority: number;
    }>(page, "POST", "/api/mapping-rules", {
      pattern: `TOUCHDRAG-${Math.random().toString(36).slice(2, 8)}`,
      matchType: "contains",
      categoryId: dining.id,
      priority: 99999,
    });
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

    const ruleSnapshot: RuleSnapshot = {
      id: rule.id,
      pattern: rule.pattern,
      matchType: rule.matchType,
      priority: rule.priority,
    };
    const { patchReq } = await attemptTouchDragToCategory(context, page, {
      rule: ruleSnapshot,
      targetCategoryId: groceries.id,
      restoreCategoryId: dining.id,
    });

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
