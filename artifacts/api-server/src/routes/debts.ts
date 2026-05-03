import { Router, type IRouter } from "express";
import { and, desc, eq, asc, gte, sql } from "drizzle-orm";
import { db, debtsTable, transactionsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateDebtBody,
  UpdateDebtBody,
  UpdateDebtParams,
  DeleteDebtParams,
  CreateDebtPaymentBody,
  CreateDebtPaymentParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function normalize<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (typeof out.lastBalanceUpdate === "string") {
    out.lastBalanceUpdate = new Date(out.lastBalanceUpdate as string);
  }
  return out;
}

router.get("/debts", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.userId, req.userId!))
    .orderBy(asc(debtsTable.sortOrder), desc(debtsTable.apr), asc(debtsTable.name));
  res.json(rows);
});

router.post("/debts", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateDebtBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [{ maxOrder }] = await db
    .select({ maxOrder: sql<number>`coalesce(max(${debtsTable.sortOrder}), 0)` })
    .from(debtsTable)
    .where(eq(debtsTable.userId, req.userId!));
  const values = normalize({ ...parsed.data, userId: req.userId! });
  if (values.sortOrder == null) values.sortOrder = (maxOrder ?? 0) + 1;
  const [row] = await db
    .insert(debtsTable)
    .values(values as typeof debtsTable.$inferInsert)
    .returning();
  res.status(201).json(row);
});

router.post("/debts/sync-minimums", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const debts = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId));
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceISO = since.toISOString().slice(0, 10);
  const txns = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        gte(transactionsTable.occurredOn, sinceISO),
      ),
    );
  const updated: { id: string; name: string; oldMin: string; newMin: string }[] = [];
  for (const d of debts) {
    if (d.status !== "active") continue;
    const needle = d.name.toLowerCase();
    const matches = txns.filter((t) => {
      const desc = (t.description ?? "").toLowerCase();
      const amt = Number(t.amount);
      return amt < 0 && desc.includes(needle);
    });
    if (matches.length === 0) continue;
    matches.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
    const recent = Math.abs(Number(matches[0].amount));
    const oldMin = Number(d.minPayment);
    if (Math.abs(recent - oldMin) < 0.01) continue;
    const newMinStr = recent.toFixed(2);
    await db
      .update(debtsTable)
      .set({ minPayment: newMinStr, updatedAt: new Date() })
      .where(and(eq(debtsTable.id, d.id), eq(debtsTable.userId, userId)));
    updated.push({
      id: d.id,
      name: d.name,
      oldMin: oldMin.toFixed(2),
      newMin: newMinStr,
    });
  }
  res.json({ updated });
});

router.patch("/debts/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateDebtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateDebtBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(debtsTable)
    .set({ ...normalize(parsed.data), updatedAt: new Date() })
    .where(
      and(eq(debtsTable.id, String(params.data.id)), eq(debtsTable.userId, req.userId!)),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.post(
  "/debts/:id/payments",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateDebtPaymentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateDebtPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const debtId = String(params.data.id);
    const userId = req.userId!;
    const amount = Number(parsed.data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be > 0" });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [debt] = await tx
        .select()
        .from(debtsTable)
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)));
      if (!debt) return null;
      const oldBal = Number(debt.balance);
      const newBal = Math.max(0, oldBal - amount);
      const occurredOn = parsed.data.occurredOn;
      const [txn] = await tx
        .insert(transactionsTable)
        .values({
          userId,
          occurredOn,
          description: `Payment — ${debt.name}`,
          amount: (-Math.abs(amount)).toFixed(2),
          account: parsed.data.account ?? null,
          notes: parsed.data.notes ?? null,
          source: "manual",
          member: null,
        })
        .returning();
      const [updated] = await tx
        .update(debtsTable)
        .set({
          balance: newBal.toFixed(2),
          lastBalanceUpdate: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)))
        .returning();
      return { debt: updated, transaction: txn };
    });
    if (!result) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(201).json(result);
  },
);

router.delete("/debts/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteDebtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db
    .delete(debtsTable)
    .where(
      and(eq(debtsTable.id, String(params.data.id)), eq(debtsTable.userId, req.userId!)),
    );
  res.sendStatus(204);
});

export default router;
