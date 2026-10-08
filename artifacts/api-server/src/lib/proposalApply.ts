import { and, eq } from "drizzle-orm";
import {
  agentActionsTable,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  db,
  recurringItemsTable,
  type AgentProposal,
} from "@workspace/db";
import { recordHandFiling, setCategoryByHand, categoryBelongs } from "./categorizer/userDecisions";
import { writeOwnerAllowancePlan } from "./allowancePlanWriter";
import { syncAvalanchePaymentCategory } from "../routes/avalanche";
import { householdTodayISO } from "./householdClock";
import { monthStartOf, type PlanPayload } from "./proposalTargets";

// (AI-2) THE ONLY PLACE A PROPOSAL BECOMES A CHANGE — called by
// POST /agent/proposals/:id/approve for a signed-in person, never by the
// model. Each branch goes through the writer the app already uses for that
// change; each records one agent_actions row on the run that proposed it.
//
// ⚠️ Nothing under src/ai or src/jobs imports this file.

export interface Approver {
  householdId: string;
  ownerUserId: string;
  actorUserId: string;
  isOwner: boolean;
}

export type ApplyResult =
  | { ok: true; actionId: string }
  | { ok: false; status: 403 | 404 | 409; error: string };

async function recordAction(
  p: AgentProposal,
  row: { type: "set_category" | "propose"; targetKind: string; targetId: string | null; before: unknown; after: unknown; reversible: boolean },
): Promise<string> {
  const [a] = await db
    .insert(agentActionsTable)
    .values({ householdId: p.householdId, runId: p.runId, outcome: "applied", ...row })
    .returning({ id: agentActionsTable.id });
  return a!.id;
}

export async function applyProposal(p: AgentProposal, who: Approver): Promise<ApplyResult> {
  const payload = p.payload as PlanPayload & { txnId?: string; categoryId?: string; previousCategoryId?: string | null };
  const { householdId } = who;
  if (p.kind === "set_category") {
    const txnId = payload.txnId;
    const categoryId = payload.categoryId;
    if (!txnId || !categoryId || !(await categoryBelongs(householdId, categoryId))) {
      return { ok: false, status: 404, error: "That category no longer exists." };
    }
    const set = await setCategoryByHand(householdId, txnId, categoryId);
    if (!set) return { ok: false, status: 404, error: "That charge no longer exists." };
    const filed = await recordHandFiling(householdId, who.actorUserId, txnId, { previousCategoryId: set.previousCategoryId, categoryId });
    const actionId = await recordAction(p, {
      type: "set_category",
      targetKind: "transaction",
      targetId: txnId,
      before: { categoryId: set.previousCategoryId },
      after: { categoryId, decisionId: filed?.decisionId ?? null },
      reversible: !!filed,
    });
    return { ok: true, actionId };
  }

  const amount = Number(payload.after);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, status: 409, error: "This proposal has no usable amount." };
  const fixed = amount.toFixed(2);

  if (p.kind === "weekly_limit") {
    if (!who.isOwner) return { ok: false, status: 403, error: "Only the household owner sets the weekly limit." };
    const r = await writeOwnerAllowancePlan(householdId, payload.target, { amount: fixed });
    if (!r.ok) return { ok: false, status: r.reason === "conflict" ? 409 : 404, error: r.reason === "conflict" ? "Another plan already starts that day." : "That plan no longer exists." };
    return {
      ok: true,
      actionId: await recordAction(p, { type: "propose", targetKind: "weekly_limit", targetId: payload.target, before: { amount: payload.before }, after: { amount }, reversible: false }),
    };
  }

  if (p.kind === "budget_line") {
    const [cat] = await db
      .select({ id: budgetCategoriesTable.id })
      .from(budgetCategoriesTable)
      .where(and(eq(budgetCategoriesTable.id, payload.target), eq(budgetCategoriesTable.householdId, householdId)));
    if (!cat) return { ok: false, status: 404, error: "That budget line no longer exists." };
    // The same upsert POST /budget/lines makes, for the current household month.
    const monthStart = monthStartOf(householdTodayISO());
    await db.insert(budgetMonthsTable).values({ userId: who.ownerUserId, householdId, monthStart }).onConflictDoNothing();
    const [existing] = await db
      .select({ id: budgetLinesTable.id })
      .from(budgetLinesTable)
      .where(and(eq(budgetLinesTable.householdId, householdId), eq(budgetLinesTable.monthStart, monthStart), eq(budgetLinesTable.categoryId, cat.id)));
    if (existing) {
      await db.update(budgetLinesTable).set({ plannedAmount: fixed }).where(eq(budgetLinesTable.id, existing.id));
    } else {
      await db.insert(budgetLinesTable).values({ userId: who.ownerUserId, householdId, monthStart, categoryId: cat.id, plannedAmount: fixed });
    }
    return {
      ok: true,
      actionId: await recordAction(p, { type: "propose", targetKind: "budget_line", targetId: cat.id, before: { plannedAmount: payload.before, monthStart }, after: { plannedAmount: amount, monthStart }, reversible: false }),
    };
  }

  if (p.kind === "extra_debt_payment") {
    await db
      .insert(avalancheSettingsTable)
      .values({ userId: who.ownerUserId, householdId, manualExtra: fixed })
      .onConflictDoUpdate({ target: avalancheSettingsTable.userId, set: { manualExtra: fixed, updatedAt: new Date() } });
    await syncAvalanchePaymentCategory(householdId, who.ownerUserId, monthStartOf(householdTodayISO()));
    return {
      ok: true,
      actionId: await recordAction(p, { type: "propose", targetKind: "extra_debt_payment", targetId: null, before: { manualExtra: payload.before }, after: { manualExtra: amount }, reversible: false }),
    };
  }

  // bill_amount
  const [item] = await db
    .select({ id: recurringItemsTable.id, frequency: recurringItemsTable.frequency })
    .from(recurringItemsTable)
    .where(and(eq(recurringItemsTable.id, payload.target), eq(recurringItemsTable.householdId, householdId)));
  if (!item) return { ok: false, status: 404, error: "That bill no longer exists." };
  if (item.frequency === "onetime") return { ok: false, status: 409, error: "A one-time bill is changed on the Bills page." };
  await db.update(recurringItemsTable).set({ amount: fixed }).where(and(eq(recurringItemsTable.id, item.id), eq(recurringItemsTable.householdId, householdId)));
  return {
    ok: true,
    actionId: await recordAction(p, { type: "propose", targetKind: "bill_amount", targetId: item.id, before: { amount: payload.before }, after: { amount }, reversible: false }),
  };
}
