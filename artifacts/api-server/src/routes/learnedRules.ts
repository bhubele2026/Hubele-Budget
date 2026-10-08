// (PR-A) Learned rules = merchant memory, editable by the household.
import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, merchantMemoryTable, transactionsTable } from "@workspace/db";
import {
  ApplyLearnedRuleRetroactivelyParams,
  DeleteLearnedRuleParams,
  UpdateLearnedRuleBody,
  UpdateLearnedRuleParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { loadMemory, memoryRetroactiveIds } from "../lib/categorizer/memory";
import { categoryBelongs, recordUserDecisions } from "../lib/categorizer/userDecisions";
import { inArray } from "drizzle-orm";

const router: IRouter = Router();

function toLearnedRule(m: typeof merchantMemoryTable.$inferSelect) {
  return {
    id: m.id,
    signature: m.signature,
    scope: m.scope,
    plaidAccountId: m.plaidAccountId,
    amountBandLo: m.amountBandLo,
    amountBandHi: m.amountBandHi,
    categoryId: m.categoryId,
    count: m.count,
    lastConfirmedAt: m.lastConfirmedAt ? m.lastConfirmedAt.toISOString() : null,
    disabled: m.disabledAt != null,
    source: m.source,
    createdAt: m.createdAt.toISOString(),
  };
}

router.get("/learned-rules", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(merchantMemoryTable)
    .where(eq(merchantMemoryTable.householdId, req.householdId!))
    .orderBy(desc(merchantMemoryTable.count), merchantMemoryTable.signature, merchantMemoryTable.id);
  res.json(rows.map(toLearnedRule));
});

router.patch("/learned-rules/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateLearnedRuleParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const body = UpdateLearnedRuleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const cur = await loadMemory(req.householdId!, params.data.id);
  if (!cur) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const set: Partial<typeof merchantMemoryTable.$inferInsert> = {};
  if (body.data.categoryId !== undefined) {
    if (!(await categoryBelongs(req.householdId!, body.data.categoryId))) {
      res.status(400).json({ error: "Unknown category." });
      return;
    }
    set.categoryId = body.data.categoryId;
  }
  if (body.data.scope !== undefined && body.data.scope !== cur.scope) {
    if (body.data.scope === "merchant_account" && !cur.plaidAccountId) {
      res.status(400).json({ error: "This rule has no account to narrow to." });
      return;
    }
    if (body.data.scope === "merchant_amount" && (cur.amountBandLo == null || cur.amountBandHi == null)) {
      res.status(400).json({ error: "This rule has no amount band to narrow to." });
      return;
    }
    set.scope = body.data.scope;
  }
  if (body.data.disabled !== undefined) set.disabledAt = body.data.disabled ? new Date() : null;
  try {
    const [row] = Object.keys(set).length
      ? await db
          .update(merchantMemoryTable)
          .set(set)
          .where(and(eq(merchantMemoryTable.id, cur.id), eq(merchantMemoryTable.householdId, req.householdId!)))
          .returning()
      : await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.id, cur.id));
    res.json(toLearnedRule(row!));
  } catch (e) {
    if ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") {
      res.status(409).json({ error: "A learned rule with that scope already exists." });
      return;
    }
    throw e;
  }
});

router.delete("/learned-rules/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteLearnedRuleParams.safeParse(req.params);
  const gone = params.success
    ? await db
        .delete(merchantMemoryTable)
        .where(and(eq(merchantMemoryTable.id, params.data.id), eq(merchantMemoryTable.householdId, req.householdId!)))
        .returning({ id: merchantMemoryTable.id })
    : [];
  if (gone.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

/** Explicit request only: file the merchant's unlocked rows into the rule's category. */
router.post("/learned-rules/:id/apply-retroactively", requireAuth, async (req, res): Promise<void> => {
  const params = ApplyLearnedRuleRetroactivelyParams.safeParse(req.params);
  const m = params.success ? await loadMemory(req.householdId!, params.data.id) : null;
  if (!m) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // `dryRun` rides the query (the typed client) or the JSON body (raw callers).
  const rawQuery = (req.query as { dryRun?: unknown }).dryRun;
  const bodyDry = (req.body as { dryRun?: unknown } | undefined)?.dryRun;
  if (
    (rawQuery !== undefined && rawQuery !== "true" && rawQuery !== "false") ||
    (bodyDry !== undefined && typeof bodyDry !== "boolean")
  ) {
    res.status(400).json({ error: "dryRun must be true or false" });
    return;
  }
  const dryRun = rawQuery === "true" || bodyDry === true;
  const rows = await memoryRetroactiveIds(req.householdId!, m);
  // (PR-A2) dryRun: say what would move, write nothing.
  if (dryRun) {
    res.json({
      updated: 0,
      dryRun: true,
      count: rows.length,
      sample: rows.slice(0, 5).map((r) => ({
        transactionId: r.id,
        description: r.description,
        occurredOn: r.occurredOn,
        amount: r.amount,
      })),
    });
    return;
  }
  if (rows.length === 0) {
    res.json({ updated: 0 });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const done = await tx
      .update(transactionsTable)
      .set({ categoryId: m.categoryId, categoryLockedByUser: true, categoryProvisional: false })
      .where(
        and(
          eq(transactionsTable.householdId, req.householdId!),
          eq(transactionsTable.categoryLockedByUser, false),
          inArray(transactionsTable.id, rows.map((r) => r.id)),
        ),
      )
      .returning({ id: transactionsTable.id });
    const before = new Map(rows.map((r) => [r.id, r.categoryId] as const));
    await recordUserDecisions(
      tx,
      req.householdId!,
      req.userId!,
      done.map((r) => ({ transactionId: r.id, previousCategoryId: before.get(r.id) ?? null, categoryId: m.categoryId })),
      { explanation: "You applied a learned rule to this charge." },
    );
    return done.length;
  });
  res.json({ updated });
});

export default router;
