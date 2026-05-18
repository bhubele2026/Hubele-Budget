import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * Task #699 — end-to-end coverage for the dnd-kit drag-and-drop
 * reorder added in #696. The existing #692 spec exercises the
 * up/down arrow buttons; this one drives the actual pointer-drag
 * path (sensors + SortableContext + arrayMove + 10-stride sortOrder
 * rewrite) so a regression on the drag wiring fails fast.
 *
 * Strategy: seed three manual envelopes A, B, C with distinct
 * sortOrders, drag A past B and C using pointer events on the
 * dedicated `drag-handle-${id}` button, then reload and assert
 * the rendered row order is [B, C, A].
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
      `API ${method} ${path} failed (${result.status}): ${JSON.stringify(
        result.body,
      )}`,
    );
  }
  return result.body;
}

async function seedEnvelope(
  page: Page,
  name: string,
  sortOrder: number,
): Promise<{ id: string; name: string }> {
  return apiCall<{ id: string; name: string }>(
    page,
    "POST",
    "/api/budget/categories",
    {
      name,
      kind: "expense",
      groupName: "My budget",
      sourceKind: "manual",
      sortOrder,
    },
  );
}

async function readRowOrder(
  page: Page,
  cardTestId: string,
): Promise<string[]> {
  return page
    .getByTestId(cardTestId)
    .locator('[data-testid^="row-budget-"]')
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.testid ?? ""),
    );
}

/**
 * Drag the `from` handle past the `to` row using pointer events at
 * dnd-kit's PointerSensor activation threshold (8px by default).
 * We dispatch on the page to clear the "5px move before drag starts"
 * gate, then animate steps between the two row centers.
 */
async function dragRowOver(
  page: Page,
  fromHandleTestId: string,
  toRowTestId: string,
): Promise<void> {
  const handle = page.getByTestId(fromHandleTestId);
  const target = page.getByTestId(toRowTestId);
  await handle.scrollIntoViewIfNeeded();
  const fromBox = await handle.boundingBox();
  const toBox = await target.boundingBox();
  if (!fromBox || !toBox) {
    throw new Error(
      `bounding box missing: from=${JSON.stringify(
        fromBox,
      )} to=${JSON.stringify(toBox)}`,
    );
  }
  const startX = fromBox.x + fromBox.width / 2;
  const startY = fromBox.y + fromBox.height / 2;
  const endX = toBox.x + toBox.width / 2;
  // Drop slightly past the target's vertical center so dnd-kit picks
  // the "place after" side of the over-row when moving down.
  const endY = toBox.y + toBox.height * 0.75;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Small kick to clear PointerSensor activation distance.
  await page.mouse.move(startX, startY + 15, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 20 });
  await page.mouse.up();
}

test.describe("Budget My-budget drag-reorder (#699)", () => {
  test("dragging the top envelope past two neighbors persists the new order across reload", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "budget-my-budget-drag-reorder-699",
      provisionedUserIds,
    );

    await signInAndOpen(page, email, password, "/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    // Trigger lazy seed-defaults so the category groups exist.
    await apiCall<unknown[]>(page, "GET", "/api/budget/categories");

    const suffix = Math.random().toString(36).slice(2, 7);
    const catA = await seedEnvelope(page, `Drag A ${suffix}`, 10);
    const catB = await seedEnvelope(page, `Drag B ${suffix}`, 20);
    const catC = await seedEnvelope(page, `Drag C ${suffix}`, 30);

    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });

    const cardId = "group-My budget";
    await expect(page.getByTestId(`row-budget-${catA.id}`)).toBeVisible({
      timeout: 15_000,
    });

    // Initial order: A above B above C.
    expect(await readRowOrder(page, cardId)).toEqual([
      `row-budget-${catA.id}`,
      `row-budget-${catB.id}`,
      `row-budget-${catC.id}`,
    ]);

    // Drag A's handle past C so the resulting order is [B, C, A].
    await dragRowOver(
      page,
      `drag-handle-${catA.id}`,
      `row-budget-${catC.id}`,
    );

    // Wait for the optimistic reorder + bulk PATCH to settle, then
    // poll the rendered order rather than racing the network.
    await expect
      .poll(async () => readRowOrder(page, cardId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toEqual([
        `row-budget-${catB.id}`,
        `row-budget-${catC.id}`,
        `row-budget-${catA.id}`,
      ]);

    // Hard reload — the new order must come back from the server, not
    // just from the in-memory dnd-kit state.
    await page.goto("/budget");
    await expect(page.getByRole("heading", { name: /^budget$/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId(`row-budget-${catA.id}`)).toBeVisible({
      timeout: 15_000,
    });
    expect(await readRowOrder(page, cardId)).toEqual([
      `row-budget-${catB.id}`,
      `row-budget-${catC.id}`,
      `row-budget-${catA.id}`,
    ]);
  });
});
