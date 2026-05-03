import { Router, type IRouter } from "express";
import { and, eq, asc } from "drizzle-orm";
import { db, recurringItemsTable, debtsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateRecurringItemBody,
  UpdateRecurringItemBody,
  UpdateRecurringItemParams,
  DeleteRecurringItemParams,
} from "@workspace/api-zod";
import { archiveExpiredOneTime } from "./bills";

const router: IRouter = Router();

async function userOwnsDebt(userId: string, debtId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: debtsTable.id })
    .from(debtsTable)
    .where(and(eq(debtsTable.id, debtId), eq(debtsTable.userId, userId)))
    .limit(1);
  return !!row;
}

router.get("/recurring-items", requireAuth, async (req, res): Promise<void> => {
  await archiveExpiredOneTime(req.userId!);
  const rows = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, req.userId!))
    .orderBy(asc(recurringItemsTable.kind), asc(recurringItemsTable.name));
  res.json(rows);
});

router.post("/recurring-items", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateRecurringItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.debtId && !(await userOwnsDebt(req.userId!, parsed.data.debtId))) {
    res.status(400).json({ error: "Invalid debtId" });
    return;
  }
  const [row] = await db
    .insert(recurringItemsTable)
    .values({ ...parsed.data, userId: req.userId! })
    .returning();
  res.status(201).json(row);
});

router.patch(
  "/recurring-items/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UpdateRecurringItemParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateRecurringItemBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (parsed.data.debtId && !(await userOwnsDebt(req.userId!, parsed.data.debtId))) {
      res.status(400).json({ error: "Invalid debtId" });
      return;
    }
    const [row] = await db
      .update(recurringItemsTable)
      .set(parsed.data)
      .where(
        and(
          eq(recurringItemsTable.id, params.data.id),
          eq(recurringItemsTable.userId, req.userId!),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/recurring-items/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteRecurringItemParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(recurringItemsTable)
      .where(
        and(
          eq(recurringItemsTable.id, params.data.id),
          eq(recurringItemsTable.userId, req.userId!),
        ),
      );
    res.sendStatus(204);
  },
);

export default router;
