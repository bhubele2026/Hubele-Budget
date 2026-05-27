import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  mappingRulesTable,
  transactionsTable,
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
  if (partial.length === 0) throw new Error(`No category matches "${needle}".`);
  if (partial.length > 1) {
    const names = partial.map((r) => r.name).slice(0, 8).join(", ");
    throw new Error(`Multiple categories match "${needle}": ${names}. Use the exact name.`);
  }
  return partial[0];
}

// Snapshots
interface DeleteMappingRuleSnapshot {
  kind: "delete_mapping_rule";
  rule: {
    id: string;
    userId: string;
    householdId: string | null;
    pattern: string;
    matchType: string;
    categoryId: string | null;
    priority: number;
  };
}
interface UpdateMappingRuleSnapshot {
  kind: "update_mapping_rule";
  ruleId: string;
  previous: {
    pattern: string;
    matchType: string;
    categoryId: string | null;
    priority: number;
  };
}
interface UpdateTransactionNotesSnapshot {
  kind: "update_transaction_notes";
  transactionId: string;
  previousNotes: string | null;
}

// ---------------------------------------------------------------------------
// Tool: delete_mapping_rule
// ---------------------------------------------------------------------------

const deleteMappingRuleInput = z.object({
  ruleId: z
    .string()
    .uuid()
    .describe("ID of the rule to delete. List rules first via the Mapping Rules page or ask the user which rule to remove."),
});

registerTool({
  name: "delete_mapping_rule",
  description:
    "Delete an auto-categorization rule. Does NOT recategorize existing transactions — only stops future auto-categorization for the pattern. Reversible for 5 minutes (restores the rule).",
  riskTier: "reversible",
  inputSchema: deleteMappingRuleInput,
  jsonSchema: {
    type: "object",
    properties: { ruleId: { type: "string", format: "uuid" } },
    required: ["ruleId"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const [existing] = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.id, input.ruleId),
          eq(mappingRulesTable.householdId, ctx.householdId),
        ),
      );
    if (!existing) throw new Error(`Mapping rule ${input.ruleId} not found in this household.`);
    const snap: DeleteMappingRuleSnapshot = {
      kind: "delete_mapping_rule",
      rule: {
        id: existing.id,
        userId: existing.userId,
        householdId: existing.householdId,
        pattern: existing.pattern,
        matchType: existing.matchType,
        categoryId: existing.categoryId,
        priority: existing.priority,
      },
    };
    await db.delete(mappingRulesTable).where(eq(mappingRulesTable.id, existing.id));
    return {
      result: {
        ok: true,
        deleted: { pattern: existing.pattern, matchType: existing.matchType },
      },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, _ctx) => {
    const snap = beforeSnapshot as DeleteMappingRuleSnapshot;
    if (snap?.kind !== "delete_mapping_rule") throw new Error("Snapshot shape mismatch");
    await db.insert(mappingRulesTable).values({
      id: snap.rule.id,
      userId: snap.rule.userId,
      householdId: snap.rule.householdId,
      pattern: snap.rule.pattern,
      matchType: snap.rule.matchType,
      categoryId: snap.rule.categoryId,
      priority: snap.rule.priority,
    });
  },
});

// ---------------------------------------------------------------------------
// Tool: update_mapping_rule
// ---------------------------------------------------------------------------

const updateMappingRuleInput = z.object({
  ruleId: z.string().uuid().describe("ID of the rule to update."),
  pattern: z.string().min(2).optional().describe("New pattern. Omit to keep existing."),
  matchType: z
    .enum(["contains", "starts_with", "exact"])
    .optional()
    .describe("New match strategy. Omit to keep existing."),
  newCategoryName: z
    .string()
    .optional()
    .describe("New category name. Omit to keep existing category."),
  priority: z.number().int().optional().describe("New priority. Omit to keep existing."),
});

registerTool({
  name: "update_mapping_rule",
  description:
    "Update an existing auto-categorization rule's pattern, match type, target category, or priority. Does NOT touch existing transactions — only changes future auto-categorization. Reversible for 5 minutes.",
  riskTier: "reversible",
  inputSchema: updateMappingRuleInput,
  jsonSchema: {
    type: "object",
    properties: {
      ruleId: { type: "string", format: "uuid" },
      pattern: { type: "string", minLength: 2 },
      matchType: { type: "string", enum: ["contains", "starts_with", "exact"] },
      newCategoryName: { type: "string" },
      priority: { type: "integer" },
    },
    required: ["ruleId"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const [existing] = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.id, input.ruleId),
          eq(mappingRulesTable.householdId, ctx.householdId),
        ),
      );
    if (!existing) throw new Error(`Mapping rule ${input.ruleId} not found in this household.`);
    const updates: Record<string, unknown> = {};
    if (input.pattern !== undefined && input.pattern !== existing.pattern) {
      updates.pattern = input.pattern;
    }
    if (input.matchType !== undefined && input.matchType !== existing.matchType) {
      updates.matchType = input.matchType;
    }
    if (input.priority !== undefined && input.priority !== existing.priority) {
      updates.priority = input.priority;
    }
    if (input.newCategoryName !== undefined) {
      const cat = await resolveCategoryStrict(ctx.householdId, input.newCategoryName);
      if (cat.id !== existing.categoryId) {
        updates.categoryId = cat.id;
      }
    }
    if (Object.keys(updates).length === 0) {
      return {
        result: { ok: true, changed: false, message: "Rule already matched the requested values." },
      };
    }
    const snap: UpdateMappingRuleSnapshot = {
      kind: "update_mapping_rule",
      ruleId: existing.id,
      previous: {
        pattern: existing.pattern,
        matchType: existing.matchType,
        categoryId: existing.categoryId,
        priority: existing.priority,
      },
    };
    await db.update(mappingRulesTable).set(updates).where(eq(mappingRulesTable.id, existing.id));
    return {
      result: { ok: true, changed: true, applied: updates },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as UpdateMappingRuleSnapshot;
    if (snap?.kind !== "update_mapping_rule") throw new Error("Snapshot shape mismatch");
    await db
      .update(mappingRulesTable)
      .set({
        pattern: snap.previous.pattern,
        matchType: snap.previous.matchType,
        categoryId: snap.previous.categoryId,
        priority: snap.previous.priority,
      })
      .where(
        and(
          eq(mappingRulesTable.id, snap.ruleId),
          eq(mappingRulesTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: update_transaction_notes
// ---------------------------------------------------------------------------

const updateTransactionNotesInput = z.object({
  transactionId: z.string().uuid().describe("ID of the transaction."),
  notes: z
    .string()
    .max(2000)
    .nullable()
    .describe("New notes text. Pass null or empty string to clear notes."),
});

registerTool({
  name: "update_transaction_notes",
  description:
    "Set or clear the freeform notes on a transaction. Useful for tagging reimbursable items, gift recipients, trip names, etc. Reversible for 5 minutes.",
  riskTier: "reversible",
  inputSchema: updateTransactionNotesInput,
  jsonSchema: {
    type: "object",
    properties: {
      transactionId: { type: "string", format: "uuid" },
      notes: { type: ["string", "null"], maxLength: 2000 },
    },
    required: ["transactionId", "notes"],
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
    if (!existing) throw new Error(`Transaction ${input.transactionId} not found.`);
    const normalized = input.notes && input.notes.trim() !== "" ? input.notes : null;
    if (existing.notes === normalized) {
      return { result: { ok: true, changed: false } };
    }
    const snap: UpdateTransactionNotesSnapshot = {
      kind: "update_transaction_notes",
      transactionId: existing.id,
      previousNotes: existing.notes,
    };
    await db
      .update(transactionsTable)
      .set({ notes: normalized })
      .where(eq(transactionsTable.id, existing.id));
    return {
      result: {
        ok: true,
        changed: true,
        description: existing.description,
        previousNotes: existing.notes,
        newNotes: normalized,
      },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as UpdateTransactionNotesSnapshot;
    if (snap?.kind !== "update_transaction_notes") throw new Error("Snapshot shape mismatch");
    await db
      .update(transactionsTable)
      .set({ notes: snap.previousNotes })
      .where(
        and(
          eq(transactionsTable.id, snap.transactionId),
          eq(transactionsTable.householdId, ctx.householdId),
        ),
      );
  },
});
