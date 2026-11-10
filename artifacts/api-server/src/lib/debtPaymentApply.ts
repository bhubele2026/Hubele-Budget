// ⭐ LOGGING A DEBT PAYMENT — the write `POST /debts/:id/payments` has always
// made, moved verbatim out of the route (`routes/debts.ts`) so the weekly
// avalanche's "We paid it" (`lib/avalancheWeekPay.ts`) lowers a balance through
// the SAME statements inside its own transaction:
//
//   - one CLAIM transaction — "Payment — <debt>", the amount negative, tagged to
//     the debt, `payment_state = 'claimed'` until a bank row confirms it
//     (`lib/debtPaymentConfirm.ts`);
//   - the debt's balance lowered by the amount, floored at $0, its as-of
//     (`last_balance_update`) stamped now;
//   - a debt that reaches $0 from active is archived ("killed"), and the claim
//     says so ("(PAID OFF)", "Final payment — debt paid in full 🎉").
//
// The balance-history snapshot, the claim pairing and the budget sync stay with
// each caller, as the route always ran them after its transaction.
//
// ⚠️ No validation here: the caller checks the amount (> 0) and the household.

import { and, eq } from "drizzle-orm";
import { debtsTable, transactionsTable } from "@workspace/db";
import type { Exec } from "./categorizer/db";

type DebtRow = typeof debtsTable.$inferSelect;
type TransactionRow = typeof transactionsTable.$inferSelect;

export interface DebtPaymentInput {
  /** The person logging it (the claim's actor). */
  userId: string;
  householdId: string;
  debtId: string;
  /** > 0. */
  amount: number;
  occurredOn: string;
  account?: string | null;
  notes?: string | null;
}

export interface DebtPaymentWrite {
  /** The debt as read before the payment. */
  before: DebtRow;
  /** The debt after it. */
  debt: DebtRow;
  /** The claim transaction. */
  transaction: TransactionRow;
  /** The payment took an active debt to $0: it is archived. */
  killed: boolean;
}

/** Null when the debt is not in the household. Pass a transaction: the claim and the balance are one unit. */
export async function applyDebtPayment(tx: Exec, input: DebtPaymentInput): Promise<DebtPaymentWrite | null> {
  const { userId, householdId, debtId, amount } = input;
  const [debt] = await tx
    .select()
    .from(debtsTable)
    .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)));
  if (!debt) return null;
  const oldBal = Number(debt.balance);
  const newBal = Math.max(0, oldBal - amount);
  const killed = oldBal > 0 && newBal === 0 && debt.status === "active";
  const occurredOn = input.occurredOn;
  const userNotes = input.notes ?? null;
  const finalNote = killed ? "Final payment — debt paid in full 🎉" : null;
  const mergedNotes = killed
    ? userNotes
      ? `${userNotes}\n${finalNote}`
      : finalNote
    : userNotes;
  const [txn] = await tx
    .insert(transactionsTable)
    .values({
      userId,
      householdId,
      occurredOn,
      description: killed
        ? `Payment — ${debt.name} (PAID OFF)`
        : `Payment — ${debt.name}`,
      amount: (-Math.abs(amount)).toFixed(2),
      account: input.account ?? null,
      notes: mergedNotes,
      source: "manual",
      member: null,
      debtId,
      // (PR-D) A payment logged here is a CLAIM until a bank row confirms
      // it (`lib/debtPaymentConfirm.ts`). The balance still drops now, as
      // it always has.
      paymentState: "claimed",
    })
    .returning();
  const [updated] = await tx
    .update(debtsTable)
    .set({
      balance: newBal.toFixed(2),
      lastBalanceUpdate: new Date(),
      updatedAt: new Date(),
      ...(killed ? { status: "archived" } : {}),
    })
    .where(and(eq(debtsTable.id, debtId), eq(debtsTable.householdId, householdId)))
    .returning();
  return { before: debt, debt: updated!, transaction: txn!, killed };
}
