import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #699 — the dnd-kit drag-to-reorder path
 * shipped in task #696. The existing #692 spec only exercises the
 * up/down neighbor-swap buttons, which take a completely different
 * code path (handleMoveCategory, a swap of two sortOrder values). The
 * drag flow runs through `handleDragReorder`, which calls dnd-kit's
 * arrayMove and then PATCHes every line in the group with a fresh
 * 10-stride sortOrder (10, 20, 30, …). A regression in either the
 * SortableContext wiring or the 10-stride rewrite would silently leave
 * the buttons working while drag is broken — hence this spec.
 *
 * The Budget page renders two independent DndContexts:
 *
 *   1. The standard groups card (one DndContext per bill-backed group).
 *   2. The "My budget" card (a single DndContext for the manual bucket).
 *
 * We cover both so a regression confined to either rendering path is
 * caught. To stay deterministic across re-runs we seed three categories
 * per group with sortOrder 1/2/3, drive a real pointer-drag from the
 * top row's `drag-handle-${categoryId}` past the bottom row, wait for
 * every PATCH /api/budget/categories/:id to settle, then reload and
 * assert the rendered order matches what arrayMove produced.
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
      if (!res.ok) return { ok: false, status: res.status, body: parsed };
      return { ok: true, status: res.status, body: parsed as T };
    },
    { method, path, body },
  );
  if (!result.ok) {
    throw new Error(
      `API ${method} ${path} failed (${result.status}): ${JSON.stringify(
        result.body,
      )}`,
    );
  }
  return result.body;
}

/**
 * Drive a real pointer-drag from the source drag handle to the target
 * drag handle. Mirrors the helper in mapping-rules-drag-to-category:
 * the PointerSensor on /budget has a 5px activation distance, so we
 * nudge the pointer past it before walking it to the target, then
 * settle directly on the target's center so dnd-kit's `over` state
 * resolves unambiguously to the target row before we release.
 */
async function dragHandle(
  page: Page,
  sourceCategoryId: string,
  targetCategoryId: string,
): Promise<void> {
  const source = page.getByTestId(`drag-handle-${sourceCategoryId}`);
  const target = page.getByTestId(`drag-handle-${targetCategoryId}`);
  await expect(source).toBeVisible();
  await expect(target).toBeAttached();

  // dnd-kit applies CSS transforms while rows settle after a previous
  // drag, which makes Playwright's stability-aware scrollIntoViewIfNeeded
  // time out. Use an instant programmatic scroll instead so we can grab
  // a stable bounding box right away.
  await source.evaluate((el) =>
    el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }),
  );
  await page.waitForTimeout(80);

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
  // Nudge past the PointerSensor's 5px activation distance.
  await page.mouse.move(sx, sy + 12, { steps: 6 });
  await page.waitForTimeout(80);

  // Measure target's bounding box BEFORE the drag activates — during
  // drag, verticalListSortingStrategy applies a CSS transform that
  // shifts non-active items, so the target's live box would lie about
  // its original DOM-flow position. We aim for the target's *original*
  // center and then nudge slightly past it in the drag direction so
  // closestCenter resolves unambiguously to the target row.
  const tb = await target.boundingBox();
  if (!tb) throw new Error("Missing bounding box for drag target");
  const tx = tb.x + tb.width / 2;
  const tCenter = tb.y + tb.height / 2;
  const goingDown = tCenter > sy;
  // A small nudge past the target's center is enough to make dnd-kit's
  // closestCenter prefer the slot beyond it (so dragging A past C lands
  // A *after* C, producing [B, C, A] rather than [B, A, C]).
  const nudge = tb.height * 0.6;
  const ty = tCenter + (goingDown ? nudge : -nudge);

  await page.mouse.move(tx, tCenter, { steps: 30 });
  await page.waitForTimeout(120);
  await page.mouse.move(tx, ty, { steps: 6 });
  await page.waitForTimeout(120);
  await page.mouse.up();
}

async function seedCategory(
  page: Page,
  name: string,
  groupName: string,
  sortOrder: number,
): Promise<{ id: string }> {
  return apiCall<{ id: string }>(page, "POST", "/api/budget/categories", {
    name,
    kind: "expense",
    groupName,
    sourceKind: "manual",
    sortOrder,
  });
}

async function renderedOrder(
  card: ReturnType<Page["getByTestId"]>,
): Promise<string[]> {
  return card
    .locator('[data-testid^="row-budget-"]')
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.testid ?? ""),
    );
}

test.describe("Budget drag-to-reorder (#699)", () => {
  test("dragging the top envelope past the bottom rewrites sortOrder and survives reload — standard group + My budget", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-drag-reorder-699",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Force the lazy seed-defaults pass so the standard "Bills" group
    // exists before we post our own categories into it.
    await apiCall<unknown[]>(page, "GET", "/api/budget/categories");

    const suffix = Math.random().toString(36).slice(2, 7);

    // --- Seed three rows in the standard "Bills" group ---------------
    const billsGroup = "Bills";
    const billsA = await seedCategory(page, `E2E Bills A ${suffix}`, billsGroup, 1);
    const billsB = await seedCategory(page, `E2E Bills B ${suffix}`, billsGroup, 2);
    const billsC = await seedCategory(page, `E2E Bills C ${suffix}`, billsGroup, 3);

    // --- Seed three rows in the "My budget" card --------------------
    const myGroup = "My budget";
    const myA = await seedCategory(page, `E2E My A ${suffix}`, myGroup, 1);
    const myB = await seedCategory(page, `E2E My B ${suffix}`, myGroup, 2);
    const myC = await seedCategory(page, `E2E My C ${suffix}`, myGroup, 3);

    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const billsCard = page.getByTestId(`group-${billsGroup}`);
    const myCard = page.getByTestId(`group-${myGroup}`);

    // Wait for our seeded rows to render in both cards.
    await expect(billsCard.getByTestId(`row-budget-${billsA.id}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(billsCard.getByTestId(`row-budget-${billsC.id}`)).toBeVisible();
    await expect(myCard.getByTestId(`row-budget-${myA.id}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(myCard.getByTestId(`row-budget-${myC.id}`)).toBeVisible();

    // Confirm the initial order matches the sortOrder we seeded so the
    // post-drag assertion below is unambiguous. Other auto-seeded
    // categories may share the "Bills" group; we filter our own rows.
    const ourBillsIds = [
      `row-budget-${billsA.id}`,
      `row-budget-${billsB.id}`,
      `row-budget-${billsC.id}`,
    ];
    const billsBefore = (await renderedOrder(billsCard)).filter((id) =>
      ourBillsIds.includes(id),
    );
    expect(billsBefore).toEqual(ourBillsIds);

    const ourMyIds = [
      `row-budget-${myA.id}`,
      `row-budget-${myB.id}`,
      `row-budget-${myC.id}`,
    ];
    const myBefore = (await renderedOrder(myCard)).filter((id) =>
      ourMyIds.includes(id),
    );
    expect(myBefore).toEqual(ourMyIds);

    // --- Drag the standard-group top row (A) past the bottom (C) ----
    // arrayMove([A,B,C], 0, 2) → [B, C, A]. The handler rewrites every
    // line in the group to 10/20/30/…, so the only ids whose sortOrder
    // changes are the rows that moved past each other.
    const billsPatchPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname ===
          `/api/budget/categories/${billsA.id}` &&
        res.ok(),
      { timeout: 10_000 },
    );
    await dragHandle(page, billsA.id, billsC.id);
    await billsPatchPromise;

    // Wait for the live list to reflect the drop before reloading,
    // so we know all the PATCHes in the Promise.all have settled.
    await expect
      .poll(
        async () =>
          (await renderedOrder(billsCard)).filter((id) =>
            ourBillsIds.includes(id),
          ),
        { timeout: 10_000, intervals: [250, 500, 1000] },
      )
      .toEqual([
        `row-budget-${billsB.id}`,
        `row-budget-${billsC.id}`,
        `row-budget-${billsA.id}`,
      ]);

    // --- Drag the My-budget top row (D) past the bottom (F) ---------
    const myPatchPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/budget/categories/${myA.id}` &&
        res.ok(),
      { timeout: 10_000 },
    );
    await dragHandle(page, myA.id, myC.id);
    await myPatchPromise;

    await expect
      .poll(
        async () =>
          (await renderedOrder(myCard)).filter((id) => ourMyIds.includes(id)),
        { timeout: 10_000, intervals: [250, 500, 1000] },
      )
      .toEqual([
        `row-budget-${myB.id}`,
        `row-budget-${myC.id}`,
        `row-budget-${myA.id}`,
      ]);

    // --- Reload and confirm the new sortOrder survived --------------
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const billsCardAfter = page.getByTestId(`group-${billsGroup}`);
    const myCardAfter = page.getByTestId(`group-${myGroup}`);
    await expect(
      billsCardAfter.getByTestId(`row-budget-${billsA.id}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      myCardAfter.getByTestId(`row-budget-${myA.id}`),
    ).toBeVisible({ timeout: 15_000 });

    const billsAfterReload = (await renderedOrder(billsCardAfter)).filter(
      (id) => ourBillsIds.includes(id),
    );
    expect(billsAfterReload).toEqual([
      `row-budget-${billsB.id}`,
      `row-budget-${billsC.id}`,
      `row-budget-${billsA.id}`,
    ]);

    const myAfterReload = (await renderedOrder(myCardAfter)).filter((id) =>
      ourMyIds.includes(id),
    );
    expect(myAfterReload).toEqual([
      `row-budget-${myB.id}`,
      `row-budget-${myC.id}`,
      `row-budget-${myA.id}`,
    ]);

    // Belt-and-suspenders: confirm the persisted sortOrders form the
    // 10-stride pattern the handler is supposed to write (10, 20, 30, …)
    // — a regression that PATCHes only the moved row would leave the
    // other rows on their seeded 1/2/3 values even if the visible order
    // happens to look right.
    const allCats = await apiCall<
      Array<{ id: string; sortOrder: number; groupName: string }>
    >(page, "GET", "/api/budget/categories");
    const byId = new Map(allCats.map((c) => [c.id, c]));
    expect(byId.get(billsB.id)?.sortOrder).toBe(10);
    expect(byId.get(billsC.id)?.sortOrder).toBe(20);
    expect(byId.get(billsA.id)?.sortOrder).toBe(30);
    expect(byId.get(myB.id)?.sortOrder).toBe(10);
    expect(byId.get(myC.id)?.sortOrder).toBe(20);
    expect(byId.get(myA.id)?.sortOrder).toBe(30);
  });
});
