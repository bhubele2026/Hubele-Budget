import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray } from "drizzle-orm";
import { db, debtsTable, plaidAccountsTable, transactionsTable } from "@workspace/db";
import { addDaysISO, plansPaidInFullByName, type MatchPlan, type MatchRow } from "@workspace/avalanche-core";
import { syncDebtLedgerEvents } from "./debtLedger";
import { householdTodayISO } from "./householdClock";
import { logger } from "./logger";

/**
 * (PR-D) ⭐ PLANNED ≠ CONFIRMED. A payment logged in the app
 * (`POST /debts/:id/payments`) is a CLAIM — "I paid this" — written with
 * `payment_state = 'claimed'`. It becomes `confirmed` only when a BANK row
 * (a Plaid row on a depository account) pairs with it:
 *
 *   - within CONFIRM_MAX_DAYS of the claim's date, either side;
 *   - the same amount within max($1, 1%);
 *   - and evidence it is THIS debt's payment: the bank row is tagged to the
 *     same debt (`debt_tag`), or it is a card payment naming the debt
 *     (`plansPaidInFullByName`'s `card_payment` rule — the same evidence the
 *     forecast uses for a debt minimum). A row tagged to ANOTHER debt is never
 *     evidence.
 *
 * Several candidates → the closest: debt tag before name, then fewest days,
 * then smallest amount gap, then a posted row before a pending one, then id.
 * One to one: a bank row confirms at most one claim (also a unique index).
 *
 * Why it matters for cash: before PR-D the claim AND the bank row both left
 * checking on the ledger — the same payment counted twice. A confirmed claim
 * now adds 0 (`classifyCashRows` reason `claim_confirmed`); the bank row is the
 * payment. A claim whose bank row disappears (deleted by Plaid, FK SET NULL)
 * goes back to `claimed` on the next pass and counts again.
 */
export const CONFIRM_MAX_DAYS = 10;
/** Claims older than this stay claims: no bank row is looked for any more. */
export const CLAIM_LOOKBACK_DAYS = 90;
const CONFIRM_MIN_TOLERANCE_CENTS = 100;
const CONFIRM_SHARE = 0.01;

const cents = (n: number | string): number => Math.round(Math.abs(Number(n) || 0) * 100);
const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
};

export type ClaimConfirmation = {
  claimId: string;
  bankTxnId: string;
  evidence: "debt_tag" | "card_payment";
};

type Claim = { id: string; debtId: string; occurredOn: string; amount: number };
type BankRow = {
  id: string;
  occurredOn: string;
  amount: number;
  description: string | null;
  debtId: string | null;
  pending: boolean;
  isExternalCardPayment: boolean;
  pfcDetailed: string | null;
};

/**
 * The pure pairing step: which claim each bank row confirms. Exported for the
 * unit-level tests; `confirmDebtPaymentClaims` is the only writer.
 */
export function pairClaimsWithBankRows(
  claims: readonly Claim[],
  rows: readonly BankRow[],
  debtNameById: ReadonlyMap<string, string>,
): ClaimConfirmation[] {
  type Cand = { claim: Claim; row: BankRow; evidence: ClaimConfirmation["evidence"]; days: number; gap: number };
  const cands: Cand[] = [];
  for (const claim of claims) {
    const claimCents = cents(claim.amount);
    const tolerance = Math.max(CONFIRM_MIN_TOLERANCE_CENTS, Math.round(claimCents * CONFIRM_SHARE));
    for (const row of rows) {
      if (row.amount >= 0) continue;
      const days = Math.abs(dayNumber(row.occurredOn) - dayNumber(claim.occurredOn));
      if (days > CONFIRM_MAX_DAYS) continue;
      const gap = Math.abs(cents(row.amount) - claimCents);
      if (gap > tolerance) continue;
      let evidence: ClaimConfirmation["evidence"] | null = null;
      if (row.debtId) {
        if (row.debtId === claim.debtId) evidence = "debt_tag";
      } else {
        // The forecast's own card-payment evidence, asked about this one pair:
        // the plan is dated on the row and sized at the smaller of the two, so
        // the window and the amount above are this module's, and only the
        // "is this a payment naming the debt" judgement is planMatch's.
        const plan: MatchPlan = {
          key: claim.id,
          itemId: `debt:${claim.debtId}`,
          occurrenceDate: row.occurredOn,
          date: row.occurredOn,
          amount: -Math.min(claimCents, cents(row.amount)) / 100,
          label: debtNameById.get(claim.debtId) ?? "",
          debtId: claim.debtId,
        };
        const matchRow: MatchRow = {
          txnId: row.id,
          occurredOn: row.occurredOn,
          amount: row.amount,
          description: row.description,
          isExternalCardPayment: row.isExternalCardPayment,
          pfcDetailed: row.pfcDetailed,
          debtId: null,
          onChecking: true,
          plaidChecking: true,
        };
        if (plansPaidInFullByName([plan], [matchRow]).length > 0) evidence = "card_payment";
      }
      if (evidence) cands.push({ claim, row, evidence, days, gap });
    }
  }
  const rank = (e: ClaimConfirmation["evidence"]) => (e === "debt_tag" ? 0 : 1);
  cands.sort(
    (a, b) =>
      rank(a.evidence) - rank(b.evidence) ||
      a.days - b.days ||
      a.gap - b.gap ||
      Number(a.row.pending) - Number(b.row.pending) ||
      a.claim.id.localeCompare(b.claim.id) ||
      a.row.id.localeCompare(b.row.id),
  );
  const usedClaims = new Set<string>();
  const usedRows = new Set<string>();
  const out: ClaimConfirmation[] = [];
  for (const c of cands) {
    if (usedClaims.has(c.claim.id) || usedRows.has(c.row.id)) continue;
    usedClaims.add(c.claim.id);
    usedRows.add(c.row.id);
    out.push({ claimId: c.claim.id, bankTxnId: c.row.id, evidence: c.evidence });
  }
  return out;
}

/**
 * The household's bank rows: Plaid rows on a depository account. Shared with
 * the debt plan's "confirmed" read model so both mean the same thing.
 */
export async function depositoryAccountIds(householdId: string): Promise<string[]> {
  const rows = await db
    .select({ accountId: plaidAccountsTable.accountId })
    .from(plaidAccountsTable)
    .where(and(eq(plaidAccountsTable.householdId, householdId), eq(plaidAccountsTable.type, "depository")));
  return rows.map((r) => r.accountId);
}

export async function confirmDebtPaymentClaims(
  householdId: string,
): Promise<{ confirmed: ClaimConfirmation[]; reverted: number }> {
  const t = transactionsTable;
  // A confirmation whose bank row is gone (FK SET NULL) is a claim again.
  const reverted = await db
    .update(t)
    .set({ paymentState: "claimed" })
    .where(and(eq(t.householdId, householdId), eq(t.paymentState, "confirmed"), isNull(t.confirmedByTxnId)))
    .returning({ id: t.id });

  const open = await db
    .select({ id: t.id, debtId: t.debtId, occurredOn: t.occurredOn, amount: t.amount })
    .from(t)
    .where(
      and(
        eq(t.householdId, householdId),
        eq(t.paymentState, "claimed"),
        isNotNull(t.debtId),
        gte(t.occurredOn, addDaysISO(householdTodayISO(), -CLAIM_LOOKBACK_DAYS)),
      ),
    );
  if (open.length === 0) return { confirmed: [], reverted: reverted.length };
  const claims: Claim[] = open.map((c) => ({
    id: c.id,
    debtId: c.debtId!,
    occurredOn: c.occurredOn,
    amount: Number(c.amount) || 0,
  }));

  const accounts = await depositoryAccountIds(householdId);
  if (accounts.length === 0) return { confirmed: [], reverted: reverted.length };
  const dates = claims.map((c) => c.occurredOn).sort();
  const lo = addDaysISO(dates[0]!, -CONFIRM_MAX_DAYS);
  const hi = addDaysISO(dates[dates.length - 1]!, CONFIRM_MAX_DAYS);
  const taken = db
    .select({ id: t.confirmedByTxnId })
    .from(t)
    .where(and(eq(t.householdId, householdId), isNotNull(t.confirmedByTxnId)));
  const rows = await db
    .select({
      id: t.id,
      occurredOn: t.occurredOn,
      amount: t.amount,
      description: t.description,
      debtId: t.debtId,
      pending: t.pending,
      isExternalCardPayment: t.isExternalCardPayment,
      pfcDetailed: t.pfcDetailed,
    })
    .from(t)
    .where(
      and(
        eq(t.householdId, householdId),
        inArray(t.plaidAccountId, accounts),
        lt(t.amount, "0"),
        gte(t.occurredOn, lo),
        lte(t.occurredOn, hi),
        notInArray(t.id, taken),
      ),
    );
  const debts = await db
    .select({ id: debtsTable.id, name: debtsTable.name })
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));
  const pairs = pairClaimsWithBankRows(
    claims,
    rows.map((r) => ({
      id: r.id,
      occurredOn: r.occurredOn,
      amount: Number(r.amount) || 0,
      description: r.description,
      debtId: r.debtId,
      pending: r.pending,
      isExternalCardPayment: r.isExternalCardPayment,
      pfcDetailed: r.pfcDetailed,
    })),
    new Map(debts.map((d) => [d.id, d.name] as const)),
  );
  const confirmed: ClaimConfirmation[] = [];
  for (const p of pairs) {
    try {
      const done = await db
        .update(t)
        .set({ paymentState: "confirmed", confirmedByTxnId: p.bankTxnId })
        .where(and(eq(t.id, p.claimId), eq(t.householdId, householdId), eq(t.paymentState, "claimed")))
        .returning({ id: t.id });
      if (done.length > 0) confirmed.push(p);
    } catch (err) {
      // A concurrent pass took the bank row first (unique index): skip it.
      logger.warn({ err, claimId: p.claimId }, "[debt-plan] claim confirmation skipped");
    }
  }
  return { confirmed, reverted: reverted.length };
}

/**
 * (PR-D) The one-line hook at the end of `syncPlaidItem`: classify the synced
 * rows onto the liability ledger, then pair open claims with bank rows.
 * Best-effort — a failure is logged and never fails the sync.
 */
export async function afterPlaidSyncDebtPass(
  householdId: string,
  plaidTransactionIds: readonly string[],
): Promise<void> {
  try {
    await syncDebtLedgerEvents(householdId, { plaidTransactionIds });
    await confirmDebtPaymentClaims(householdId);
  } catch (err) {
    logger.error({ err, householdId }, "[debt-plan] post-sync debt pass failed");
  }
}
