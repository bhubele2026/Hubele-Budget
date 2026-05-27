import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  forecastSettingsTable,
} from "@workspace/db";
import { registerTool } from "./advisorTools";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveDebt(householdId: string, needle: string) {
  const rows = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));
  const lower = needle.toLowerCase().trim();
  const exact = rows.filter((r) => r.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = rows.filter((r) => r.name.toLowerCase().includes(lower));
  if (partial.length === 0) throw new Error(`No debt matches "${needle}".`);
  if (partial.length > 1) {
    const names = partial.map((r) => r.name).slice(0, 8).join(", ");
    throw new Error(`Multiple debts match "${needle}": ${names}. Use the exact name.`);
  }
  return partial[0];
}

// Snapshots
interface AddDebtSnapshot {
  kind: "add_debt";
  debtId: string;
}
interface UpdateDebtBalanceSnapshot {
  kind: "update_debt_balance";
  debtId: string;
  previousBalance: string;
  previousLastUpdate: string | null;
}
interface ArchiveDebtSnapshot {
  kind: "archive_debt";
  debtId: string;
  previousStatus: string;
}
interface RecordDebtPaymentSnapshot {
  kind: "record_debt_payment";
  transactionId: string;
  previousDebtBalance: string;
  debtId: string;
}
interface UpdateBankSnapshotSnapshot {
  kind: "update_bank_snapshot";
  userId: string;
  previous: {
    bankSnapshotBalance: string | null;
    bankSnapshotAt: string | null;
    bankSnapshotSource: string | null;
  };
}

// ---------------------------------------------------------------------------
// Tool: add_debt
// ---------------------------------------------------------------------------

const addDebtInput = z.object({
  name: z.string().min(1).max(100).describe("Display name (e.g. 'Chase Sapphire', 'Brad's Honda loan')."),
  balance: z.number().min(0).describe("Current outstanding balance in dollars."),
  apr: z
    .number()
    .min(0)
    .max(1)
    .describe("Annual interest rate as a decimal (0.18 = 18%, 0.0 for 0% promo)."),
  minPayment: z.number().min(0).describe("Minimum monthly payment in dollars."),
  debtType: z
    .string()
    .optional()
    .describe("Optional type: 'credit_card', 'auto_loan', 'student_loan', 'personal_loan', etc."),
  dueDay: z
    .number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe("Optional: day of month the payment is due."),
  notes: z.string().optional(),
});

registerTool({
  name: "add_debt",
  description:
    "Add a new debt (credit card, loan, etc.) to the household. Once added, it appears in the Debts page and in avalanche/snowball plans. Destructive — requires user confirmation. Undoable for 5 minutes.",
  riskTier: "destructive",
  inputSchema: addDebtInput,
  jsonSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      balance: { type: "number", minimum: 0 },
      apr: { type: "number", minimum: 0, maximum: 1 },
      minPayment: { type: "number", minimum: 0 },
      debtType: { type: "string" },
      dueDay: { type: "integer", minimum: 1, maximum: 31 },
      notes: { type: "string" },
    },
    required: ["name", "balance", "apr", "minPayment"],
    additionalProperties: false,
  },
  previewer: async (input) => {
    return `Add debt "${input.name}": $${input.balance.toFixed(2)} balance at ${(input.apr * 100).toFixed(2)}% APR, min payment $${input.minPayment.toFixed(2)}${input.dueDay ? `, due day ${input.dueDay}` : ""}${input.debtType ? `, type "${input.debtType}"` : ""}.`;
  },
  handler: async (input, ctx) => {
    const [inserted] = await db
      .insert(debtsTable)
      .values({
        userId: ctx.actorUserId,
        householdId: ctx.householdId,
        name: input.name,
        balance: input.balance.toFixed(2),
        originalBalance: input.balance.toFixed(2),
        apr: input.apr.toFixed(4),
        minPayment: input.minPayment.toFixed(2),
        payment: input.minPayment.toFixed(2),
        type: input.debtType ?? null,
        dueDay: input.dueDay ?? null,
        notes: input.notes ?? null,
        status: "active",
        balanceSource: "manual",
        aprSource: "manual",
        minPaymentSource: "manual",
      })
      .returning();
    const snap: AddDebtSnapshot = { kind: "add_debt", debtId: inserted.id };
    return {
      result: {
        ok: true,
        id: inserted.id,
        name: inserted.name,
        balance: Number(inserted.balance),
        apr: Number(inserted.apr),
        minPayment: Number(inserted.minPayment),
      },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as AddDebtSnapshot;
    if (snap?.kind !== "add_debt") throw new Error("Snapshot shape mismatch");
    // Refuse if any payment transactions already reference this debt.
    const dependentTxns = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, ctx.householdId),
          eq(transactionsTable.debtId, snap.debtId),
        ),
      )
      .limit(1);
    if (dependentTxns.length > 0) {
      throw new Error(
        "Cannot undo: payments have already been recorded against this debt. Use archive_debt instead.",
      );
    }
    await db
      .delete(debtsTable)
      .where(
        and(
          eq(debtsTable.id, snap.debtId),
          eq(debtsTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: update_debt_balance
// ---------------------------------------------------------------------------

const updateDebtBalanceInput = z.object({
  debtName: z.string().describe("Debt to update."),
  newBalance: z.number().min(0).describe("New outstanding balance in dollars."),
});

registerTool({
  name: "update_debt_balance",
  description:
    "Manually update a debt's current balance. Use when the user reports the actual balance from a statement that doesn't match what the app shows. Reversible for 5 minutes.",
  riskTier: "reversible",
  inputSchema: updateDebtBalanceInput,
  jsonSchema: {
    type: "object",
    properties: {
      debtName: { type: "string" },
      newBalance: { type: "number", minimum: 0 },
    },
    required: ["debtName", "newBalance"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const debt = await resolveDebt(ctx.householdId, input.debtName);
    const newBalanceStr = input.newBalance.toFixed(2);
    if (debt.balance === newBalanceStr) {
      return {
        result: { ok: true, changed: false, message: `${debt.name} was already $${newBalanceStr}.` },
      };
    }
    const snap: UpdateDebtBalanceSnapshot = {
      kind: "update_debt_balance",
      debtId: debt.id,
      previousBalance: debt.balance,
      previousLastUpdate: debt.lastBalanceUpdate?.toISOString() ?? null,
    };
    await db
      .update(debtsTable)
      .set({
        balance: newBalanceStr,
        lastBalanceUpdate: new Date(),
        balanceSource: "manual",
        updatedAt: new Date(),
      })
      .where(eq(debtsTable.id, debt.id));
    return {
      result: {
        ok: true,
        changed: true,
        name: debt.name,
        previousBalance: Number(debt.balance),
        newBalance: input.newBalance,
      },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as UpdateDebtBalanceSnapshot;
    if (snap?.kind !== "update_debt_balance") throw new Error("Snapshot shape mismatch");
    await db
      .update(debtsTable)
      .set({
        balance: snap.previousBalance,
        lastBalanceUpdate: snap.previousLastUpdate ? new Date(snap.previousLastUpdate) : null,
      })
      .where(
        and(
          eq(debtsTable.id, snap.debtId),
          eq(debtsTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: archive_debt
// ---------------------------------------------------------------------------

const archiveDebtInput = z.object({
  debtName: z.string().describe("Debt to archive (typically because it's paid off)."),
});

registerTool({
  name: "archive_debt",
  description:
    "Mark a debt as archived (paid off or no longer active). The debt stays in history but is excluded from active calculations and avalanche/snowball plans. Reversible for 5 minutes (restores to 'active').",
  riskTier: "reversible",
  inputSchema: archiveDebtInput,
  jsonSchema: {
    type: "object",
    properties: { debtName: { type: "string" } },
    required: ["debtName"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const debt = await resolveDebt(ctx.householdId, input.debtName);
    if (debt.status === "archived") {
      return {
        result: { ok: true, changed: false, message: `${debt.name} is already archived.` },
      };
    }
    const snap: ArchiveDebtSnapshot = {
      kind: "archive_debt",
      debtId: debt.id,
      previousStatus: debt.status,
    };
    await db
      .update(debtsTable)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(debtsTable.id, debt.id));
    return {
      result: {
        ok: true,
        changed: true,
        name: debt.name,
        balanceAtArchive: Number(debt.balance),
      },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as ArchiveDebtSnapshot;
    if (snap?.kind !== "archive_debt") throw new Error("Snapshot shape mismatch");
    await db
      .update(debtsTable)
      .set({ status: snap.previousStatus })
      .where(
        and(
          eq(debtsTable.id, snap.debtId),
          eq(debtsTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: record_debt_payment
// ---------------------------------------------------------------------------

const recordDebtPaymentInput = z.object({
  debtName: z.string().describe("Debt the payment was applied to."),
  amount: z.number().min(0.01).describe("Payment amount in dollars (positive number)."),
  occurredOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("ISO date the payment occurred."),
  description: z
    .string()
    .optional()
    .describe("Optional payment description. Defaults to 'Payment — <debt name>'."),
});

registerTool({
  name: "record_debt_payment",
  description:
    "Record a manual debt payment: creates a payment transaction linked to the debt AND decreases the debt's balance by the payment amount. Use when the user pays from cash or an account not linked via Plaid. Destructive — requires confirmation (touches two tables). Undoable for 5 minutes.",
  riskTier: "destructive",
  inputSchema: recordDebtPaymentInput,
  jsonSchema: {
    type: "object",
    properties: {
      debtName: { type: "string" },
      amount: { type: "number", minimum: 0.01 },
      occurredOn: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      description: { type: "string" },
    },
    required: ["debtName", "amount", "occurredOn"],
    additionalProperties: false,
  },
  previewer: async (input, ctx) => {
    try {
      const debt = await resolveDebt(ctx.householdId, input.debtName);
      const newBal = Math.max(0, Number(debt.balance) - input.amount).toFixed(2);
      return `Record $${input.amount.toFixed(2)} payment to "${debt.name}" on ${input.occurredOn}. Balance: $${Number(debt.balance).toFixed(2)} → $${newBal}.`;
    } catch {
      return `Record $${input.amount.toFixed(2)} payment to "${input.debtName}" on ${input.occurredOn} (debt will resolve at confirm)`;
    }
  },
  handler: async (input, ctx) => {
    const debt = await resolveDebt(ctx.householdId, input.debtName);
    const previousBalance = debt.balance;
    const newBalance = Math.max(0, Number(debt.balance) - input.amount).toFixed(2);
    // Create the transaction (positive amount on the liability side: payment
    // = inflow to the debt). For dashboard/forecast logic the convention is
    // negative on the funding side; but advisor's manual payment is recorded
    // as a debt_id-tagged positive row (matches /debts/:id/payments).
    const desc = input.description ?? `Payment — ${debt.name}`;
    const [inserted] = await db
      .insert(transactionsTable)
      .values({
        userId: ctx.actorUserId,
        householdId: ctx.householdId,
        occurredOn: input.occurredOn,
        description: desc,
        amount: input.amount.toFixed(2),
        source: "manual",
        debtId: debt.id,
      })
      .returning();
    await db
      .update(debtsTable)
      .set({
        balance: newBalance,
        lastBalanceUpdate: new Date(),
        balanceSource: "manual",
        updatedAt: new Date(),
      })
      .where(eq(debtsTable.id, debt.id));
    const snap: RecordDebtPaymentSnapshot = {
      kind: "record_debt_payment",
      transactionId: inserted.id,
      previousDebtBalance: previousBalance,
      debtId: debt.id,
    };
    return {
      result: {
        ok: true,
        transactionId: inserted.id,
        debtName: debt.name,
        amount: input.amount,
        previousBalance: Number(previousBalance),
        newBalance: Number(newBalance),
      },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, ctx) => {
    const snap = beforeSnapshot as RecordDebtPaymentSnapshot;
    if (snap?.kind !== "record_debt_payment") throw new Error("Snapshot shape mismatch");
    // Reverse both: delete the txn AND restore the prior balance.
    await db
      .delete(transactionsTable)
      .where(
        and(
          eq(transactionsTable.id, snap.transactionId),
          eq(transactionsTable.householdId, ctx.householdId),
        ),
      );
    await db
      .update(debtsTable)
      .set({ balance: snap.previousDebtBalance })
      .where(
        and(
          eq(debtsTable.id, snap.debtId),
          eq(debtsTable.householdId, ctx.householdId),
        ),
      );
  },
});

// ---------------------------------------------------------------------------
// Tool: update_bank_snapshot
// ---------------------------------------------------------------------------

const updateBankSnapshotInput = z.object({
  balance: z.number().describe("Current bank checking balance in dollars."),
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Optional ISO date the snapshot reflects. Defaults to today."),
});

registerTool({
  name: "update_bank_snapshot",
  description:
    "Set the household's current bank snapshot balance — the anchor the 90-day cash forecast projects forward from. Use when the user reports a true balance ('my checking is at $4,200 right now') or when stale projections imply the snapshot has drifted. Reversible for 5 minutes.",
  riskTier: "reversible",
  inputSchema: updateBankSnapshotInput,
  jsonSchema: {
    type: "object",
    properties: {
      balance: { type: "number" },
      asOf: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
    required: ["balance"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const ownerUserId = ctx.householdOwnerId;
    const [existing] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId));
    const asOfDate = input.asOf ? new Date(input.asOf + "T12:00:00Z") : new Date();
    const newBalanceStr = input.balance.toFixed(2);
    const snap: UpdateBankSnapshotSnapshot = {
      kind: "update_bank_snapshot",
      userId: ownerUserId,
      previous: {
        bankSnapshotBalance: existing?.bankSnapshotBalance ?? null,
        bankSnapshotAt: existing?.bankSnapshotAt?.toISOString() ?? null,
        bankSnapshotSource: existing?.bankSnapshotSource ?? null,
      },
    };
    if (existing) {
      await db
        .update(forecastSettingsTable)
        .set({
          bankSnapshotBalance: newBalanceStr,
          bankSnapshotAt: asOfDate,
          bankSnapshotSource: "advisor",
        })
        .where(eq(forecastSettingsTable.userId, ownerUserId));
    } else {
      await db
        .insert(forecastSettingsTable)
        .values({
          userId: ownerUserId,
          householdId: ctx.householdId,
          bankSnapshotBalance: newBalanceStr,
          bankSnapshotAt: asOfDate,
          bankSnapshotSource: "advisor",
        });
    }
    return {
      result: {
        ok: true,
        balance: input.balance,
        asOf: asOfDate.toISOString(),
        previousBalance: existing?.bankSnapshotBalance ? Number(existing.bankSnapshotBalance) : null,
      },
      beforeSnapshot: snap,
    };
  },
  undoHandler: async (beforeSnapshot, _ctx) => {
    const snap = beforeSnapshot as UpdateBankSnapshotSnapshot;
    if (snap?.kind !== "update_bank_snapshot") throw new Error("Snapshot shape mismatch");
    await db
      .update(forecastSettingsTable)
      .set({
        bankSnapshotBalance: snap.previous.bankSnapshotBalance,
        bankSnapshotAt: snap.previous.bankSnapshotAt ? new Date(snap.previous.bankSnapshotAt) : null,
        bankSnapshotSource: snap.previous.bankSnapshotSource,
      })
      .where(eq(forecastSettingsTable.userId, snap.userId));
  },
});
