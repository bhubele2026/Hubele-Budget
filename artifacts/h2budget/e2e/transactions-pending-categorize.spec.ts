import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  categoriesTable,
  transactionsTable,
} from "@workspace/db";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
  provisionTestHousehold,
} from "./helpers/clerk";

/**
 * End-to-end coverage for task #740.
 *
 * The pinned "Pending" group at the top of /transactions historically
 * rendered a stripped-down row that omitted the categorize affordances
 * (no InlineCategoryPicker, no CategorizeChip, no BucketBubbles, no
 * Transfer pill). That forced users to wait days for Plaid to flip a
 * charge to "posted" before they could triage it into a bucket — by
 * which point their budget had already drifted. The PATCH endpoint has
 * always accepted categoryId / bucket flags on pending rows, so this
 * was a pure UI gap.
 *
 * This spec seeds a pending Plaid-sourced transaction directly via the
 * db client (the public POST /api/transactions body has no `pending`
 * field — pending rows only ever come from a Plaid sync), opens
 * /transactions, asserts the row lives inside [data-testid="group-pending"]
 * with the Categorize chip visible, clicks the chip to assign a real
 * category, and verifies (a) the chip flips to the InlineCategoryPicker
 * badge showing the chosen category, and (b) the server actually
 * persisted the category on the pending row.
 */

const provisionedUserIds: string[] = [];
const seededUserIds: string[] = [];

test.afterAll(async () => {
  for (const userId of seededUserIds) {
    try {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, userId));
    } catch {
      // best-effort
    }
  }
  await cleanupTestUsers(provisionedUserIds);
});

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

test.describe("Pending-row categorize affordances on /transactions (#740)", () => {
  test("a pending row shows the Categorize chip; clicking it assigns a category that persists on the same pending row", async ({
    browser,
  }) => {
    const { userId, email, password } = await createTestUser(
      "txn-pending-categorize-740",
      provisionedUserIds,
    );
    const householdId = await provisionTestHousehold(userId);
    seededUserIds.push(userId);

    const suffix = Math.random().toString(36).slice(2, 8);
    const today = todayISO();
    const description = `E2E-PEND-${suffix.toUpperCase()} STARBUCKS`;

    // Seed a pending Plaid-sourced row directly. `pending: true` is
    // what makes the row land in the pinned Pending group on
    // /transactions (driven by the client's `pendingItems` predicate).
    const [seeded] = await db
      .insert(transactionsTable)
      .values({
        userId,
        householdId,
        occurredOn: today,
        occurredAt: new Date(`${today}T15:00:00Z`).toISOString(),
        description,
        amount: "-5.25",
        source: "plaid:chase",
        plaidTransactionId: `e2e-pend-${suffix}`,
        pending: true,
      })
      .returning();

    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAndOpen(page, email, password, "/transactions");
    await expect(
      page.getByRole("heading", { name: /^chase$/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Row is inside the pinned Pending group (the data-testid is unique
    // to the pinned-pending block — posted-day groups are keyed by date).
    const pendingGroup = page.getByTestId("group-pending");
    await expect(pendingGroup).toBeVisible({ timeout: 15_000 });
    const row = pendingGroup.getByTestId(`row-tx-${seeded.id}`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-pending", "true");

    // Categories are lazily provisioned the first time the budget
    // endpoint is hit, which the /transactions page does on mount.
    // Poll the db (instead of a single-shot query) so a slow first
    // provision doesn't flake the spec — the page may have rendered
    // the pending row before the parallel categories request settled.
    const deadline = Date.now() + 10_000;
    let allCategories: Array<{ id: string; name: string }> = [];
    while (Date.now() < deadline) {
      allCategories = await db
        .select({ id: categoriesTable.id, name: categoriesTable.name })
        .from(categoriesTable)
        .where(eq(categoriesTable.userId, userId));
      if (allCategories.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(allCategories.length).toBeGreaterThan(0);
    const targetCategory =
      allCategories.find((c) => /grocer/i.test(c.name)) ??
      allCategories.find(
        (c) => !/transfer|ignore|uncategorized/i.test(c.name),
      ) ??
      allCategories[0];

    // Pre-state: no category badge, but the Categorize/Other… popover
    // trigger is present. CategorizeChip always renders the
    // `badge-uncategorized-<id>` popover trigger — whether or not the
    // description happens to hit a heuristic suggestion — so the testid
    // is a stable handle independent of the suggestion path.
    await expect(
      row.getByTestId(`badge-category-${seeded.id}`),
    ).toHaveCount(0);
    const pickerTrigger = row.getByTestId(`badge-uncategorized-${seeded.id}`);
    await expect(pickerTrigger).toBeVisible();

    const patchPromise = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        new URL(res.url()).pathname === `/api/transactions/${seeded.id}`,
      { timeout: 10_000 },
    );
    await pickerTrigger.click();
    // Command items are rendered by the cmdk library with role="option".
    // The "All categories" group always includes every category, so
    // `.first()` deterministically picks the entry from that group
    // (which may also appear duplicated in a "Suggested" group when
    // the description hits a heuristic match).
    await page
      .getByRole("option", { name: targetCategory.name, exact: true })
      .first()
      .click();

    const patchRes = await patchPromise;
    expect(patchRes.status()).toBe(200);

    // Post-state: the chosen category badge appears in place on the
    // same pending row (the row is still inside the pinned Pending
    // group — assigning a category must not graduate it to the
    // posted day-groups).
    const assignedBadge = pendingGroup.getByTestId(
      `badge-category-${seeded.id}`,
    );
    await expect(assignedBadge).toBeVisible({ timeout: 5_000 });
    await expect(assignedBadge).toHaveText(targetCategory.name);
    await expect(row).toHaveAttribute("data-pending", "true");

    // Server-side persistence — the category really landed on the
    // pending row (and the pending flag was preserved).
    const [persisted] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, seeded.id));
    expect(persisted.categoryId).toBe(targetCategory.id);
    expect(persisted.pending).toBe(true);

    await context.close();
  });
});
