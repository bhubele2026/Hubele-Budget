import { Router, type IRouter } from "express";
import { and, eq, asc } from "drizzle-orm";
import { db, debtsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateDebtBody,
  UpdateDebtBody,
  UpdateDebtParams,
  DeleteDebtParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/debts", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.userId, req.userId!))
    .orderBy(asc(debtsTable.name));
  res.json(rows);
});

router.post("/debts", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateDebtBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(debtsTable)
    .values({ ...parsed.data, userId: req.userId! })
    .returning();
  res.status(201).json(row);
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
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(
      and(eq(debtsTable.id, params.data.id), eq(debtsTable.userId, req.userId!)),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.delete("/debts/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteDebtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await db
    .delete(debtsTable)
    .where(
      and(eq(debtsTable.id, params.data.id), eq(debtsTable.userId, req.userId!)),
    );
  res.sendStatus(204);
});

export default router;
