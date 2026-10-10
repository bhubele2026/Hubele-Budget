import { and, eq, inArray } from "drizzle-orm";
import { db, debtBalanceHistoryTable, debtsTable, plaidAccountsTable } from "@workspace/db";
import { householdTodayISO } from "./householdClock";

/**
 * (WP2) Writing a Plaid liability balance onto a linked debt — moved verbatim
 * from `routes/debts.ts` so the post-Sync liabilities fetch (`routes/plaid.ts`)
 * applies what it cached with the same function `GET /debts` uses. Before, a
 * Sync fetched liabilities and stamped the fetch time without touching the
 * debts, so the pending rule's as-of could move past a balance that was not
 * yet on the debt row.
 */

type DebtRow = typeof debtsTable.$inferSelect;

/** The household's today (America/Chicago) — the day a balance change is recorded on. */
function todayISO(): string {
  return householdTodayISO();
}

export async function recordBalanceSnapshot(
  userId: string,
  householdId: string,
  debtId: string,
  balance: string | number,
): Promise<void> {
  const balStr =
    typeof balance === "number" ? balance.toFixed(2) : String(balance);
  // Upsert the day's row so a later same-day balance update wins (including
  // a correction down to $0). Previously this used onConflictDoNothing,
  // which silently dropped same-day drops to zero and left paid-off debts
  // frozen at their last non-zero balance in the history curve.
  await db
    .insert(debtBalanceHistoryTable)
    .values({
      userId,
      householdId,
      debtId,
      recordedOn: todayISO(),
      balance: balStr,
    })
    .onConflictDoUpdate({
      target: [
        debtBalanceHistoryTable.householdId,
        debtBalanceHistoryTable.debtId,
        debtBalanceHistoryTable.recordedOn,
      ],
      set: { balance: balStr },
    });
}

export class AprValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AprValidationError";
  }
}

// APR is stored and consumed as a *decimal* (e.g. 0.2499 for 24.99%). A user
// sending the percentage form (e.g. 24.99) would be interpreted as 2,499%
// APR by the simulator, breaking the whole avalanche page. Reject anything
// outside [0, 1) with a clear message so the bad value never reaches the DB.
export function validateAprDecimal(apr: unknown): void {
  if (apr === undefined || apr === null) return;
  const n = typeof apr === "number" ? apr : Number(apr);
  if (!Number.isFinite(n)) {
    throw new AprValidationError("APR must be a number");
  }
  if (n < 0) {
    throw new AprValidationError("APR must be ≥ 0");
  }
  if (n >= 1) {
    throw new AprValidationError(
      `APR must be a decimal — e.g. 0.2499 for 24.99% (got ${n})`,
    );
  }
}

/**
 * Apply cached Plaid liability values to a debt.
 * - On `mode='adopt'` (initial link): claim every field Plaid actually
 *   returned, marking that field's source as 'plaid'. Fields Plaid did not
 *   return stay manual.
 * - On `mode='refresh'` (subsequent syncs): only overwrite fields whose
 *   current source is already 'plaid'. Manual overrides are preserved.
 */
export async function applyLiabilityToDebt(
  userId: string,
  householdId: string,
  debt: DebtRow,
  mode: "adopt" | "refresh" = "refresh",
  stampSync: boolean = true,
): Promise<DebtRow> {
  if (!debt.plaidAccountId) return debt;
  const [acct] = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.id, debt.plaidAccountId),
        eq(plaidAccountsTable.householdId, householdId),
      ),
    );
  if (!acct) return debt;
  const patch: Partial<typeof debtsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (stampSync) patch.plaidLastSyncedAt = new Date();
  const allowBalance = mode === "adopt" || debt.balanceSource === "plaid";
  const allowApr = mode === "adopt" || debt.aprSource === "plaid";
  const allowMin = mode === "adopt" || debt.minPaymentSource === "plaid";
  if (allowBalance && acct.liabilityBalance != null) {
    patch.balance = acct.liabilityBalance;
    patch.balanceSource = "plaid";
    patch.lastBalanceUpdate = new Date();
    // Anchor the original balance the first time we ever see one for this
    // debt so the avalanche progress bar has a stable denominator. We never
    // overwrite an existing anchor — the original is by definition the
    // highest known balance at adoption time.
    if (debt.originalBalance == null) {
      patch.originalBalance = acct.liabilityBalance;
    }
    // (#292) Auto-archive when Plaid reports the balance hit zero so the
    // Bills "Stops at payoff" celebratory row fires automatically. Without
    // this the user has to manually flip status='archived' for the row to
    // appear, and most paid-off debts would silently slip past it.
    if (
      debt.status === "active" &&
      Number(acct.liabilityBalance) <= 0.005
    ) {
      patch.status = "archived";
    }
  }
  if (allowApr && acct.liabilityApr != null) {
    validateAprDecimal(acct.liabilityApr);
    patch.apr = acct.liabilityApr;
    patch.aprSource = "plaid";
  }
  if (allowMin && acct.liabilityMinPayment != null) {
    patch.minPayment = acct.liabilityMinPayment;
    patch.minPaymentSource = "plaid";
  }
  const [updated] = await db
    .update(debtsTable)
    .set(patch)
    .where(and(eq(debtsTable.id, debt.id), eq(debtsTable.householdId, householdId)))
    .returning();
  if (updated && patch.balance != null) {
    await recordBalanceSnapshot(userId, householdId, updated.id, updated.balance);
  }
  return updated ?? debt;
}

/**
 * (WP2) After a liabilities fetch for one Plaid item: apply each linked debt's
 * cached balance — only debts whose balance Plaid owns (`balanceSource =
 * 'plaid'`), in `refresh` mode, stamping the sync time (the fetch succeeded).
 * A debt whose cached APR is malformed is skipped, as `GET /debts` skips it.
 * Returns how many debts were applied.
 */
export async function applyCachedLiabilitiesToPlaidDebts(
  userId: string,
  householdId: string,
  itemRowId: string,
): Promise<number> {
  const accts = await db
    .select({ id: plaidAccountsTable.id })
    .from(plaidAccountsTable)
    .where(and(eq(plaidAccountsTable.householdId, householdId), eq(plaidAccountsTable.itemId, itemRowId)));
  if (accts.length === 0) return 0;
  const debts = await db
    .select()
    .from(debtsTable)
    .where(
      and(
        eq(debtsTable.householdId, householdId),
        eq(debtsTable.balanceSource, "plaid"),
        inArray(debtsTable.plaidAccountId, accts.map((a) => a.id)),
      ),
    );
  let applied = 0;
  for (const d of debts) {
    try {
      await applyLiabilityToDebt(userId, householdId, d, "refresh", true);
      applied += 1;
    } catch (e) {
      if (!(e instanceof AprValidationError)) throw e;
    }
  }
  return applied;
}
