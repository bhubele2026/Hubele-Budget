import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import {
  db,
  advisorAuditLogTable,
  advisorProposalsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  recurringItemsTable,
  mappingRulesTable,
  transactionsTable,
} from "@workspace/db";

// Importing the tool modules for their REGISTRATION side-effects — this is the
// same set index.ts pulls in at boot. Without these the registry is empty.
import "../lib/advisorReadTools";
import "../lib/advisorWriteTools";
import "../lib/advisorDestructiveTools";
import "../lib/advisorMemoryTools";
import "../lib/advisorMappingAndNotesTools";
import "../lib/advisorDebtAndSnapshotTools";
import "../lib/advisorCategoryTools";

import {
  dispatchTool,
  confirmProposal,
  cancelProposal,
  undoToolCall,
  getRegisteredTools,
  type ToolContext,
} from "../lib/advisorTools";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
let ctx: ToolContext;

// Two categories we recategorize between, plus a recurring item to mutate.
let DINING_CAT_ID: string;
let GROCERIES_CAT_ID: string;

async function cleanup(): Promise<void> {
  // Children before parents.
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db
    .delete(advisorAuditLogTable)
    .where(eq(advisorAuditLogTable.actorUserId, TEST_USER));
  await db
    .delete(advisorProposalsTable)
    .where(eq(advisorProposalsTable.actorUserId, TEST_USER));
}

async function seed(): Promise<void> {
  const [dining] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Dining Out", kind: "expense" })
    .returning({ id: budgetCategoriesTable.id });
  const [groceries] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Groceries", kind: "expense" })
    .returning({ id: budgetCategoriesTable.id });
  DINING_CAT_ID = dining!.id;
  GROCERIES_CAT_ID = groceries!.id;

  await db.insert(recurringItemsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    name: "Netflix",
    kind: "bill",
    amount: "15.99",
    frequency: "monthly",
    dayOfMonth: 14,
    active: "true",
  });
}

beforeAll(async () => {
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  ctx = {
    householdId: TEST_HOUSEHOLD_ID,
    householdOwnerId: TEST_USER,
    actorUserId: TEST_USER,
  };
  await cleanup();
  await seed();
});

afterAll(async () => {
  await cleanup();
});

// Snapshot of all money/budget-bearing row counts for this household. The
// core safety invariant: a destructive advisor tool must NOT change any of
// these before the user confirms the proposal.
async function moneyState() {
  const txns = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID));
  const lines = await db
    .select({ id: budgetLinesTable.id })
    .from(budgetLinesTable)
    .where(eq(budgetLinesTable.householdId, TEST_HOUSEHOLD_ID));
  const recurring = await db
    .select({ id: recurringItemsTable.id, amount: recurringItemsTable.amount, active: recurringItemsTable.active })
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, TEST_HOUSEHOLD_ID));
  return {
    txnCount: txns.length,
    lineCount: lines.length,
    recurring: recurring
      .map((r) => `${r.id}:${r.amount}:${r.active}`)
      .sort(),
  };
}

async function auditRowsFor(toolName: string) {
  return db
    .select()
    .from(advisorAuditLogTable)
    .where(
      and(
        eq(advisorAuditLogTable.actorUserId, TEST_USER),
        eq(advisorAuditLogTable.toolName, toolName),
      ),
    );
}

async function pendingProposalsFor(toolName: string) {
  return db
    .select()
    .from(advisorProposalsTable)
    .where(
      and(
        eq(advisorProposalsTable.actorUserId, TEST_USER),
        eq(advisorProposalsTable.toolName, toolName),
      ),
    );
}

describe("advisor audit + confirmation safety (M39/M40)", () => {
  it("registers the full destructive + reversible tool set", () => {
    const names = getRegisteredTools().map((t) => t.name);
    for (const expected of [
      "recategorize_transaction",
      "update_budget_line",
      "update_recurring_amount",
      "add_mapping_rule",
      "add_recurring_bill",
      "delete_recurring_bill",
      "update_recurring_schedule",
      "add_one_time_transaction",
      "delete_one_time_transaction",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("classifies the money-moving tools as destructive (confirmation-gated)", () => {
    const byName = new Map(getRegisteredTools().map((t) => [t.name, t]));
    for (const destructive of [
      "add_recurring_bill",
      "delete_recurring_bill",
      "update_recurring_schedule",
      "add_one_time_transaction",
      "delete_one_time_transaction",
    ]) {
      expect(byName.get(destructive)?.riskTier).toBe("destructive");
    }
  });

  // ---- Reversible writes: auto-execute, but ALWAYS audited + undoable ----

  it("recategorize_transaction: writes an executed audit row with a beforeSnapshot, and is undoable", async () => {
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-10",
        description: "STARBUCKS #123",
        amount: "-6.50",
        categoryId: GROCERIES_CAT_ID,
        source: "manual",
      })
      .returning({ id: transactionsTable.id });

    const r = await dispatchTool(
      "recategorize_transaction",
      { transactionId: txn!.id, newCategoryName: "Dining Out" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.auditLogId).toBeTruthy();

    // The mutation happened.
    const [after] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txn!.id));
    expect(after.categoryId).toBe(DINING_CAT_ID);

    // The audit row exists, is 'executed', and carries a non-null snapshot.
    const [audit] = await db
      .select()
      .from(advisorAuditLogTable)
      .where(eq(advisorAuditLogTable.id, r.auditLogId!));
    expect(audit.status).toBe("executed");
    expect(audit.beforeSnapshot).not.toBeNull();

    // Undo reverts the category and flips the audit row to 'undone'.
    const undo = await undoToolCall(r.auditLogId!, ctx);
    expect(undo.ok).toBe(true);
    const [reverted] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txn!.id));
    expect(reverted.categoryId).toBe(GROCERIES_CAT_ID);
    const [auditAfter] = await db
      .select()
      .from(advisorAuditLogTable)
      .where(eq(advisorAuditLogTable.id, r.auditLogId!));
    expect(auditAfter.status).toBe("undone");
    expect(auditAfter.undoneAt).not.toBeNull();
  });

  it("update_budget_line: audited + undoable (created row is deleted on undo)", async () => {
    const monthStart = "2026-05-01";
    const r = await dispatchTool(
      "update_budget_line",
      { categoryName: "Dining Out", monthStart, plannedAmount: 300 },
      ctx,
    );
    expect(r.ok).toBe(true);
    const [line] = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.householdId, TEST_HOUSEHOLD_ID),
          eq(budgetLinesTable.monthStart, monthStart),
          eq(budgetLinesTable.categoryId, DINING_CAT_ID),
        ),
      );
    expect(line).toBeTruthy();
    expect(line.plannedAmount).toBe("300.00");

    const [audit] = await db
      .select()
      .from(advisorAuditLogTable)
      .where(eq(advisorAuditLogTable.id, r.auditLogId!));
    expect(audit.status).toBe("executed");
    expect(audit.beforeSnapshot).not.toBeNull();

    const undo = await undoToolCall(r.auditLogId!, ctx);
    expect(undo.ok).toBe(true);
    const linesAfter = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.householdId, TEST_HOUSEHOLD_ID),
          eq(budgetLinesTable.monthStart, monthStart),
          eq(budgetLinesTable.categoryId, DINING_CAT_ID),
        ),
      );
    expect(linesAfter.length).toBe(0);
  });

  it("update_recurring_amount: audited + undoable", async () => {
    const r = await dispatchTool(
      "update_recurring_amount",
      { recurringItemName: "Netflix", newAmount: 19.99 },
      ctx,
    );
    expect(r.ok).toBe(true);
    const [item] = await db
      .select()
      .from(recurringItemsTable)
      .where(
        and(
          eq(recurringItemsTable.householdId, TEST_HOUSEHOLD_ID),
          eq(recurringItemsTable.name, "Netflix"),
        ),
      );
    expect(item.amount).toBe("19.99");

    const undo = await undoToolCall(r.auditLogId!, ctx);
    expect(undo.ok).toBe(true);
    const [reverted] = await db
      .select()
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.id, item.id));
    expect(reverted.amount).toBe("15.99");
  });

  // ---- The core M39 invariant: destructive tools cannot move money
  //      without an explicit confirmation. ----

  it("add_one_time_transaction does NOT mutate data until confirmed; the proposal flow inserts then undoes cleanly", async () => {
    const before = await moneyState();

    // Dispatch the destructive tool. This MUST only create a proposal — no
    // transaction row, no audit 'executed' row.
    const r = await dispatchTool(
      "add_one_time_transaction",
      {
        description: "Cash deposit",
        amount: 500,
        occurredOn: "2026-05-15",
        categoryName: "Groceries",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.proposal?.id).toBeTruthy();
    // Crucially: no auditLogId and no result yet — nothing executed.
    expect(r.auditLogId).toBeUndefined();
    expect(r.result).toBeUndefined();

    // No money moved.
    const mid = await moneyState();
    expect(mid).toEqual(before);
    // A pending proposal exists; NO executed audit row exists yet.
    const proposals = await pendingProposalsFor("add_one_time_transaction");
    expect(proposals.length).toBe(1);
    expect(proposals[0].status).toBe("pending");
    const preConfirmAudits = await auditRowsFor("add_one_time_transaction");
    expect(preConfirmAudits.length).toBe(0);

    // Confirm → now it executes, with an audit row + snapshot.
    const confirmed = await confirmProposal(r.proposal!.id, ctx);
    expect(confirmed.ok).toBe(true);
    expect(confirmed.auditLogId).toBeTruthy();
    const after = await moneyState();
    expect(after.txnCount).toBe(before.txnCount + 1);

    const [audit] = await db
      .select()
      .from(advisorAuditLogTable)
      .where(eq(advisorAuditLogTable.id, confirmed.auditLogId!));
    expect(audit.status).toBe("executed");
    expect(audit.beforeSnapshot).not.toBeNull();

    // The proposal is now 'confirmed', so a replay attempt is refused.
    const replay = await confirmProposal(r.proposal!.id, ctx);
    expect(replay.ok).toBe(false);

    // And it is undoable (deletes the inserted row).
    const undo = await undoToolCall(confirmed.auditLogId!, ctx);
    expect(undo.ok).toBe(true);
    const restored = await moneyState();
    expect(restored.txnCount).toBe(before.txnCount);
  });

  it("cancelling a destructive proposal never executes it (no audit row, no mutation)", async () => {
    const before = await moneyState();
    const r = await dispatchTool(
      "add_recurring_bill",
      { name: "Disney+", amount: 13.99, kind: "bill", frequency: "monthly", dayOfMonth: 5 },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.proposal?.id).toBeTruthy();

    const cancelled = await cancelProposal(r.proposal!.id, ctx);
    expect(cancelled.ok).toBe(true);

    // Nothing executed; a confirm after cancel is refused.
    const after = await moneyState();
    expect(after).toEqual(before);
    const confirmAfterCancel = await confirmProposal(r.proposal!.id, ctx);
    expect(confirmAfterCancel.ok).toBe(false);
    const audits = await auditRowsFor("add_recurring_bill");
    expect(audits.length).toBe(0);
  });

  it("a confirmed destructive proposal cannot be confirmed from a DIFFERENT household (scoping holds through the gate)", async () => {
    const r = await dispatchTool(
      "add_recurring_bill",
      { name: "Hulu", amount: 17.99, kind: "bill", frequency: "monthly", dayOfMonth: 9 },
      ctx,
    );
    expect(r.ok).toBe(true);
    const otherCtx: ToolContext = {
      householdId: randomUUID(),
      householdOwnerId: "someone-else",
      actorUserId: "someone-else",
    };
    const confirmed = await confirmProposal(r.proposal!.id, otherCtx);
    expect(confirmed.ok).toBe(false);
    // Clean up: cancel the still-pending proposal in the right household.
    await cancelProposal(r.proposal!.id, ctx);
  });

  it("delete_one_time_transaction is destructive-gated and undoable (restores the row)", async () => {
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-20",
        description: "Manual misc",
        amount: "-42.00",
        source: "manual",
      })
      .returning({ id: transactionsTable.id });
    const before = await moneyState();

    const r = await dispatchTool(
      "delete_one_time_transaction",
      { transactionId: txn!.id },
      ctx,
    );
    // Pre-confirm: still present.
    expect(r.proposal?.id).toBeTruthy();
    const mid = await moneyState();
    expect(mid).toEqual(before);

    const confirmed = await confirmProposal(r.proposal!.id, ctx);
    expect(confirmed.ok).toBe(true);
    const afterDelete = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txn!.id));
    expect(afterDelete.length).toBe(0);

    const undo = await undoToolCall(confirmed.auditLogId!, ctx);
    expect(undo.ok).toBe(true);
    const afterUndo = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txn!.id));
    expect(afterUndo.length).toBe(1);
  });

  it("refuses to delete a NON-manual (Plaid) transaction even after confirmation", async () => {
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-21",
        description: "PLAID CHARGE",
        amount: "-30.00",
        source: "plaid",
      })
      .returning({ id: transactionsTable.id });

    const r = await dispatchTool(
      "delete_one_time_transaction",
      { transactionId: txn!.id },
      ctx,
    );
    expect(r.proposal?.id).toBeTruthy();
    const confirmed = await confirmProposal(r.proposal!.id, ctx);
    // Handler throws → confirm fails, row survives, audit row is 'failed'.
    expect(confirmed.ok).toBe(false);
    const stillThere = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txn!.id));
    expect(stillThere.length).toBe(1);
    if (confirmed.auditLogId) {
      const [audit] = await db
        .select()
        .from(advisorAuditLogTable)
        .where(eq(advisorAuditLogTable.id, confirmed.auditLogId));
      expect(audit.status).toBe("failed");
    }
  });

  // ---- Cross-cutting invariant over EVERY write executed in this suite ----

  it("INVARIANT: every executed/confirmed advisor write recorded an audit row (no silent money mutation)", async () => {
    const audits = await db
      .select()
      .from(advisorAuditLogTable)
      .where(eq(advisorAuditLogTable.actorUserId, TEST_USER));

    // There is at least one executed write recorded.
    const executed = audits.filter((a) => a.status === "executed" || a.status === "undone");
    expect(executed.length).toBeGreaterThan(0);

    // Every executed write that touched money/budget data carries a
    // beforeSnapshot, which is what makes it undoable. (read-only tools and
    // no-op writes are excluded — they never reach 'executed' with a mutation.)
    const mutatingTools = new Set([
      "recategorize_transaction",
      "recategorize_by_pattern",
      "update_budget_line",
      "update_recurring_amount",
      "add_mapping_rule",
      "add_recurring_bill",
      "delete_recurring_bill",
      "update_recurring_schedule",
      "add_one_time_transaction",
      "delete_one_time_transaction",
    ]);
    for (const a of executed) {
      if (mutatingTools.has(a.toolName)) {
        expect(
          a.beforeSnapshot,
          `audit row ${a.id} for ${a.toolName} is executed but has no beforeSnapshot — not undoable`,
        ).not.toBeNull();
      }
    }

    // No destructive tool ever produced an 'auto_executed' audit row — that
    // status is reserved for reversible/read tools that skip the proposal
    // gate. A destructive tool reaching auto_executed would mean the
    // confirmation gate was bypassed.
    const destructiveNames = new Set([
      "add_recurring_bill",
      "delete_recurring_bill",
      "update_recurring_schedule",
      "add_one_time_transaction",
      "delete_one_time_transaction",
    ]);
    for (const a of audits) {
      if (destructiveNames.has(a.toolName)) {
        expect(a.status).not.toBe("auto_executed");
      }
    }
  });
});
