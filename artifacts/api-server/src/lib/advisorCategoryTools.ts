import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  transactionsTable,
  budgetLinesTable,
  mappingRulesTable,
} from "@workspace/db";
import { registerTool } from "./advisorTools";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveCategoryStrict(householdId: string, needle: string) {
  const rows = await db
    .select()
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));
  const lower = needle.toLowerCase().trim();
  const exact = rows.filter((r) => r.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = rows.filter((r) => r.name.toLowerCase().includes(lower));
  if (partial.length === 0) {
    throw new Error(`No category matches "${needle}". Call list_categories to see options.`);
  }
  if (partial.length > 1) {
    const names = partial.map((r) => r.name).slice(0, 8).join(", ");
    throw new Error(
      `Multiple categories match "${needle}": ${names}. Use the exact name.`,
    );
  }
  return partial[0];
}

// Snapshots
interface CreateCategorySnapshot {
  kind: "create_category";
  categoryId: string;
}

interface RenameCategorySnapshot {
  kind: "rename_category";
  categoryId: string;
  previousName: string;
}

interface DeleteCategorySnapshot {
  kind: "delete_category";
  category: {
    id: string;
    userId: string;
    householdId: string | null;
    name: string;
    categoryKind: string;
    groupName: string;
    sourceKind: string;
    sortOrder: number;
    debtId: string | null;
    excludeFromBudget: boolean;
  };
}

// ---------------------------------------------------------------------------
// Tool: create_category
// ---------------------------------------------------------------------------

const createCategoryInput = z.object({
  name: z.string().min(1).max(100).describe("Display name. Must be unique within the household."),
  groupName: z
    .string()
    .optional()
    .describe("Group/section name (e.g. 'Essentials', 'Lifestyle', 'My budget'). Default 'Other'."),
  kind: z
    .enum(["expense", "income"])
    .optional()
    .describe("Whether the category is for outflows or inflows. Default 'expense'."),
});

registerTool({
  name: "create_category",
  description:
    "Create a new budget category. Use when the user wants a category that doesn't exist yet (e.g. 'Italy Trip', 'Coffee', 'Hannah's allowance'). Reversible for 5 minutes.",
  riskTier: "reversible",
  inputSchema: createCategoryInput,
  jsonSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      groupName: { type: "string" },
      kind: { type: "string", enum: ["expense", "income"] },
    },
    required: ["name"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    // Pre-check uniqueness within household (same constraint the DB enforces,
    // but throwing a friendlier error before the DB violation).
    const existing = await db
      .select()
      .from(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.householdId, ctx.householdId),
          sql`lower(${budgetCategoriesTable.name}) = lower(${input.name})`,
        ),
      );
    if (existing.length > 0) {
      throw new Error(`A category named "${existing[0].name}" already exists in this household.`);
    }
    const [inserted] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: ctx.actorUserId,
        householdId: ctx.householdId,
        name: input.name,
        kind: input.kind ?? "expense",
        groupName: input.groupName ?? "Other",
        sourceKind: "manual",
      })
      .returning();
    const snap: CreateCategorySnapshot = {
      kind: "create_category",
      categoryId: inserted.id,
    };
    return {
      result: {
        ok: true,
        id: inserted.id,
        name: inserted.name,
        groupName: inserted.groupName,
        categoryKind: inserted.kind,
      },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as CreateCategorySnapshot;
    if (snap?.kind !== "create_category") throw new Error("Snapshot shape mismatch");
    // Safe: this row was just created, so no transactions, budget lines,
    // or mapping rules reference it yet (unless the user tab-switched
    // and assigned something in <5 min, which is unlikely). Detect
    // dependents first and refuse rather than orphan rows.
    const dependentTxns = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, ctx.householdId),
          eq(transactionsTable.categoryId, snap.categoryId),
        ),
      )
      .limit(1);
    if (dependentTxns.length > 0) {
      throw new Error(
        "Cannot undo: transactions have already been assigned to this category.",
      );
    }
    await db
      .delete(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.id, snap.categoryId),
          eq(budgetCategoriesTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: rename_category
// ---------------------------------------------------------------------------

const renameCategoryInput = z.object({
  currentName: z.string().describe("Current category name (case-insensitive substring match)."),
  newName: z.string().min(1).max(100).describe("New name. Must not conflict with another existing category."),
});

registerTool({
  name: "rename_category",
  description:
    "Rename an existing budget category. All transactions stay attached; only the display name changes. Reversible for 5 minutes.",
  riskTier: "reversible",
  inputSchema: renameCategoryInput,
  jsonSchema: {
    type: "object",
    properties: {
      currentName: { type: "string" },
      newName: { type: "string", minLength: 1, maxLength: 100 },
    },
    required: ["currentName", "newName"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const cat = await resolveCategoryStrict(ctx.householdId, input.currentName);
    if (cat.name === input.newName) {
      return {
        result: { ok: true, changed: false, message: `Already named "${input.newName}".` },
      };
    }
    // Uniqueness check
    const conflict = await db
      .select()
      .from(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.householdId, ctx.householdId),
          sql`lower(${budgetCategoriesTable.name}) = lower(${input.newName})`,
        ),
      );
    if (conflict.length > 0 && conflict[0].id !== cat.id) {
      throw new Error(`Another category is already named "${conflict[0].name}".`);
    }
    await db
      .update(budgetCategoriesTable)
      .set({ name: input.newName })
      .where(eq(budgetCategoriesTable.id, cat.id));

    const snap: RenameCategorySnapshot = {
      kind: "rename_category",
      categoryId: cat.id,
      previousName: cat.name,
    };
    return {
      result: { ok: true, changed: true, previousName: cat.name, newName: input.newName },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as RenameCategorySnapshot;
    if (snap?.kind !== "rename_category") throw new Error("Snapshot shape mismatch");
    await db
      .update(budgetCategoriesTable)
      .set({ name: snap.previousName })
      .where(
        and(
          eq(budgetCategoriesTable.id, snap.categoryId),
          eq(budgetCategoriesTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: delete_category
// ---------------------------------------------------------------------------

const deleteCategoryInput = z.object({
  categoryName: z.string().describe("Category to delete (case-insensitive substring match)."),
});

registerTool({
  name: "delete_category",
  description:
    "Delete a budget category. REFUSES if the category has transactions, budget lines, or mapping rules attached — the user must reassign those first. REFUSES on auto-generated categories (debt minimums, avalanche payment). Destructive — requires user confirmation. Undoable for 5 minutes if successful.",
  riskTier: "destructive",
  inputSchema: deleteCategoryInput,
  jsonSchema: {
    type: "object",
    properties: { categoryName: { type: "string" } },
    required: ["categoryName"],
    additionalProperties: false,
  },
  previewer: async (input, ctx) => {
    try {
      const cat = await resolveCategoryStrict(ctx.householdId, input.categoryName);
      if (cat.sourceKind !== "manual") {
        return `Cannot delete "${cat.name}" — it's auto-generated (sourceKind=${cat.sourceKind}). Tools refuse system categories.`;
      }
      const [{ cnt: txnCount }] = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, ctx.householdId),
            eq(transactionsTable.categoryId, cat.id),
          ),
        );
      const [{ cnt: ruleCount }] = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(mappingRulesTable)
        .where(
          and(
            eq(mappingRulesTable.householdId, ctx.householdId),
            eq(mappingRulesTable.categoryId, cat.id),
          ),
        );
      const [{ cnt: lineCount }] = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.householdId, ctx.householdId),
            eq(budgetLinesTable.categoryId, cat.id),
          ),
        );
      if (txnCount > 0 || ruleCount > 0 || lineCount > 0) {
        return `Cannot delete "${cat.name}": ${txnCount} transactions, ${ruleCount} mapping rules, ${lineCount} budget lines attached. Reassign those first.`;
      }
      return `Delete category "${cat.name}" (group: ${cat.groupName}). No transactions, rules, or budget lines attached.`;
    } catch (err) {
      return `Delete category "${input.categoryName}" (will resolve at confirm)`;
    }
  },
  handler: async (input, ctx) => {
    const cat = await resolveCategoryStrict(ctx.householdId, input.categoryName);
    if (cat.sourceKind !== "manual") {
      throw new Error(
        `Refusing to delete "${cat.name}" — sourceKind=${cat.sourceKind}. Only manual categories are deletable.`,
      );
    }
    const [{ cnt: txnCount }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, ctx.householdId),
          eq(transactionsTable.categoryId, cat.id),
        ),
      );
    if (txnCount > 0) {
      throw new Error(
        `Refusing to delete "${cat.name}": ${txnCount} transactions are attached. Reassign them via recategorize_by_pattern or recategorize_transaction first.`,
      );
    }
    const [{ cnt: ruleCount }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.householdId, ctx.householdId),
          eq(mappingRulesTable.categoryId, cat.id),
        ),
      );
    if (ruleCount > 0) {
      throw new Error(
        `Refusing to delete "${cat.name}": ${ruleCount} mapping rules point to it. Update or delete those first.`,
      );
    }
    const [{ cnt: lineCount }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.householdId, ctx.householdId),
          eq(budgetLinesTable.categoryId, cat.id),
        ),
      );
    if (lineCount > 0) {
      throw new Error(
        `Refusing to delete "${cat.name}": ${lineCount} budget lines exist for it. Set them to 0 or delete them first.`,
      );
    }

    const snap: DeleteCategorySnapshot = {
      kind: "delete_category",
      category: {
        id: cat.id,
        userId: cat.userId,
        householdId: cat.householdId,
        name: cat.name,
        categoryKind: cat.kind,
        groupName: cat.groupName,
        sourceKind: cat.sourceKind,
        sortOrder: cat.sortOrder,
        debtId: cat.debtId,
        excludeFromBudget: cat.excludeFromBudget,
      },
    };
    await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.id, cat.id));
    return {
      result: { ok: true, deleted: cat.name },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, _ctx) => {
    const snap = beforeSnapshot as DeleteCategorySnapshot;
    if (snap?.kind !== "delete_category") throw new Error("Snapshot shape mismatch");
    await db.insert(budgetCategoriesTable).values({
      id: snap.category.id,
      userId: snap.category.userId,
      householdId: snap.category.householdId,
      name: snap.category.name,
      kind: snap.category.categoryKind,
      groupName: snap.category.groupName,
      sourceKind: snap.category.sourceKind,
      sortOrder: snap.category.sortOrder,
      debtId: snap.category.debtId,
      excludeFromBudget: snap.category.excludeFromBudget,
    });
  },
});
