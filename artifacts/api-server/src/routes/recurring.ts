import { Router, type IRouter } from "express";
import { and, eq, asc } from "drizzle-orm";
import {
  db,
  recurringItemsTable,
  debtsTable,
  budgetCategoriesTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateRecurringItemBody,
  UpdateRecurringItemBody,
  UpdateRecurringItemParams,
  DeleteRecurringItemParams,
} from "@workspace/api-zod";
import { archiveExpiredOneTime } from "./bills";
import { MY_BUDGET_GROUP } from "./budget";

const router: IRouter = Router();

async function householdOwnsDebt(householdId: string, debtId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: debtsTable.id })
    .from(debtsTable)
    .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)))
    .limit(1);
  return !!row;
}

// Task #690 guard — the Bills modal filters "My budget" categories out
// of its picker (that bucket is for personal envelopes explicitly not
// tied to a bill), but we also enforce it server-side so an API client
// can't sneak a bill into the manual bucket and pollute its aggregate.
// Returns `{ ok: false, reason }` if the link should be rejected.
async function validateBillCategoryLink(
  householdId: string,
  categoryId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [cat] = await db
    .select({
      id: budgetCategoriesTable.id,
      groupName: budgetCategoriesTable.groupName,
      householdId: budgetCategoriesTable.householdId,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.id, categoryId))
    .limit(1);
  if (!cat || cat.householdId !== householdId) {
    return { ok: false, reason: "Invalid categoryId" };
  }
  if (cat.groupName === MY_BUDGET_GROUP) {
    return {
      ok: false,
      reason:
        "Bills cannot be linked to 'My budget' categories — that bucket is for personal envelopes not tied to a bill.",
    };
  }
  return { ok: true };
}

router.get("/recurring-items", requireAuth, async (req, res): Promise<void> => {
  await archiveExpiredOneTime(req.householdId!);
  const rows = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, req.householdId!))
    .orderBy(asc(recurringItemsTable.kind), asc(recurringItemsTable.name));
  res.json(rows);
});

router.post("/recurring-items", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateRecurringItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.debtId && !(await householdOwnsDebt(req.householdId!, parsed.data.debtId))) {
    res.status(400).json({ error: "Invalid debtId" });
    return;
  }
  if (parsed.data.categoryId) {
    const check = await validateBillCategoryLink(
      req.householdId!,
      parsed.data.categoryId,
    );
    if (!check.ok) {
      res.status(400).json({ error: check.reason });
      return;
    }
  }
  const [row] = await db
    .insert(recurringItemsTable)
    .values({ ...parsed.data, userId: req.userId!, householdId: req.householdId! })
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
    if (parsed.data.debtId && !(await householdOwnsDebt(req.householdId!, parsed.data.debtId))) {
      res.status(400).json({ error: "Invalid debtId" });
      return;
    }
    if (parsed.data.categoryId) {
      const check = await validateBillCategoryLink(
        req.householdId!,
        parsed.data.categoryId,
      );
      if (!check.ok) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }
    const [row] = await db
      .update(recurringItemsTable)
      .set(parsed.data)
      .where(
        and(
          eq(recurringItemsTable.id, params.data.id),
          eq(recurringItemsTable.householdId, req.householdId!),
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
          eq(recurringItemsTable.householdId, req.householdId!),
        ),
      );
    res.sendStatus(204);
  },
);

export default router;
