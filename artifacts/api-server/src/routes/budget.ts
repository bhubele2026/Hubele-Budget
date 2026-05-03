import { Router, type IRouter } from "express";
import { and, eq, sql, asc, desc, lt, inArray, isNull, notInArray } from "drizzle-orm";
import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  mappingRulesTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateCategoryBody,
  DeleteCategoryParams,
  GetBudgetMonthParams,
  UpsertBudgetLineBody,
} from "@workspace/api-zod";
import {
  BUDGET_CATEGORY_MIGRATION_MAP,
  SEED_CATEGORIES,
  SEED_GROUP_ORDER,
  SEED_MONTH,
  SEED_RECURRING_ITEMS,
} from "../lib/budgetSeed";
import {
  SEED_MAPPING_RULES,
  SEED_MAPPING_PRIORITY,
} from "../lib/mappingSeed";
import { expandItem, parseISO, addDays } from "../lib/cashSignal";

const router: IRouter = Router();

const DEBT_GROUP = "Debt — Minimum Payments";
const DEBT_GROUP_BASE_SORT =
  (SEED_GROUP_ORDER.indexOf(DEBT_GROUP) >= 0
    ? SEED_GROUP_ORDER.indexOf(DEBT_GROUP)
    : 99) * 100;

// Keep budget_categories with sourceKind='auto_debts' in sync with the user's
// active rows in the Debts tracker, and keep the budget line for each one
// updated to the debt's current minimum payment for the requested month.
// Also backfills `category_id` on existing "Payment — <debt name>" transactions
// so the budget's Actual column reflects payments made to each debt.
async function syncAutoDebtCategories(
  userId: string,
  monthStart: string,
): Promise<void> {
  const debts = await db
    .select()
    .from(debtsTable)
    .where(
      and(eq(debtsTable.userId, userId), eq(debtsTable.status, "active")),
    )
    .orderBy(desc(debtsTable.apr), asc(debtsTable.name));

  const activeIds = debts.map((d) => d.id);

  // 1. Drop stale auto_debts categories: legacy placeholder/seed rows with no
  //    debt link, plus any whose linked debt is no longer active/exists.
  await db
    .delete(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.userId, userId),
        eq(budgetCategoriesTable.sourceKind, "auto_debts"),
        isNull(budgetCategoriesTable.debtId),
      ),
    );
  if (activeIds.length > 0) {
    await db
      .delete(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.userId, userId),
          eq(budgetCategoriesTable.sourceKind, "auto_debts"),
          notInArray(budgetCategoriesTable.debtId, activeIds),
        ),
      );
  } else {
    await db
      .delete(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.userId, userId),
          eq(budgetCategoriesTable.sourceKind, "auto_debts"),
        ),
      );
  }

  if (debts.length === 0) return;

  // 2. Ensure the budget month row exists so we can attach lines to it.
  await db
    .insert(budgetMonthsTable)
    .values({ userId, monthStart })
    .onConflictDoNothing();

  // 3. Upsert one auto_debts category per active debt and the matching line
  //    for the requested month with planned = debt.minPayment.
  const existingCats = await db
    .select()
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.userId, userId),
        eq(budgetCategoriesTable.sourceKind, "auto_debts"),
      ),
    );
  const catByDebtId = new Map(existingCats.map((c) => [c.debtId!, c]));

  for (let i = 0; i < debts.length; i++) {
    const d = debts[i]!;
    const sortOrder = DEBT_GROUP_BASE_SORT + i;
    let catId: string;
    const cur = catByDebtId.get(d.id);
    if (!cur) {
      const [row] = await db
        .insert(budgetCategoriesTable)
        .values({
          userId,
          name: d.name,
          kind: "expense",
          groupName: DEBT_GROUP,
          sourceKind: "auto_debts",
          sortOrder,
          debtId: d.id,
        })
        .onConflictDoNothing({
          target: [budgetCategoriesTable.userId, budgetCategoriesTable.debtId],
        })
        .returning();
      if (!row) {
        // Re-read in case of a concurrent insert.
        const [existing] = await db
          .select()
          .from(budgetCategoriesTable)
          .where(
            and(
              eq(budgetCategoriesTable.userId, userId),
              eq(budgetCategoriesTable.debtId, d.id),
            ),
          );
        if (!existing) continue;
        catId = existing.id;
      } else {
        catId = row.id;
      }
    } else {
      catId = cur.id;
      if (
        cur.name !== d.name ||
        cur.sortOrder !== sortOrder ||
        cur.groupName !== DEBT_GROUP ||
        cur.kind !== "expense"
      ) {
        await db
          .update(budgetCategoriesTable)
          .set({
            name: d.name,
            sortOrder,
            groupName: DEBT_GROUP,
            kind: "expense",
          })
          .where(eq(budgetCategoriesTable.id, cur.id));
      }
    }

    await db
      .insert(budgetLinesTable)
      .values({
        userId,
        monthStart,
        categoryId: catId,
        plannedAmount: d.minPayment,
        note: "Auto-pulled from Debt Tracker",
      })
      .onConflictDoUpdate({
        target: [
          budgetLinesTable.userId,
          budgetLinesTable.monthStart,
          budgetLinesTable.categoryId,
        ],
        set: { plannedAmount: d.minPayment },
      });

    // Backfill categoryId on payment transactions created by /debts/:id/payments
    // so the budget's Actual column shows what's been paid this month.
    await db
      .update(transactionsTable)
      .set({ categoryId: catId })
      .where(
        and(
          eq(transactionsTable.userId, userId),
          isNull(transactionsTable.categoryId),
          sql`${transactionsTable.description} LIKE ${`Payment — ${d.name}%`}`,
        ),
      );
  }
}

// One-time per-user consolidation of the legacy ~45-category budget seed
// into the new ~22-category list (task #65). Idempotent: gated by a flag in
// `settings.preferences.budgetCategoriesV2`. Re-runs are safe — the mapping
// is applied only when an old category still exists.
//
// For each old → new mapping:
//   - Find/create the new target category (matching the new SEED metadata)
//   - Sum old budget_lines.planned_amount into the new line per month
//   - Re-point transactions.category_id, recurring_items.category_id,
//     mapping_rules.category_id, and avalanche_settings.extra_budget_category_id
//   - Delete the old category
// For categories that stay (same name), we also refresh group_name and
// sort_order to match the new seed so the UI groups them correctly.
async function migrateBudgetCategoriesV2(userId: string): Promise<void> {
  // Check the flag first.
  const [s] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId));
  const prefs = (s?.preferences as Record<string, unknown> | null) ?? null;
  if (prefs && prefs.budgetCategoriesV2 === true) return;

  await db.transaction(async (tx) => {
    const cats = await tx
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, userId));
    const byName = new Map(cats.map((c) => [c.name, c]));

    // Build sortOrder lookup from the new seed.
    const sortOrderByGroup = new Map<string, number>();
    SEED_GROUP_ORDER.forEach((g, i) => sortOrderByGroup.set(g, i * 100));
    const seedByName = new Map(SEED_CATEGORIES.map((s) => [s.name, s]));
    const seedIndex = new Map(SEED_CATEGORIES.map((s, i) => [s.name, i]));

    // Helper: find or create the new target category by name with seed metadata.
    const ensureCategory = async (newName: string) => {
      let cur = byName.get(newName);
      if (cur) return cur;
      const seed = seedByName.get(newName);
      const groupName = seed?.groupName ?? "Other";
      const kind = seed?.kind ?? "expense";
      const sourceKind = seed?.sourceKind ?? "manual";
      const groupBase = sortOrderByGroup.get(groupName) ?? 9999;
      const sortOrder = groupBase + (seedIndex.get(newName) ?? 0);
      const [row] = await tx
        .insert(budgetCategoriesTable)
        .values({
          userId,
          name: newName,
          kind,
          groupName,
          sourceKind,
          sortOrder,
        })
        .onConflictDoUpdate({
          target: [budgetCategoriesTable.userId, budgetCategoriesTable.name],
          set: { groupName, sortOrder },
        })
        .returning();
      if (row) byName.set(row.name, row);
      return row!;
    };

    // 1. Process every old → new mapping where the old category still exists.
    for (const [oldName, newName] of Object.entries(
      BUDGET_CATEGORY_MIGRATION_MAP,
    )) {
      const oldCat = byName.get(oldName);
      if (!oldCat) continue;
      if (oldName === newName) continue;
      const newCat = await ensureCategory(newName);
      if (!newCat || newCat.id === oldCat.id) continue;

      // Re-point references on tables that hold category_id.
      await tx
        .update(transactionsTable)
        .set({ categoryId: newCat.id })
        .where(
          and(
            eq(transactionsTable.userId, userId),
            eq(transactionsTable.categoryId, oldCat.id),
          ),
        );

      await tx
        .update(recurringItemsTable)
        .set({ categoryId: newCat.id })
        .where(
          and(
            eq(recurringItemsTable.userId, userId),
            eq(recurringItemsTable.categoryId, oldCat.id),
          ),
        );

      await tx
        .update(mappingRulesTable)
        .set({ categoryId: newCat.id })
        .where(
          and(
            eq(mappingRulesTable.userId, userId),
            eq(mappingRulesTable.categoryId, oldCat.id),
          ),
        );

      await tx
        .update(avalancheSettingsTable)
        .set({ extraBudgetCategoryId: newCat.id })
        .where(
          and(
            eq(avalancheSettingsTable.userId, userId),
            eq(avalancheSettingsTable.extraBudgetCategoryId, oldCat.id),
          ),
        );

      // Merge budget_lines: sum planned_amount per month into the new
      // category's line. We rely on the unique (userId, monthStart, categoryId)
      // index — for each month where both old and new lines exist we sum then
      // delete the old; where only old exists we re-point it.
      const oldLines = await tx
        .select()
        .from(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.userId, userId),
            eq(budgetLinesTable.categoryId, oldCat.id),
          ),
        );

      for (const ol of oldLines) {
        const [existingNewLine] = await tx
          .select()
          .from(budgetLinesTable)
          .where(
            and(
              eq(budgetLinesTable.userId, userId),
              eq(budgetLinesTable.monthStart, ol.monthStart),
              eq(budgetLinesTable.categoryId, newCat.id),
            ),
          );

        if (existingNewLine) {
          const summed = (
            (parseFloat(existingNewLine.plannedAmount) || 0) +
            (parseFloat(ol.plannedAmount) || 0)
          ).toFixed(2);
          const mergedNote =
            existingNewLine.note && ol.note && existingNewLine.note !== ol.note
              ? `${existingNewLine.note} · ${ol.note}`
              : existingNewLine.note ?? ol.note ?? null;
          await tx
            .update(budgetLinesTable)
            .set({ plannedAmount: summed, note: mergedNote })
            .where(eq(budgetLinesTable.id, existingNewLine.id));
          await tx
            .delete(budgetLinesTable)
            .where(eq(budgetLinesTable.id, ol.id));
        } else {
          await tx
            .update(budgetLinesTable)
            .set({ categoryId: newCat.id })
            .where(eq(budgetLinesTable.id, ol.id));
        }
      }

      // Finally delete the old, now-orphan category row.
      await tx
        .delete(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.id, oldCat.id));
      byName.delete(oldName);
    }

    // 2. Refresh group_name / sort_order on every category whose name matches
    //    the new seed (covers categories that stayed but moved groups).
    for (const seed of SEED_CATEGORIES) {
      const cur = byName.get(seed.name);
      if (!cur) continue;
      const groupBase = sortOrderByGroup.get(seed.groupName) ?? 9999;
      const sortOrder = groupBase + (seedIndex.get(seed.name) ?? 0);
      if (cur.groupName !== seed.groupName || cur.sortOrder !== sortOrder) {
        await tx
          .update(budgetCategoriesTable)
          .set({ groupName: seed.groupName, sortOrder })
          .where(eq(budgetCategoriesTable.id, cur.id));
      }
    }

    // 3. Set the flag so this only runs once per user.
    const nextPrefs = { ...(prefs ?? {}), budgetCategoriesV2: true };
    if (s) {
      await tx
        .update(settingsTable)
        .set({ preferences: nextPrefs })
        .where(eq(settingsTable.userId, userId));
    } else {
      await tx
        .insert(settingsTable)
        .values({ userId, preferences: nextPrefs })
        .onConflictDoUpdate({
          target: settingsTable.userId,
          set: { preferences: nextPrefs },
        });
    }
  });
}

router.get("/budget/categories", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, req.userId!))
    .orderBy(asc(budgetCategoriesTable.sortOrder), asc(budgetCategoriesTable.name));
  res.json(rows);
});

router.post(
  "/budget/categories",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = CreateCategoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const data = parsed.data;
    const [row] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: req.userId!,
        name: data.name,
        kind: data.kind ?? "expense",
        groupName: data.groupName ?? "Other",
        sourceKind: data.sourceKind ?? "manual",
        sortOrder: data.sortOrder ?? 0,
      })
      .onConflictDoUpdate({
        target: [budgetCategoriesTable.userId, budgetCategoriesTable.name],
        set: {
          kind: data.kind ?? "expense",
          ...(data.groupName ? { groupName: data.groupName } : {}),
          ...(data.sourceKind ? { sourceKind: data.sourceKind } : {}),
        },
      })
      .returning();
    res.status(201).json(row);
  },
);

router.delete(
  "/budget/categories/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteCategoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.id, params.data.id),
          eq(budgetCategoriesTable.userId, req.userId!),
        ),
      );
    res.sendStatus(204);
  },
);

router.post(
  "/budget/seed-defaults",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.userId, userId));
      const byName = new Map(existing.map((c) => [c.name, c]));

      let categoriesInserted = 0;
      const sortOrderByGroup = new Map<string, number>();
      SEED_GROUP_ORDER.forEach((g, i) => sortOrderByGroup.set(g, i * 100));

      for (let i = 0; i < SEED_CATEGORIES.length; i++) {
        const seed = SEED_CATEGORIES[i]!;
        const groupBase = sortOrderByGroup.get(seed.groupName) ?? 9999;
        const sortOrder = groupBase + i;
        const cur = byName.get(seed.name);
        if (!cur) {
          const [row] = await tx
            .insert(budgetCategoriesTable)
            .values({
              userId,
              name: seed.name,
              kind: seed.kind,
              groupName: seed.groupName,
              sourceKind: seed.sourceKind,
              sortOrder,
            })
            .returning();
          if (row) byName.set(row.name, row);
          categoriesInserted++;
        } else if (
          cur.groupName !== seed.groupName ||
          cur.sourceKind !== seed.sourceKind ||
          cur.kind !== seed.kind
        ) {
          // Backfill metadata for existing categories without overwriting their identity.
          await tx
            .update(budgetCategoriesTable)
            .set({
              groupName: seed.groupName,
              sourceKind: seed.sourceKind,
              kind: seed.kind,
              sortOrder,
            })
            .where(eq(budgetCategoriesTable.id, cur.id));
        }
      }

      // Ensure budget month row.
      await tx
        .insert(budgetMonthsTable)
        .values({ userId, monthStart: SEED_MONTH })
        .onConflictDoNothing();

      // Seed recurring items that back auto_bills budget categories.
      // Bills link by `categoryName` (so the recurring row name and category
      // name can differ); legacy/income items fall back to a name match.
      // Idempotent skip-by-name at the *group* level: if the user already
      // has any recurring row with a given seed name we leave the entire
      // group untouched (preserves user edits). Duplicate names in the seed
      // (e.g. two PlayStation Network rows on day 5 / day 16) are still
      // inserted atomically on a fresh user because the existence check
      // runs against the pre-seed table snapshot only.
      const existingRecurring = await tx
        .select()
        .from(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
      const existingRecurringNames = new Set(existingRecurring.map((r) => r.name));
      for (const r of SEED_RECURRING_ITEMS) {
        if (existingRecurringNames.has(r.name)) continue;
        const cat = byName.get(r.categoryName ?? r.name);
        await tx.insert(recurringItemsTable).values({
          userId,
          name: r.name,
          kind: r.kind,
          amount: r.amount,
          frequency: r.frequency,
          dayOfMonth: r.dayOfMonth,
          anchorDate: r.anchorDate,
          active: "true",
          categoryId: cat?.id ?? null,
        });
      }

      const existingLines = await tx
        .select()
        .from(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.userId, userId),
            eq(budgetLinesTable.monthStart, SEED_MONTH),
          ),
        );
      const lineByCat = new Map(existingLines.map((l) => [l.categoryId, l]));

      let linesInserted = 0;
      for (const seed of SEED_CATEGORIES) {
        const cat = byName.get(seed.name);
        if (!cat) continue;
        const cur = lineByCat.get(cat.id);
        if (!cur) {
          await tx
            .insert(budgetLinesTable)
            .values({
              userId,
              monthStart: SEED_MONTH,
              categoryId: cat.id,
              plannedAmount: seed.planned,
              note: seed.note,
            })
            .onConflictDoNothing({
              target: [
                budgetLinesTable.userId,
                budgetLinesTable.monthStart,
                budgetLinesTable.categoryId,
              ],
            });
          linesInserted++;
        } else if (cur.note == null && seed.note != null) {
          // Backfill missing notes only; do not overwrite planned amount.
          await tx
            .update(budgetLinesTable)
            .set({ note: seed.note })
            .where(eq(budgetLinesTable.id, cur.id));
        }
      }

      // Seed mapping rules. Idempotent on (userId, pattern) — we skip seeding
      // any pattern the user already has a rule for. Existing user-created
      // rules (including different categoryId mappings for the same pattern)
      // are left untouched so manual customizations survive re-seeds.
      const existingRules = await tx
        .select()
        .from(mappingRulesTable)
        .where(eq(mappingRulesTable.userId, userId));
      const existingPatterns = new Set(
        existingRules.map((r) => r.pattern.toLowerCase()),
      );
      let mappingRulesInserted = 0;
      for (const seed of SEED_MAPPING_RULES) {
        if (existingPatterns.has(seed.pattern.toLowerCase())) continue;
        const cat = byName.get(seed.categoryName);
        if (!cat) continue;
        await tx.insert(mappingRulesTable).values({
          userId,
          pattern: seed.pattern,
          matchType: "contains",
          categoryId: cat.id,
          priority: SEED_MAPPING_PRIORITY,
        });
        mappingRulesInserted++;
      }

      return {
        categoriesInserted,
        linesInserted,
        mappingRulesInserted,
        alreadySeeded:
          categoriesInserted === 0 &&
          linesInserted === 0 &&
          mappingRulesInserted === 0,
      };
    });
    res.json(result);
  },
);

// One-shot endpoint to seed (or top up) the user's recurring bills. Useful
// for users who already ran /budget/seed-defaults back when it only seeded
// the 3 income items, so we don't have to re-run the whole defaults flow.
// Idempotent: skips any (name, frequency, dayOfMonth, anchorDate) row the
// user already has, and only creates the few support categories
// (Subscriptions, Discretionary, Home services) that the new bills link to.
router.post(
  "/budget/seed-bills",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const result = await db.transaction(async (tx) => {
      const bills = SEED_RECURRING_ITEMS.filter((r) => r.kind !== "income");

      // 1. Ensure every category referenced by a bill exists. We only insert
      //    missing categories (planned 0, manual source) and never modify
      //    existing rows here so user customizations survive.
      const neededCategoryNames = Array.from(
        new Set(bills.map((b) => b.categoryName).filter((n): n is string => !!n)),
      );
      const existingCats = await tx
        .select()
        .from(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.userId, userId));
      const catByName = new Map(existingCats.map((c) => [c.name, c]));

      const sortOrderByGroup = new Map<string, number>();
      SEED_GROUP_ORDER.forEach((g, i) => sortOrderByGroup.set(g, i * 100));

      let categoriesInserted = 0;
      for (const name of neededCategoryNames) {
        if (catByName.has(name)) continue;
        const seed = SEED_CATEGORIES.find((c) => c.name === name);
        if (!seed) continue;
        const groupBase = sortOrderByGroup.get(seed.groupName) ?? 9999;
        const [row] = await tx
          .insert(budgetCategoriesTable)
          .values({
            userId,
            name: seed.name,
            kind: seed.kind,
            groupName: seed.groupName,
            sourceKind: seed.sourceKind,
            sortOrder: groupBase + SEED_CATEGORIES.indexOf(seed),
          })
          .onConflictDoNothing({
            target: [budgetCategoriesTable.userId, budgetCategoriesTable.name],
          })
          .returning();
        if (row) {
          catByName.set(row.name, row);
          categoriesInserted++;
        }
      }

      // 2. Insert every missing bill. Skip-by-name at the *group* level: if
      //    the user already has any recurring row with a given seed name we
      //    skip the entire group (preserving user edits). Duplicate seed
      //    names (PlayStation Network, Kwik Trip / gas) are still inserted
      //    atomically on a fresh user because the existence check runs
      //    against the pre-seed snapshot only.
      const existingRecurring = await tx
        .select()
        .from(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
      const existingRecurringNames = new Set(existingRecurring.map((r) => r.name));

      let billsInserted = 0;
      for (const r of bills) {
        if (existingRecurringNames.has(r.name)) continue;
        const cat = catByName.get(r.categoryName ?? r.name);
        await tx.insert(recurringItemsTable).values({
          userId,
          name: r.name,
          kind: r.kind,
          amount: r.amount,
          frequency: r.frequency,
          dayOfMonth: r.dayOfMonth,
          anchorDate: r.anchorDate,
          active: "true",
          categoryId: cat?.id ?? null,
        });
        billsInserted++;
      }

      return {
        categoriesInserted,
        billsInserted,
        billsTotal: bills.length,
        alreadySeeded: categoriesInserted === 0 && billsInserted === 0,
      };
    });
    res.json(result);
  },
);

router.get(
  "/budget/months/:monthStart",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = GetBudgetMonthParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const monthStart = params.data.monthStart;

    // One-time consolidation of the legacy budget category list (task #65).
    // Gated by a per-user flag, so it's a no-op on subsequent requests.
    await migrateBudgetCategoriesV2(req.userId!);

    // Pull the live Debts tracker into auto_debts categories/lines for this
    // month before reading anything back. Each call ensures the budget rows
    // match the current Debts state (adds, removes, renames, min changes).
    await syncAutoDebtCategories(req.userId!, monthStart);

    const [month] = await db
      .select()
      .from(budgetMonthsTable)
      .where(
        and(
          eq(budgetMonthsTable.userId, req.userId!),
          eq(budgetMonthsTable.monthStart, monthStart),
        ),
      );

    const cats = await db
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, req.userId!))
      .orderBy(asc(budgetCategoriesTable.sortOrder), asc(budgetCategoriesTable.name));

    let lines = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.userId, req.userId!),
          eq(budgetLinesTable.monthStart, monthStart),
        ),
      );

    // Carry-forward: if no lines exist yet for this month, copy the most recent
    // prior month's planned amounts and notes for manual categories. Auto-pulled
    // categories are skipped since their amounts derive from Bills/Debts.
    if (lines.length === 0) {
      const [prior] = await db
        .select({ monthStart: budgetLinesTable.monthStart })
        .from(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.userId, req.userId!),
            lt(budgetLinesTable.monthStart, monthStart),
          ),
        )
        .orderBy(desc(budgetLinesTable.monthStart))
        .limit(1);

      if (prior) {
        const manualCategoryIds = cats
          .filter((c) => c.sourceKind === "manual")
          .map((c) => c.id);

        if (manualCategoryIds.length > 0) {
          const priorLines = await db
            .select()
            .from(budgetLinesTable)
            .where(
              and(
                eq(budgetLinesTable.userId, req.userId!),
                eq(budgetLinesTable.monthStart, prior.monthStart),
                inArray(budgetLinesTable.categoryId, manualCategoryIds),
              ),
            );

          if (priorLines.length > 0) {
            await db
              .insert(budgetMonthsTable)
              .values({ userId: req.userId!, monthStart })
              .onConflictDoNothing();

            await db
              .insert(budgetLinesTable)
              .values(
                priorLines.map((l) => ({
                  userId: req.userId!,
                  monthStart,
                  categoryId: l.categoryId,
                  plannedAmount: l.plannedAmount,
                  note: l.note,
                })),
              )
              .onConflictDoNothing({
                target: [
                  budgetLinesTable.userId,
                  budgetLinesTable.monthStart,
                  budgetLinesTable.categoryId,
                ],
              });

            lines = await db
              .select()
              .from(budgetLinesTable)
              .where(
                and(
                  eq(budgetLinesTable.userId, req.userId!),
                  eq(budgetLinesTable.monthStart, monthStart),
                ),
              );
          }
        }
      }
    }

    // Source-derived planned amounts for auto categories. We compute these
    // on the fly from Bills (recurring_items) and Debts so they always reflect
    // the current source values, regardless of what (if anything) was carried
    // forward into this month's budget_lines.
    const monthEnd0 = new Date(monthStart);
    monthEnd0.setMonth(monthEnd0.getMonth() + 1);
    const monthEndStr0 = monthEnd0.toISOString().slice(0, 10);
    const monthFromDate = parseISO(monthStart);
    const monthToDate = addDays(parseISO(monthEndStr0), -1);

    const autoBillsCats = cats.filter((c) => c.sourceKind === "auto_bills");
    const autoBillsCatIds = autoBillsCats.map((c) => c.id);
    const autoBillsCatByName = new Map(autoBillsCats.map((c) => [c.name, c]));
    const autoDebtCats = cats.filter((c) => c.sourceKind === "auto_debts");

    const autoPlannedByCat = new Map<string, string>();

    if (autoBillsCatIds.length > 0) {
      // Pull every recurring item the user has so we can match by either
      // categoryId (preferred) or by exact category name (fallback for
      // legacy items created before categoryId linkage existed).
      const recurring = await db
        .select()
        .from(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, req.userId!));
      const sums = new Map<string, number>();
      const expandFor = (item: typeof recurring[number], catId: string) => {
        const events = expandItem(item, monthFromDate, monthToDate);
        let total = 0;
        for (const ev of events) total += Math.abs(ev.amount);
        sums.set(catId, (sums.get(catId) ?? 0) + total);
      };
      for (const r of recurring) {
        if (r.active === "false") continue;
        if (r.categoryId && autoBillsCatIds.includes(r.categoryId)) {
          expandFor(r, r.categoryId);
          continue;
        }
        // Fallback: match by exact category name when categoryId is not set
        // or points elsewhere.
        const cat = autoBillsCatByName.get(r.name);
        if (cat) expandFor(r, cat.id);
      }
      // Ensure every auto_bills category gets a value (deactivated/missing
      // recurring items leave the budget line at $0 for the month, per
      // task #35 acceptance criteria).
      for (const c of autoBillsCats) {
        autoPlannedByCat.set(c.id, (sums.get(c.id) ?? 0).toFixed(2));
      }
    }

    if (autoDebtCats.length > 0) {
      const debts = await db
        .select()
        .from(debtsTable)
        .where(eq(debtsTable.userId, req.userId!));
      const activeDebts = debts
        .filter((d) => d.status === "active")
        .sort((a, b) => b.name.length - a.name.length);
      for (const cat of autoDebtCats) {
        const match = activeDebts.find((d) => cat.name.includes(d.name));
        if (match) {
          autoPlannedByCat.set(cat.id, parseFloat(match.minPayment).toFixed(2));
        }
      }
    }

    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    const monthEndStr = monthEnd.toISOString().slice(0, 10);

    // Spend = sum of |amount| where amount < 0 for expense categories; income = sum positive.
    // Transfers (between user's own accounts) are excluded from both totals.
    // We also break down by source so the budget row can show "Bank" / "Amex"
    // counts derived from where each transaction came from.
    const actuals = await db
      .select({
        categoryId: transactionsTable.categoryId,
        source: transactionsTable.source,
        spend: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
        inflow: sql<string>`coalesce(sum(case when ${transactionsTable.amount} > 0 then ${transactionsTable.amount} else 0 end)::text, '0')`,
        cnt: sql<string>`count(*)::text`,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, req.userId!),
          sql`${transactionsTable.occurredOn} >= ${monthStart}`,
          sql`${transactionsTable.occurredOn} < ${monthEndStr}`,
          eq(transactionsTable.isTransfer, false),
        ),
      )
      .groupBy(transactionsTable.categoryId, transactionsTable.source);

    type SourceBucket = { source: string; count: number; amount: number };
    const spendByCat = new Map<string, number>();
    const inflowByCat = new Map<string, number>();
    const breakdownByCat = new Map<string, SourceBucket[]>();
    for (const a of actuals) {
      if (!a.categoryId) continue;
      const spend = parseFloat(a.spend) || 0;
      const inflow = parseFloat(a.inflow) || 0;
      spendByCat.set(a.categoryId, (spendByCat.get(a.categoryId) ?? 0) + spend);
      inflowByCat.set(
        a.categoryId,
        (inflowByCat.get(a.categoryId) ?? 0) + inflow,
      );
      const arr = breakdownByCat.get(a.categoryId) ?? [];
      arr.push({
        source: a.source,
        count: parseInt(a.cnt, 10) || 0,
        amount: spend > 0 ? spend : inflow,
      });
      breakdownByCat.set(a.categoryId, arr);
    }
    const linesByCat = new Map(lines.map((l) => [l.categoryId, l]));

    const responseLines = cats.map((c) => {
      const line = linesByCat.get(c.id);
      const actualNum =
        c.kind === "income"
          ? inflowByCat.get(c.id) ?? 0
          : spendByCat.get(c.id) ?? 0;
      const derived = autoPlannedByCat.get(c.id);
      const plannedAmount =
        c.sourceKind !== "manual" && derived !== undefined
          ? derived
          : line?.plannedAmount ?? "0";
      const buckets = breakdownByCat.get(c.id) ?? [];
      // Collapse "plaid:bank", "plaid:capitalone", etc. into a single "Bank"
      // bucket; Amex stays as Amex; everything else (manual, import) groups
      // under "Other" so the badge row stays compact.
      type Label = "Bank" | "Amex" | "Other";
      const labelFor = (s: string): Label => {
        if (s === "amex") return "Amex";
        if (s.startsWith("plaid:amex")) return "Amex";
        if (s.startsWith("plaid:")) return "Bank";
        return "Other";
      };
      const grouped = new Map<Label, { count: number; amount: number }>();
      for (const b of buckets) {
        const k = labelFor(b.source);
        const cur = grouped.get(k) ?? { count: 0, amount: 0 };
        cur.count += b.count;
        cur.amount += b.amount;
        grouped.set(k, cur);
      }
      const sourceBreakdown = Array.from(grouped.entries()).map(
        ([label, v]) => ({
          source: label,
          count: v.count,
          amount: v.amount.toFixed(2),
        }),
      );
      return {
        id: line?.id ?? null,
        categoryId: c.id,
        categoryName: c.name,
        plannedAmount,
        actualAmount: actualNum.toFixed(2),
        note: line?.note ?? null,
        groupName: c.groupName,
        sourceKind: c.sourceKind,
        sortOrder: c.sortOrder,
        kind: c.kind,
        sourceBreakdown,
      };
    });

    // Group by groupName, ordering by SEED_GROUP_ORDER first then any extra groups alphabetically.
    const groupMap = new Map<string, typeof responseLines>();
    for (const l of responseLines) {
      const arr = groupMap.get(l.groupName) ?? [];
      arr.push(l);
      groupMap.set(l.groupName, arr);
    }
    const orderIdx = new Map(SEED_GROUP_ORDER.map((g, i) => [g, i]));
    const orderedGroups = Array.from(groupMap.keys()).sort((a, b) => {
      const ai = orderIdx.has(a) ? orderIdx.get(a)! : 1000;
      const bi = orderIdx.has(b) ? orderIdx.get(b)! : 1000;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });

    // Always include the canonical groups even if empty, so the UI shows them in order.
    for (const g of SEED_GROUP_ORDER) {
      if (!groupMap.has(g)) {
        groupMap.set(g, []);
        orderedGroups.push(g);
      }
    }
    // Re-dedupe orderedGroups while preserving order.
    const seen = new Set<string>();
    const finalGroupOrder = [];
    for (const g of [...SEED_GROUP_ORDER, ...orderedGroups]) {
      if (seen.has(g)) continue;
      seen.add(g);
      if (groupMap.has(g)) finalGroupOrder.push(g);
    }

    const groups = finalGroupOrder.map((groupName) => {
      const items = (groupMap.get(groupName) ?? []).slice().sort(
        (a, b) => a.sortOrder - b.sortOrder || a.categoryName.localeCompare(b.categoryName),
      );
      let plannedTotal = 0;
      let actualTotal = 0;
      for (const l of items) {
        plannedTotal += parseFloat(l.plannedAmount) || 0;
        actualTotal += parseFloat(l.actualAmount) || 0;
      }
      return {
        groupName,
        plannedTotal: plannedTotal.toFixed(2),
        actualTotal: actualTotal.toFixed(2),
        lines: items,
      };
    });

    let incomeBudget = 0;
    let incomeActual = 0;
    let expenseBudget = 0;
    let expenseActual = 0;
    for (const l of responseLines) {
      const planned = parseFloat(l.plannedAmount) || 0;
      const actual = parseFloat(l.actualAmount) || 0;
      if (l.kind === "income") {
        incomeBudget += planned;
        incomeActual += actual;
      } else {
        expenseBudget += planned;
        expenseActual += actual;
      }
    }
    const pct = (n: number, d: number) =>
      d > 0 ? ((n / d) * 100).toFixed(1) : "0.0";

    const summary = {
      income: { budget: incomeBudget.toFixed(2), actual: incomeActual.toFixed(2) },
      expenses: { budget: expenseBudget.toFixed(2), actual: expenseActual.toFixed(2) },
      net: {
        budget: (incomeBudget - expenseBudget).toFixed(2),
        actual: (incomeActual - expenseActual).toFixed(2),
      },
      percentSpent: {
        budget: pct(expenseBudget, incomeBudget),
        actual: pct(expenseActual, incomeActual),
      },
    };

    res.json({
      monthStart,
      note: month?.note ?? null,
      lines: responseLines,
      groups,
      summary,
    });
  },
);

router.post("/budget/lines", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertBudgetLineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await db
    .insert(budgetMonthsTable)
    .values({ userId: req.userId!, monthStart: parsed.data.monthStart })
    .onConflictDoNothing();

  const existing = await db
    .select()
    .from(budgetLinesTable)
    .where(
      and(
        eq(budgetLinesTable.userId, req.userId!),
        eq(budgetLinesTable.monthStart, parsed.data.monthStart),
        eq(budgetLinesTable.categoryId, parsed.data.categoryId),
      ),
    );

  let row;
  if (existing.length > 0) {
    [row] = await db
      .update(budgetLinesTable)
      .set({
        plannedAmount: parsed.data.plannedAmount,
        note: parsed.data.note ?? null,
      })
      .where(eq(budgetLinesTable.id, existing[0]!.id))
      .returning();
  } else {
    [row] = await db
      .insert(budgetLinesTable)
      .values({ ...parsed.data, userId: req.userId! })
      .returning();
  }
  res.json(row);
});

export default router;
