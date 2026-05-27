import { z } from "zod";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  mappingRulesTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { registerTool } from "./advisorTools";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a category by name (case-insensitive substring match) within
 * the household. Returns the single matching row, or throws with a
 * helpful message if zero or more than one match. The "more than one"
 * case forces the model to be more specific instead of silently picking
 * the wrong category.
 */
async function resolveCategory(householdId: string, needle: string) {
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
      `Multiple categories match "${needle}": ${names}. Please use the exact category name.`,
    );
  }
  return partial[0];
}

/**
 * Resolve a recurring item by name (case-insensitive substring match).
 * Same single-match guard as resolveCategory.
 */
async function resolveRecurringItem(householdId: string, needle: string) {
  const rows = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));
  const lower = needle.toLowerCase().trim();
  const exact = rows.filter((r) => r.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = rows.filter((r) => r.name.toLowerCase().includes(lower));
  if (partial.length === 0) {
    throw new Error(`No recurring item matches "${needle}".`);
  }
  if (partial.length > 1) {
    const names = partial.map((r) => r.name).slice(0, 8).join(", ");
    throw new Error(
      `Multiple recurring items match "${needle}": ${names}. Please use the exact name.`,
    );
  }
  return partial[0];
}

// Snapshot shapes for undo
interface RecategorizeOneSnapshot {
  kind: "recategorize_one";
  transactionId: string;
  previousCategoryId: string | null;
}

interface RecategorizeBatchSnapshot {
  kind: "recategorize_batch";
  changes: Array<{ transactionId: string; previousCategoryId: string | null }>;
}

interface UpdateBudgetLineSnapshot {
  kind: "update_budget_line";
  monthStart: string;
  categoryId: string;
  // When undoing a CREATE (no previous row existed), this is null and the
  // undo deletes the row instead.
  previous: { id: string; plannedAmount: string; pinned: boolean } | null;
}

interface AddMappingRuleSnapshot {
  kind: "add_mapping_rule";
  ruleId: string;
}

interface UpdateRecurringAmountSnapshot {
  kind: "update_recurring_amount";
  recurringItemId: string;
  previousAmount: string;
}

// ---------------------------------------------------------------------------
// Tool: recategorize_transaction
// ---------------------------------------------------------------------------

const recategorizeOneInput = z.object({
  transactionId: z
    .string()
    .uuid()
    .describe("The transaction id to recategorize. Obtain from query_transactions."),
  newCategoryName: z
    .string()
    .describe("Target category name (case-insensitive substring match within household)."),
});

registerTool({
  name: "recategorize_transaction",
  description:
    "Reassign a single transaction to a different category. Undoable for 5 minutes. Use when the user asks to fix one specific transaction's category.",
  riskTier: "reversible",
  inputSchema: recategorizeOneInput,
  jsonSchema: {
    type: "object",
    properties: {
      transactionId: { type: "string", format: "uuid" },
      newCategoryName: { type: "string" },
    },
    required: ["transactionId", "newCategoryName"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const [existing] = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.id, input.transactionId),
          eq(transactionsTable.householdId, ctx.householdId),
        ),
      );
    if (!existing) {
      throw new Error(`Transaction ${input.transactionId} not found in this household.`);
    }
    const target = await resolveCategory(ctx.householdId, input.newCategoryName);
    if (existing.categoryId === target.id) {
      return {
        result: {
          ok: true,
          message: `Transaction was already in "${target.name}". No change.`,
          changed: false,
        },
      };
    }
    await db
      .update(transactionsTable)
      .set({ categoryId: target.id })
      .where(eq(transactionsTable.id, input.transactionId));

    const snapshot: RecategorizeOneSnapshot = {
      kind: "recategorize_one",
      transactionId: input.transactionId,
      previousCategoryId: existing.categoryId,
    };
    return {
      result: {
        ok: true,
        changed: true,
        description: existing.description,
        newCategory: target.name,
        amount: Number(existing.amount),
      },
      beforeSnapshot: snapshot,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as RecategorizeOneSnapshot;
    if (snap?.kind !== "recategorize_one") {
      throw new Error("Snapshot shape mismatch");
    }
    await db
      .update(transactionsTable)
      .set({ categoryId: snap.previousCategoryId })
      .where(
        and(
          eq(transactionsTable.id, snap.transactionId),
          eq(transactionsTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: recategorize_by_pattern
// ---------------------------------------------------------------------------

const recategorizeBatchInput = z.object({
  descriptionContains: z
    .string()
    .min(2)
    .describe("Case-insensitive substring to match against transaction descriptions."),
  newCategoryName: z.string().describe("Target category for matched transactions."),
  monthsBack: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe("Only recategorize transactions in the last N months. Default 6."),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Safety cap. If the match set exceeds this, the tool refuses to act. Default 50."),
});

registerTool({
  name: "recategorize_by_pattern",
  description:
    "Recategorize all transactions matching a description pattern, scoped to the last N months. Refuses if more than maxRows transactions match. Undoable for 5 minutes (reverses every row).",
  riskTier: "reversible",
  inputSchema: recategorizeBatchInput,
  jsonSchema: {
    type: "object",
    properties: {
      descriptionContains: { type: "string", minLength: 2 },
      newCategoryName: { type: "string" },
      monthsBack: { type: "integer", minimum: 1, maximum: 24 },
      maxRows: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["descriptionContains", "newCategoryName"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const monthsBack = input.monthsBack ?? 6;
    const maxRows = input.maxRows ?? 50;
    const target = await resolveCategory(ctx.householdId, input.newCategoryName);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    const startISO = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(
      2,
      "0",
    )}-01`;

    const matches = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, ctx.householdId),
          ilike(transactionsTable.description, `%${input.descriptionContains}%`),
          sql`${transactionsTable.occurredOn} >= ${startISO}`,
        ),
      );

    if (matches.length === 0) {
      return { result: { ok: true, changed: 0, message: "No transactions matched." } };
    }
    if (matches.length > maxRows) {
      throw new Error(
        `Pattern matches ${matches.length} transactions, exceeding maxRows=${maxRows}. Narrow the pattern or raise maxRows.`,
      );
    }

    const needsChange = matches.filter((m) => m.categoryId !== target.id);
    if (needsChange.length === 0) {
      return {
        result: {
          ok: true,
          changed: 0,
          message: `All ${matches.length} matches are already in "${target.name}".`,
        },
      };
    }

    const ids = needsChange.map((m) => m.id);
    await db
      .update(transactionsTable)
      .set({ categoryId: target.id })
      .where(
        and(
          inArray(transactionsTable.id, ids),
          eq(transactionsTable.householdId, ctx.householdId),
        ),
      );

    const snapshot: RecategorizeBatchSnapshot = {
      kind: "recategorize_batch",
      changes: needsChange.map((m) => ({
        transactionId: m.id,
        previousCategoryId: m.categoryId,
      })),
    };

    return {
      result: {
        ok: true,
        changed: needsChange.length,
        scanned: matches.length,
        newCategory: target.name,
        pattern: input.descriptionContains,
      },
      beforeSnapshot: snapshot,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as RecategorizeBatchSnapshot;
    if (snap?.kind !== "recategorize_batch") {
      throw new Error("Snapshot shape mismatch");
    }
    // Undo each row individually. Could batch but safer to be explicit:
    // a single row being missing shouldn't block the others.
    for (const change of snap.changes) {
      await db
        .update(transactionsTable)
        .set({ categoryId: change.previousCategoryId })
        .where(
          and(
            eq(transactionsTable.id, change.transactionId),
            eq(transactionsTable.householdId, ctx.householdId),
          ),
        );
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: update_budget_line
// ---------------------------------------------------------------------------

const updateBudgetLineInput = z.object({
  categoryName: z.string().describe("Category to set the budget line for."),
  monthStart: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/)
    .describe("Month in 'YYYY-MM-01' format. The budget line is per-month."),
  plannedAmount: z
    .number()
    .min(0)
    .describe("New planned amount in dollars. Must be >= 0."),
});

registerTool({
  name: "update_budget_line",
  description:
    "Set or update the planned amount for a category in a specific month. If no budget line exists for that (month, category), one is created. Undoable for 5 minutes.",
  riskTier: "reversible",
  inputSchema: updateBudgetLineInput,
  jsonSchema: {
    type: "object",
    properties: {
      categoryName: { type: "string" },
      monthStart: { type: "string", pattern: "^\\d{4}-\\d{2}-01$" },
      plannedAmount: { type: "number", minimum: 0 },
    },
    required: ["categoryName", "monthStart", "plannedAmount"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const category = await resolveCategory(ctx.householdId, input.categoryName);
    const planned = input.plannedAmount.toFixed(2);

    // Ensure budget_months row exists.
    await db
      .insert(budgetMonthsTable)
      .values({
        userId: ctx.actorUserId,
        householdId: ctx.householdId,
        monthStart: input.monthStart,
      })
      .onConflictDoNothing();

    const [existing] = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.householdId, ctx.householdId),
          eq(budgetLinesTable.monthStart, input.monthStart),
          eq(budgetLinesTable.categoryId, category.id),
        ),
      );

    let snapshot: UpdateBudgetLineSnapshot;
    if (existing) {
      snapshot = {
        kind: "update_budget_line",
        monthStart: input.monthStart,
        categoryId: category.id,
        previous: {
          id: existing.id,
          plannedAmount: existing.plannedAmount,
          pinned: existing.pinned ?? false,
        },
      };
      await db
        .update(budgetLinesTable)
        .set({ plannedAmount: planned })
        .where(eq(budgetLinesTable.id, existing.id));
    } else {
      snapshot = {
        kind: "update_budget_line",
        monthStart: input.monthStart,
        categoryId: category.id,
        previous: null,
      };
      await db.insert(budgetLinesTable).values({
        userId: ctx.actorUserId,
        householdId: ctx.householdId,
        monthStart: input.monthStart,
        categoryId: category.id,
        plannedAmount: planned,
        pinned: false,
      });
    }

    return {
      result: {
        ok: true,
        category: category.name,
        monthStart: input.monthStart,
        plannedAmount: input.plannedAmount,
        previousAmount: existing ? Number(existing.plannedAmount) : null,
        created: !existing,
      },
      beforeSnapshot: snapshot,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as UpdateBudgetLineSnapshot;
    if (snap?.kind !== "update_budget_line") {
      throw new Error("Snapshot shape mismatch");
    }
    if (snap.previous) {
      await db
        .update(budgetLinesTable)
        .set({
          plannedAmount: snap.previous.plannedAmount,
          pinned: snap.previous.pinned,
        })
        .where(
          and(
            eq(budgetLinesTable.id, snap.previous.id),
            eq(budgetLinesTable.householdId, ctx.householdId),
          ),
        );
    } else {
      // Original action created the row — undo deletes it.
      await db
        .delete(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.householdId, ctx.householdId),
            eq(budgetLinesTable.monthStart, snap.monthStart),
            eq(budgetLinesTable.categoryId, snap.categoryId),
          ),
        );
    }
  },
});

// ---------------------------------------------------------------------------
// Tool: add_mapping_rule
// ---------------------------------------------------------------------------

const addMappingRuleInput = z.object({
  pattern: z
    .string()
    .min(2)
    .describe("Substring (or exact string, depending on matchType) to match against transaction descriptions. Case-insensitive."),
  matchType: z
    .enum(["contains", "starts_with", "exact"])
    .optional()
    .describe("Match strategy. Default 'contains'."),
  categoryName: z
    .string()
    .describe("Category to assign when a transaction's description matches the pattern."),
  priority: z
    .number()
    .int()
    .optional()
    .describe("Higher priority wins on ties. Default 0."),
});

registerTool({
  name: "add_mapping_rule",
  description:
    "Add an auto-categorization rule. Future transactions whose description matches the pattern will land in the target category. Existing transactions are NOT touched — use recategorize_by_pattern for that. Undoable for 5 minutes (deletes the rule).",
  riskTier: "reversible",
  inputSchema: addMappingRuleInput,
  jsonSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 2 },
      matchType: { type: "string", enum: ["contains", "starts_with", "exact"] },
      categoryName: { type: "string" },
      priority: { type: "integer" },
    },
    required: ["pattern", "categoryName"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const category = await resolveCategory(ctx.householdId, input.categoryName);
    const [inserted] = await db
      .insert(mappingRulesTable)
      .values({
        userId: ctx.actorUserId,
        householdId: ctx.householdId,
        pattern: input.pattern,
        matchType: input.matchType ?? "contains",
        categoryId: category.id,
        priority: input.priority ?? 0,
      })
      .returning();

    const snapshot: AddMappingRuleSnapshot = {
      kind: "add_mapping_rule",
      ruleId: inserted.id,
    };
    return {
      result: {
        ok: true,
        ruleId: inserted.id,
        pattern: input.pattern,
        matchType: inserted.matchType,
        category: category.name,
        priority: inserted.priority,
      },
      beforeSnapshot: snapshot,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as AddMappingRuleSnapshot;
    if (snap?.kind !== "add_mapping_rule") {
      throw new Error("Snapshot shape mismatch");
    }
    await db
      .delete(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.id, snap.ruleId),
          eq(mappingRulesTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: update_recurring_amount
// ---------------------------------------------------------------------------

const updateRecurringAmountInput = z.object({
  recurringItemName: z
    .string()
    .describe("Name of the recurring item (e.g. 'Netflix', 'Rent', 'Brad paycheck')."),
  newAmount: z
    .number()
    .min(0)
    .describe("New amount in dollars. Must be >= 0."),
});

registerTool({
  name: "update_recurring_amount",
  description:
    "Change the amount of an existing recurring item (bill, paycheck, subscription). Frequency, day-of-month, and active state are unchanged. Future occurrences will use the new amount. Undoable for 5 minutes.",
  riskTier: "reversible",
  inputSchema: updateRecurringAmountInput,
  jsonSchema: {
    type: "object",
    properties: {
      recurringItemName: { type: "string" },
      newAmount: { type: "number", minimum: 0 },
    },
    required: ["recurringItemName", "newAmount"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const item = await resolveRecurringItem(ctx.householdId, input.recurringItemName);
    const newAmount = input.newAmount.toFixed(2);
    if (item.amount === newAmount) {
      return {
        result: {
          ok: true,
          message: `${item.name} was already $${newAmount}. No change.`,
          changed: false,
        },
      };
    }
    await db
      .update(recurringItemsTable)
      .set({ amount: newAmount })
      .where(eq(recurringItemsTable.id, item.id));

    const snapshot: UpdateRecurringAmountSnapshot = {
      kind: "update_recurring_amount",
      recurringItemId: item.id,
      previousAmount: item.amount,
    };
    return {
      result: {
        ok: true,
        changed: true,
        name: item.name,
        previousAmount: Number(item.amount),
        newAmount: input.newAmount,
        frequency: item.frequency,
        kind: item.kind,
      },
      beforeSnapshot: snapshot,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as UpdateRecurringAmountSnapshot;
    if (snap?.kind !== "update_recurring_amount") {
      throw new Error("Snapshot shape mismatch");
    }
    await db
      .update(recurringItemsTable)
      .set({ amount: snap.previousAmount })
      .where(
        and(
          eq(recurringItemsTable.id, snap.recurringItemId),
          eq(recurringItemsTable.householdId, ctx.householdId),
        ),
      );
  },
});
