import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  advisorAuditLogTable,
} from "@workspace/db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolRiskTier =
  | "read" // no writes, auto-execute, no audit log row needed (but we log anyway)
  | "reversible" // writes that we can undo via beforeSnapshot
  | "destructive"; // writes that require user confirmation

export interface ToolContext {
  householdId: string;
  householdOwnerId: string;
  actorUserId: string;
  chatMessageId?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  riskTier: ToolRiskTier;
  // Zod schema for validating args coming from the model.
  inputSchema: z.ZodType<TInput>;
  // JSON Schema (Anthropic format) for the model. We could derive this
  // from the Zod schema, but for clarity we keep it explicit.
  jsonSchema: Record<string, unknown>;
  // The actual handler. Receives validated input and context.
  // For reversible tools, returns { result, beforeSnapshot } so the
  // dispatcher can record what changed. For others, returns { result }.
  handler: (
    input: TInput,
    ctx: ToolContext,
  ) => Promise<{ result: TOutput; beforeSnapshot?: unknown }>;
  undoHandler?: (
    beforeSnapshot: unknown,
    ctx: ToolContext,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, ToolDefinition<unknown, unknown>>();

export function registerTool<TInput, TOutput>(def: ToolDefinition<TInput, TOutput>): void {
  if (registry.has(def.name)) {
    throw new Error(`Duplicate tool registration: ${def.name}`);
  }
  registry.set(def.name, def as ToolDefinition<unknown, unknown>);
}

export function getRegisteredTools(): ToolDefinition<unknown, unknown>[] {
  return Array.from(registry.values());
}

export function getToolByName(name: string): ToolDefinition<unknown, unknown> | undefined {
  return registry.get(name);
}

/**
 * Returns tool definitions in Anthropic's expected format for inclusion
 * in messages.create({ tools: [...] }).
 */
export function getAnthropicToolSpecs(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return getRegisteredTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema,
  }));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchResult {
  ok: boolean;
  toolName: string;
  result?: unknown;
  error?: string;
  auditLogId?: string;
}

export async function dispatchTool(
  toolName: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<DispatchResult> {
  const tool = registry.get(toolName);
  if (!tool) {
    return { ok: false, toolName, error: `Unknown tool: ${toolName}` };
  }

  // Validate args. Bad args from the model → audit log + error back to model.
  const parsed = tool.inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const errMsg = `Invalid arguments: ${parsed.error.message}`;
    const [row] = await db
      .insert(advisorAuditLogTable)
      .values({
        householdId: ctx.householdId,
        actorUserId: ctx.actorUserId,
        toolName,
        args: rawArgs as any,
        status: "failed",
        errorMessage: errMsg,
        chatMessageId: ctx.chatMessageId,
      })
      .returning({ id: advisorAuditLogTable.id });
    return { ok: false, toolName, error: errMsg, auditLogId: row?.id };
  }

  // Insert "proposed" / "auto_executed" row up front so we have an id to
  // reference. For read tools we mark auto_executed since there's nothing
  // to confirm.
  const initialStatus = tool.riskTier === "read" ? "auto_executed" : "auto_executed";
  // (Phase 0: everything auto-executes. Confirmation gating comes in
  // Phase 3 when destructive tools land.)
  const [logRow] = await db
    .insert(advisorAuditLogTable)
    .values({
      householdId: ctx.householdId,
      actorUserId: ctx.actorUserId,
      toolName,
      args: parsed.data as any,
      status: initialStatus,
      chatMessageId: ctx.chatMessageId,
    })
    .returning({ id: advisorAuditLogTable.id });
  const auditLogId = logRow?.id;

  try {
    const { result, beforeSnapshot } = await tool.handler(parsed.data, ctx);
    await db
      .update(advisorAuditLogTable)
      .set({
        status: "executed",
        beforeSnapshot: (beforeSnapshot ?? null) as any,
      })
      .where(eq(advisorAuditLogTable.id, auditLogId!));
    return { ok: true, toolName, result, auditLogId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, toolName, householdId: ctx.householdId }, "advisor: tool execution failed");
    await db
      .update(advisorAuditLogTable)
      .set({ status: "failed", errorMessage: errMsg })
      .where(eq(advisorAuditLogTable.id, auditLogId!));
    return { ok: false, toolName, error: errMsg, auditLogId };
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

const UNDO_WINDOW_MS = 5 * 60 * 1000;

export async function undoToolCall(
  auditLogId: string,
  ctx: ToolContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db
    .select()
    .from(advisorAuditLogTable)
    .where(eq(advisorAuditLogTable.id, auditLogId));

  if (!row) {
    return { ok: false, error: "Audit log row not found" };
  }
  if (row.householdId !== ctx.householdId) {
    return { ok: false, error: "Audit log row not found" };
  }
  if (row.status !== "executed") {
    return { ok: false, error: "Tool call is not in an undoable state" };
  }
  if (row.undoneAt !== null) {
    return { ok: false, error: "Tool call has already been undone" };
  }
  if (Date.now() - row.createdAt.getTime() > UNDO_WINDOW_MS) {
    return { ok: false, error: "Undo window expired" };
  }

  const tool = getToolByName(row.toolName);
  if (!tool || !tool.undoHandler) {
    return { ok: false, error: "Tool not undoable" };
  }

  try {
    await tool.undoHandler(row.beforeSnapshot, ctx);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, auditLogId, toolName: row.toolName, householdId: ctx.householdId },
      "advisor: undo handler failed",
    );
    return { ok: false, error: errMsg };
  }

  await db
    .update(advisorAuditLogTable)
    .set({ status: "undone", undoneAt: new Date() })
    .where(eq(advisorAuditLogTable.id, auditLogId));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tool: list_categories  (Phase 0 sanity check)
// ---------------------------------------------------------------------------

const listCategoriesInput = z.object({}).optional();

registerTool({
  name: "list_categories",
  description:
    "List all budget categories for the household. Use when the user asks what categories exist, or before suggesting category changes.",
  riskTier: "read",
  inputSchema: listCategoriesInput,
  jsonSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async (_input, ctx) => {
    const rows = await db
      .select({
        name: budgetCategoriesTable.name,
        sourceKind: budgetCategoriesTable.sourceKind,
        groupName: budgetCategoriesTable.groupName,
      })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, ctx.householdId));
    return {
      result: {
        count: rows.length,
        categories: rows,
      },
    };
  },
});
