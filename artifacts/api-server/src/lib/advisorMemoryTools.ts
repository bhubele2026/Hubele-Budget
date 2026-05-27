import { z } from "zod";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, advisorMemoryTable } from "@workspace/db";
import { registerTool } from "./advisorTools";

const KINDS = ["preference", "recurring_event", "goal", "context", "other"] as const;

interface RememberSnapshot {
  kind: "remember";
  memoryId: string;
}
interface ForgetSnapshot {
  kind: "forget";
  memory: {
    id: string;
    householdId: string;
    actorUserId: string;
    content: string;
    memoryKind: string;
    createdAt: string;
    expiresAt: string | null;
  };
}

const rememberInput = z.object({
  content: z.string().min(2).max(500).describe("The fact to remember. 1-2 sentences."),
  kind: z
    .enum(KINDS)
    .optional()
    .describe("Soft category: preference, recurring_event, goal, context, other. Default 'context'."),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe("Auto-expire after N days. Use for time-bound facts. Omit for permanent."),
});

registerTool({
  name: "remember",
  description:
    "Persist a short fact about the household that should inform future advice (e.g. 'Hannah's bonus lands in March', 'saving for Italy trip in August', 'Brad's freelance income is irregular and averages $1,200/mo'). Use when the user explicitly asks you to remember something, or when they share durable context worth keeping. Undoable for 5 minutes.",
  riskTier: "reversible",
  inputSchema: rememberInput,
  jsonSchema: {
    type: "object",
    properties: {
      content: { type: "string", minLength: 2, maxLength: 500 },
      kind: { type: "string", enum: [...KINDS] },
      expiresInDays: { type: "integer", minimum: 1, maximum: 3650 },
    },
    required: ["content"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86400 * 1000)
      : null;
    const [inserted] = await db
      .insert(advisorMemoryTable)
      .values({
        householdId: ctx.householdId,
        actorUserId: ctx.actorUserId,
        content: input.content,
        kind: input.kind ?? "context",
        expiresAt,
      })
      .returning();
    return {
      result: {
        ok: true,
        id: inserted.id,
        content: inserted.content,
        kind: inserted.kind,
        expiresAt: inserted.expiresAt?.toISOString() ?? null,
      },
      beforeSnapshot: { kind: "remember", memoryId: inserted.id } as RememberSnapshot,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as RememberSnapshot;
    if (snap?.kind !== "remember") throw new Error("Snapshot shape mismatch");
    await db
      .delete(advisorMemoryTable)
      .where(
        and(
          eq(advisorMemoryTable.id, snap.memoryId),
          eq(advisorMemoryTable.householdId, ctx.householdId),
        ),
      );
  },
});

const listMemoriesInput = z.object({}).optional();

registerTool({
  name: "list_memories",
  description:
    "List all currently-active memories for this household. Use when the user asks 'what do you remember' or before deciding whether to add a duplicate memory.",
  riskTier: "read",
  inputSchema: listMemoriesInput,
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_input, ctx) => {
    const rows = await db
      .select()
      .from(advisorMemoryTable)
      .where(
        and(
          eq(advisorMemoryTable.householdId, ctx.householdId),
          or(isNull(advisorMemoryTable.expiresAt), gt(advisorMemoryTable.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(advisorMemoryTable.createdAt));
    return {
      result: {
        count: rows.length,
        memories: rows.map((r) => ({
          id: r.id,
          content: r.content,
          kind: r.kind,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt?.toISOString() ?? null,
        })),
      },
    };
  },
});

const forgetInput = z.object({
  memoryId: z.string().uuid().describe("ID of the memory to delete (get from list_memories)."),
});

registerTool({
  name: "forget",
  description:
    "Delete a stored memory. Use when the user says 'forget that' or 'you can stop remembering X'. Undoable for 5 minutes.",
  riskTier: "reversible",
  inputSchema: forgetInput,
  jsonSchema: {
    type: "object",
    properties: { memoryId: { type: "string", format: "uuid" } },
    required: ["memoryId"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const [existing] = await db
      .select()
      .from(advisorMemoryTable)
      .where(
        and(
          eq(advisorMemoryTable.id, input.memoryId),
          eq(advisorMemoryTable.householdId, ctx.householdId),
        ),
      );
    if (!existing) throw new Error(`Memory ${input.memoryId} not found.`);
    await db.delete(advisorMemoryTable).where(eq(advisorMemoryTable.id, existing.id));
    const snap: ForgetSnapshot = {
      kind: "forget",
      memory: {
        id: existing.id,
        householdId: existing.householdId,
        actorUserId: existing.actorUserId,
        content: existing.content,
        memoryKind: existing.kind,
        createdAt: existing.createdAt.toISOString(),
        expiresAt: existing.expiresAt?.toISOString() ?? null,
      },
    };
    return {
      result: { ok: true, forgotten: existing.content },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as ForgetSnapshot;
    if (snap?.kind !== "forget") throw new Error("Snapshot shape mismatch");
    await db.insert(advisorMemoryTable).values({
      id: snap.memory.id,
      householdId: snap.memory.householdId,
      actorUserId: snap.memory.actorUserId,
      content: snap.memory.content,
      kind: snap.memory.memoryKind,
      createdAt: new Date(snap.memory.createdAt),
      expiresAt: snap.memory.expiresAt ? new Date(snap.memory.expiresAt) : null,
    });
  },
});
