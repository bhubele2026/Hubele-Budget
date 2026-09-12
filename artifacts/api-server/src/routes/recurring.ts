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
import {
  clearPendingReviews,
  moveOneTimeResolutions,
  oneTimeEdit,
  type OneTimeMoveResult,
} from "../lib/oneTimeBillMove";
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
    // ⭐ (One-time bill move) The item update and the re-check of its answers are
    // one transaction. A one-time bill whose date, amount or kind changed keeps its
    // answers on its date; a pair the edit puts in question needs review (or is
    // cleared when Review could not show it). A bill that stops being one-time, or
    // is edited while paused, drops its pending reviews; a pause alone keeps them
    // (round 4). The response carries what
    // happened as `moveResult`, so the Bills page can say it. Bank rows are never
    // written. See `lib/oneTimeBillMove.ts`.
    const householdId = req.householdId!;
    const ownerUserId = req.householdOwnerId!;
    const outcome = await db.transaction(async (tx) => {
      const where = and(
        eq(recurringItemsTable.id, params.data.id),
        eq(recurringItemsTable.householdId, householdId),
      );
      const [before] = await tx
        .select({
          frequency: recurringItemsTable.frequency,
          anchorDate: recurringItemsTable.anchorDate,
          kind: recurringItemsTable.kind,
          amount: recurringItemsTable.amount,
        })
        .from(recurringItemsTable)
        .where(where)
        .for("update");
      if (!before) return null;
      const [updated] = await tx.update(recurringItemsTable).set(parsed.data).where(where).returning();
      if (!updated) return null;
      let moveResult: OneTimeMoveResult | undefined;
      const edit = oneTimeEdit(before, updated);
      if (edit) moveResult = await moveOneTimeResolutions(tx, { householdId, ownerUserId }, updated.id, edit);
      const leftOneTime = before.frequency === "onetime" && updated.frequency !== "onetime";
      // (Round 4) Pausing alone KEEPS a pending review: while the bill is paused
      // every reader takes it as the user's last answer (`readPausedReview`), and
      // resuming brings the question back unchanged. An edit saved on a paused bill
      // drops it, and the save's toast reports that through `moveResult`.
      if (leftOneTime || (updated.active !== "true" && edit)) {
        const dropped = await clearPendingReviews(tx, householdId, updated.id);
        if (moveResult) moveResult = { carried: moveResult.carried, needsReview: 0, cleared: moveResult.cleared + dropped };
        else if (dropped > 0) moveResult = { carried: 0, needsReview: 0, cleared: dropped };
      }
      return { row: updated, moveResult };
    });
    if (!outcome) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(outcome.moveResult ? { ...outcome.row, moveResult: outcome.moveResult } : outcome.row);
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
    const householdId = req.householdId!;
    // (One-time bill move, round 3) A deleted bill's pending review would keep
    // claiming its bank row with no bill to answer it on, so the row could never
    // pay another bill. Older matches and partials on a deleted bill are left as
    // they were (see the review note's residuals).
    await db.transaction(async (tx) => {
      const gone = await tx
        .delete(recurringItemsTable)
        .where(
          and(
            eq(recurringItemsTable.id, params.data.id),
            eq(recurringItemsTable.householdId, householdId),
          ),
        )
        .returning({ id: recurringItemsTable.id });
      if (gone.length > 0) await clearPendingReviews(tx, householdId, gone.map((g) => g.id));
    });
    res.sendStatus(204);
  },
);

export default router;
