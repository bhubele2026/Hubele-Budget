import { test, expect, type Page, type Request } from "@playwright/test";
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
 * a multi-step move to the target, and a release.
 *
 * The category chips are packed tightly in a wrap row, so a single
 * synthesized drag occasionally ends up resolved over a neighbour chip
 * and the resulting PATCH targets the wrong category id (task #348).
 * To stay deterministic we drive the drag inside `attemptDragToCategory`,
 * watch the PATCH that comes back, and if it landed on the wrong chip
 * we restore the rule via the API and retry. The final assertions check
 * the user-visible outcome (toast + chip label) plus the wire shape of
 * the PATCH that actually targeted the intended category.
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

async function performDrag(
  page: Page,
  sourceTestId: string,
  targetTestId: string,
): Promise<void> {
  const source = page.getByTestId(sourceTestId);
  const target = page.getByTestId(targetTestId);
  await expect(source).toBeVisible();
  await expect(target).toBeAttached();

  // Make sure the source is on screen so dispatchEvent + mouse.down can
  // hit its activator. The target chip lives in the drop strip at the
  // top of the rules card; on a tall rule list the strip is often
  // scrolled off-screen by the time we need to drop, so we re-scroll
  // the chip into view AFTER the drag has activated and re-measure.
  await source.scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);

  const sb = await source.boundingBox();
  if (!sb) throw new Error("Missing bounding box for drag source");
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;

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
  // Nudge past the PointerSensor's 4px activation distance.
  await page.mouse.move(sx + 12, sy + 12, { steps: 6 });
  await page.waitForTimeout(80);

  // Scroll the target chip into view now that the drag is live, then
  // re-measure so the cursor coordinates we move to are inside the
  // current viewport (and the chip is actually under the pointer when
  // we release). dnd-kit listens for pointermove on the document, so
  // moving the pointer after a programmatic scroll updates its `over`
  // state correctly.
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  const tb = await target.boundingBox();
  if (!tb) throw new Error("Missing bounding box for drag target");
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;

  // Walk to the target in two passes — a long approach plus a short
  // settle directly on the chip's center — so the pointer's last known
  // position is unambiguously inside the target chip when we release.
  await page.mouse.move(tx, ty, { steps: 30 });
  await page.waitForTimeout(60);
  await page.mouse.move(tx, ty, { steps: 4 });
  await page.waitForTimeout(60);
  await page.mouse.up();
}

/**
 * Drag the rule onto the desired category chip and resolve with the
 * PATCH that the drop produced. Retries on flaky mis-targeting (a
 * synthesized gesture occasionally resolves to a neighbour chip): when
 * the observed PATCH targets the wrong category, we restore the rule
 * via the API and try the gesture again, up to `maxAttempts` times.
 *
 * Returns the matching PATCH request so callers can assert on the wire
 * shape, plus an `attempts` count for diagnostics.
 */
async function attemptDragToCategory(
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
        { timeout: 6_000 },
      )
      .catch(() => null);

    await performDrag(
      page,
      `rule-drag-${rule.id}`,
      `category-drop-${targetCategoryId}`,
    );

    const req = await patchPromise;
    if (!req) {
      // Sensor never fired — give the page a beat and try again.
      await page.waitForTimeout(150);
      continue;
    }
    const sent = JSON.parse(req.postData() ?? "{}");
    if (sent.categoryId === targetCategoryId) {
      return { patchReq: req, attempts: attempt };
    }
    // Wrong chip. Wait for the bad PATCH to settle, then restore the
    // rule's category via the API so the next drag starts from a known
    // state, and retry.
    await page
      .waitForResponse(
        (res) =>
          res.request().method() === "PATCH" &&
          new URL(res.url()).pathname === patchPath,
        { timeout: 6_000 },
      )
      .catch(() => null);
    await apiCall(page, "PATCH", patchPath, {
      pattern: rule.pattern,
      matchType: rule.matchType,
      categoryId: restoreCategoryId,
      priority: rule.priority,
    });
    // Give React Query a chance to refetch so the on-screen category
    // label reflects the restored value before the next attempt.
    await page.waitForTimeout(250);
    await expect(page.getByTestId(`rule-category-${rule.id}`)).toHaveText(
      /./,
      { timeout: 5_000 },
    );
  }
  throw new Error(
    `Drag never resolved onto category ${targetCategoryId} after ${maxAttempts} attempts`,
  );
}

test.describe("Mapping Rules · drag rule onto category (#202)", () => {
  test("dragging a rule onto a category chip PATCHes its categoryId and toasts", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "rule-drag-cat-202",
      provisionedUserIds,
    );

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

    const rule = await apiCall<{
      id: string;
      categoryId: string | null;
      pattern: string;
      matchType: string;
      priority: number;
    }>(page, "POST", "/api/mapping-rules", {
      pattern: `DRAGTEST-${Math.random().toString(36).slice(2, 8)}`,
      matchType: "contains",
      categoryId: dining.id,
      priority: 99999,
    });
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

    const ruleSnapshot: RuleSnapshot = {
      id: rule.id,
      pattern: rule.pattern,
      matchType: rule.matchType,
      priority: rule.priority,
    };
    const { patchReq } = await attemptDragToCategory(page, {
      rule: ruleSnapshot,
      targetCategoryId: groceries.id,
      restoreCategoryId: dining.id,
    });

    // The PATCH endpoint requires the full MappingRuleInput shape, so the
    // client must echo pattern + matchType + priority alongside the new
    // category — guard against a regression that drops them.
    const sentBody = JSON.parse(patchReq.postData() ?? "{}");
    expect(sentBody.categoryId).toBe(groceries.id);
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

    // Dropping onto the same category should be a no-op: the client-side
    // guard short-circuits when `rule.categoryId === newCategoryId`, so
    // no PATCH targeting groceries should fire. Because the synthesized
    // gesture can occasionally resolve to a neighbour chip, we tolerate
    // a stray PATCH to a *different* category id by restoring via the
    // API and retrying — but a PATCH whose body still names groceries
    // would be a real regression of the no-op guard.
    const NO_OP_ATTEMPTS = 3;
    let noOpVerified = false;
    for (let attempt = 1; attempt <= NO_OP_ATTEMPTS; attempt++) {
      let strayPatch: Request | null = null;
      const listener = (req: Request) => {
        if (
          req.method() === "PATCH" &&
          new URL(req.url()).pathname === `/api/mapping-rules/${rule.id}`
        ) {
          strayPatch = req;
        }
      };
      page.on("request", listener);
      await performDrag(
        page,
        `rule-drag-${rule.id}`,
        `category-drop-${groceries.id}`,
      );
      await page.waitForTimeout(700);
      page.off("request", listener);

      if (!strayPatch) {
        noOpVerified = true;
        break;
      }
      const strayBody = JSON.parse(
        (strayPatch as Request).postData() ?? "{}",
      );
      // If the (mis-targeted) PATCH body claims the category is still
      // groceries, the client guard is broken — fail loudly.
      expect(strayBody.categoryId).not.toBe(groceries.id);
      // Otherwise it landed on a neighbour chip — restore + retry.
      await page
        .waitForResponse(
          (res) =>
            res.request().method() === "PATCH" &&
            new URL(res.url()).pathname === `/api/mapping-rules/${rule.id}`,
          { timeout: 6_000 },
        )
        .catch(() => null);
      await apiCall(page, "PATCH", `/api/mapping-rules/${rule.id}`, {
        pattern: ruleSnapshot.pattern,
        matchType: ruleSnapshot.matchType,
        categoryId: groceries.id,
        priority: ruleSnapshot.priority,
      });
      await page.waitForTimeout(250);
      await expect(page.getByTestId(`rule-category-${rule.id}`)).toHaveText(
        /Groceries/i,
        { timeout: 5_000 },
      );
    }
    expect(noOpVerified).toBe(true);
  });
});
