import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { CreateGoalBody, DeleteGoalParams, UpdateGoalBody, UpdateGoalParams } from "@workspace/api-zod";
import { db, forecastSettingsTable, goalsTable, plaidAccountsTable, type Goal } from "@workspace/db";
import { addDaysISO, goalReserveCents } from "@workspace/avalanche-core";
import { requireAuth } from "../middlewares/requireAuth";
import { goalMathRow, goalViews, listGoals } from "../lib/goals";

// ⭐ (PR-C) GOALS — savings, buffer, sinking and debt-payoff goals, with the
// money a goal holds back in checking. Household-scoped: any member reads and
// edits the household's goals; nothing here computes a figure (lib/goals.ts →
// avalanche-core). No model ever writes a goal.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router: IRouter = Router();

class GoalInputError extends Error {}

/** A calendar date maps to itself; "2026-02-30" does not. */
function checkDate(d: string | null | undefined): void {
  if (d && addDaysISO(d, 0) !== d) throw new GoalInputError("targetDate is not a calendar date");
}

function checkPriority(p: number | undefined): void {
  if (p !== undefined && !Number.isInteger(p)) throw new GoalInputError("priority is a whole number");
}

/**
 * The account that backs a goal: one of THIS household's accounts, a deposit
 * account, and never checking — progress is read from savings, never from the
 * checking balance the position already counts.
 */
async function checkBackingAccount(householdId: string, ownerUserId: string, id: string | null | undefined) {
  if (!id) return;
  if (!UUID_RE.test(id)) throw new GoalInputError("plaidAccountId names no account of this household");
  const [[acct], [settings]] = await Promise.all([
    db
      .select({ id: plaidAccountsTable.id, type: plaidAccountsTable.type, subtype: plaidAccountsTable.subtype })
      .from(plaidAccountsTable)
      .where(and(eq(plaidAccountsTable.id, id), eq(plaidAccountsTable.householdId, householdId))),
    db
      .select({ bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId)),
  ]);
  if (!acct) throw new GoalInputError("plaidAccountId names no account of this household");
  if (acct.type !== "depository" || acct.subtype === "checking" || acct.id === settings?.bankSnapshotAccountId) {
    throw new GoalInputError("a goal is backed by a savings account, never by checking");
  }
}

async function findGoal(householdId: string, id: string): Promise<Goal | null> {
  if (!UUID_RE.test(id)) return null;
  const [g] = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.id, id), eq(goalsTable.householdId, householdId)));
  return g ?? null;
}

/** (PR-C) The household's goals with progress, the reserve and the buffer beside them. Read-only. */
router.get("/goals", requireAuth, async (req, res): Promise<void> => {
  const includeArchived = req.query.include === "archived";
  res.json(await listGoals(req.householdId!, req.householdOwnerId!, { includeArchived }));
});

/** (PR-C) Add a goal. */
router.post("/goals", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateGoalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const b = parsed.data;
  try {
    checkDate(b.targetDate);
    checkPriority(b.priority);
    await checkBackingAccount(req.householdId!, req.householdOwnerId!, b.plaidAccountId);
  } catch (e) {
    if (e instanceof GoalInputError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
  const [g] = await db
    .insert(goalsTable)
    .values({
      householdId: req.householdId!,
      name: b.name.trim(),
      kind: b.kind,
      targetAmount: b.targetAmount ?? null,
      manualCurrentAmount: b.manualCurrentAmount ?? "0",
      plaidAccountId: b.plaidAccountId ?? null,
      monthlyContribution: b.monthlyContribution ?? "0",
      targetDate: b.targetDate ?? null,
      reservedInChecking: b.reservedInChecking ?? false,
      priority: b.priority ?? 0,
      createdBy: req.actualUserId ?? null,
    })
    .returning();
  const [view] = await goalViews(req.householdId!, req.householdOwnerId!, [g!]);
  res.status(201).json(view);
});

/** (PR-C) Edit a goal. */
router.patch("/goals/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateGoalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateGoalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await findGoal(req.householdId!, params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const b = parsed.data;
  try {
    checkDate(b.targetDate);
    checkPriority(b.priority);
    if (b.plaidAccountId !== undefined) await checkBackingAccount(req.householdId!, req.householdOwnerId!, b.plaidAccountId);
  } catch (e) {
    if (e instanceof GoalInputError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
  const set: Partial<typeof goalsTable.$inferInsert> = { updatedAt: new Date() };
  if (b.name !== undefined) set.name = b.name.trim();
  if (b.kind !== undefined) set.kind = b.kind;
  if (b.status !== undefined) set.status = b.status;
  if (b.targetAmount !== undefined) set.targetAmount = b.targetAmount;
  if (b.manualCurrentAmount !== undefined) set.manualCurrentAmount = b.manualCurrentAmount;
  if (b.plaidAccountId !== undefined) set.plaidAccountId = b.plaidAccountId;
  if (b.monthlyContribution !== undefined) set.monthlyContribution = b.monthlyContribution;
  if (b.targetDate !== undefined) set.targetDate = b.targetDate;
  if (b.reservedInChecking !== undefined) set.reservedInChecking = b.reservedInChecking;
  if (b.priority !== undefined) set.priority = b.priority;
  const [g] = await db
    .update(goalsTable)
    .set(set)
    .where(and(eq(goalsTable.id, existing.id), eq(goalsTable.householdId, req.householdId!)))
    .returning();
  const [view] = await goalViews(req.householdId!, req.householdOwnerId!, [g!]);
  res.json(view);
});

/**
 * (PR-C) Remove a goal. A goal that has a reserve (money it holds back in
 * checking) is ARCHIVED, not deleted — the record of that money stays, and the
 * reserve is released because only active goals hold one.
 */
router.delete("/goals/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteGoalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const existing = await findGoal(req.householdId!, params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const hasReserve = goalReserveCents({ ...goalMathRow(existing), status: "active" }) > 0;
  if (hasReserve) {
    await db
      .update(goalsTable)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(goalsTable.id, existing.id), eq(goalsTable.householdId, req.householdId!)));
    res.json({ id: existing.id, outcome: "archived" });
    return;
  }
  await db.delete(goalsTable).where(and(eq(goalsTable.id, existing.id), eq(goalsTable.householdId, req.householdId!)));
  res.json({ id: existing.id, outcome: "deleted" });
});

export default router;
