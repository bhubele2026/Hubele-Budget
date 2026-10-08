// (PR-D) Genuine progress on a debt: what moved its balance, and how much of
// the paying-down was real. Pure: no I/O.
//
// A balance change is the sum of five kinds of event — confirmed payments,
// interest, fees, new charges, credits (refunds) — plus whatever none of them
// explains. `decomposeDelta` returns exactly that split, to the cent, so a
// screen can say "you paid $X; interest took $Y back" without guessing.
//
// A payment to one debt made with money drawn from another (a balance
// transfer, a cash advance, a HELOC draw paying a card) moves the debt around
// without paying it down. `isTransferPair` recognises the pair; such a payment
// is never counted as genuine progress.

import { matchesCardPaymentPattern, PFC_CARD_PAYMENT } from "./spendingRule";

export type DebtEventKind = "interest" | "fee" | "payment" | "charge" | "credit";

/** One event on a debt. `amount` is a magnitude (≥ 0); `kind` carries the direction. */
export type DebtEvent = {
  kind: DebtEventKind;
  amount: number;
  /** A payment or charge that is one half of a transfer pair (`isTransferPair`). */
  transferPair?: boolean;
};

/**
 * The balance change split by cause. Every field is the event's SIGNED
 * contribution to the balance (owed going up is positive):
 *   delta = paymentsConfirmed + interest + fees + newCharges + credits + unexplained
 * exactly, in cents. `paymentsConfirmed` and `credits` are ≤ 0.
 */
export type DebtDeltaDecomposition = {
  delta: number;
  paymentsConfirmed: number;
  interest: number;
  fees: number;
  newCharges: number;
  credits: number;
  unexplained: number;
  /**
   * The part of `paymentsConfirmed` (≤ 0) and of `newCharges` (≥ 0) that were
   * transfer-pair halves. Included above so the identity holds per debt;
   * excluded from genuine progress.
   */
  transferPayments: number;
  transferCharges: number;
  /** Confirmed payments that were not transfer halves, as a paid amount (≥ 0). */
  genuinePayments: number;
};

const toCents = (n: number): number => Math.round((Number(n) || 0) * 100);
// `+ 0` turns -0 into 0: a figure is never "negative zero".
const fromCents = (c: number): number => c / 100 + 0;

/**
 * ⭐ THE ONE CARD-SIGN RULE. Returns the amount in CHARGE semantics: positive
 * means the row raised what is owed (a purchase, interest, a fee), negative
 * means it lowered it (a payment, a refund).
 *
 *   - `amex` — the legacy workbook importer stores card charges POSITIVE
 *     (`amexSignedAmount`: Expense +, Income/Credit −);
 *   - everything else, `plaid:*` included — the app's ledger convention,
 *     negative is money out, so a card charge is NEGATIVE and is flipped here.
 *
 * Summing raw `amount` across both conventions (what `refreshAmexAnchor` did)
 * nets a charge in one against a charge in the other.
 */
export function normalizeCardAmount(source: string | null | undefined, amount: number | string): number {
  const n = Number(amount) || 0;
  return (source ?? "").toLowerCase() === "amex" ? n : -n;
}

export type TransferCandidate = {
  id: string;
  debtId: string;
  /** Magnitude (≥ 0). */
  amount: number;
  /** `YYYY-MM-DD`. */
  occurredOn: string;
};

const TRANSFER_MAX_DAYS = 5;
const TRANSFER_SHARE = 0.01;

const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
};

/**
 * A payment to debt A within 5 days of a charge or draw on a DIFFERENT debt B
 * of the same amount (±1% of the larger) is a transfer: the money that paid A
 * came from B, so the household owes the same. It is not genuine reduction.
 */
export function isTransferPair(
  payment: Omit<TransferCandidate, "id"> & { id?: string },
  charge: Omit<TransferCandidate, "id"> & { id?: string },
): boolean {
  if (!payment.debtId || !charge.debtId || payment.debtId === charge.debtId) return false;
  const p = Math.abs(toCents(payment.amount));
  const c = Math.abs(toCents(charge.amount));
  if (p === 0 || c === 0) return false;
  if (Math.abs(dayNumber(payment.occurredOn) - dayNumber(charge.occurredOn)) > TRANSFER_MAX_DAYS) return false;
  return Math.abs(p - c) <= Math.max(p, c) * TRANSFER_SHARE;
}

/**
 * Pair payments with charges on other debts, one to one: each payment takes
 * the closest qualifying charge (fewest days apart, then smallest gap, then
 * id), payments taken in date-then-id order. Returns the paired ids, both
 * halves, keyed payment id → charge id.
 */
export function pairTransfers(
  payments: readonly TransferCandidate[],
  charges: readonly TransferCandidate[],
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const ordered = [...payments].sort(
    (a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.id.localeCompare(b.id),
  );
  for (const p of ordered) {
    let best: { c: TransferCandidate; days: number; gap: number } | null = null;
    for (const c of charges) {
      if (used.has(c.id) || !isTransferPair(p, c)) continue;
      const days = Math.abs(dayNumber(p.occurredOn) - dayNumber(c.occurredOn));
      const gap = Math.abs(Math.abs(toCents(p.amount)) - Math.abs(toCents(c.amount)));
      if (
        !best ||
        days < best.days ||
        (days === best.days && (gap < best.gap || (gap === best.gap && c.id < best.c.id)))
      ) {
        best = { c, days, gap };
      }
    }
    if (best) {
      used.add(best.c.id);
      out.set(p.id, best.c.id);
    }
  }
  return out;
}

/**
 * Split `balanceAfter − balanceBefore` into its causes. Sums in integer cents
 * so the identity holds exactly; `unexplained` is the remainder (a balance the
 * creditor reported before its rows arrived, a claim not yet confirmed, a
 * manual edit).
 */
export function decomposeDelta(input: {
  balanceBefore: number;
  balanceAfter: number;
  events: readonly DebtEvent[];
}): DebtDeltaDecomposition {
  const delta = toCents(input.balanceAfter) - toCents(input.balanceBefore);
  let payments = 0;
  let interest = 0;
  let fees = 0;
  let charges = 0;
  let credits = 0;
  let transferPayments = 0;
  let transferCharges = 0;
  for (const e of input.events) {
    const c = Math.abs(toCents(e.amount));
    switch (e.kind) {
      case "payment":
        payments -= c;
        if (e.transferPair) transferPayments -= c;
        break;
      case "interest":
        interest += c;
        break;
      case "fee":
        fees += c;
        break;
      case "charge":
        charges += c;
        if (e.transferPair) transferCharges += c;
        break;
      case "credit":
        credits -= c;
        break;
    }
  }
  const unexplained = delta - (payments + interest + fees + charges + credits);
  return {
    delta: fromCents(delta),
    paymentsConfirmed: fromCents(payments),
    interest: fromCents(interest),
    fees: fromCents(fees),
    newCharges: fromCents(charges),
    credits: fromCents(credits),
    unexplained: fromCents(unexplained),
    transferPayments: fromCents(transferPayments),
    transferCharges: fromCents(transferCharges),
    genuinePayments: fromCents(-(payments - transferPayments)),
  };
}

/** A row on a liability account, as `classifyLiabilityRow` reads it. */
export type LiabilityRowInput = {
  source: string | null;
  amount: number | string;
  description: string | null;
  pfcPrimary?: string | null;
  pfcDetailed?: string | null;
  isExternalCardPayment?: boolean | null;
};

const INTEREST_WORDS = /interest|finance charge/i;
const PAYMENT_WORDS = /\bpayment\b|thank you|autopay/i;
const PAYMENT_PFC_PRIMARY = new Set(["LOAN_PAYMENTS", "TRANSFER_IN"]);

/**
 * What a row on a credit card or loan account did to the debt:
 *   - raising it (charge semantics > 0, `normalizeCardAmount`): `interest` when
 *     Plaid says `…INTEREST_CHARGE` or the description says interest / finance
 *     charge; `fee` for any other `BANK_FEES_*`; otherwise a `charge`;
 *   - lowering it: a `payment` when it is marked or named as one (the user's
 *     card-payment flag, Plaid's LOAN_PAYMENTS / TRANSFER_IN, the card-payment
 *     patterns, "payment" / "thank you" / "autopay"); otherwise a `credit`
 *     (a refund, a statement credit, an interest reversal).
 * A zero row is nothing (null). The amount returned is a magnitude.
 */
export function classifyLiabilityRow(
  row: LiabilityRowInput,
): { kind: DebtEventKind; amount: number } | null {
  const signed = normalizeCardAmount(row.source, row.amount);
  const cents = toCents(signed);
  if (cents === 0) return null;
  const amount = Math.abs(cents) / 100;
  const detailed = (row.pfcDetailed ?? "").toUpperCase();
  const primary = (row.pfcPrimary ?? "").toUpperCase();
  const desc = row.description ?? "";
  if (cents > 0) {
    if (detailed.includes("INTEREST_CHARGE")) return { kind: "interest", amount };
    if (detailed.startsWith("BANK_FEES_")) return { kind: "fee", amount };
    if (INTEREST_WORDS.test(desc)) return { kind: "interest", amount };
    return { kind: "charge", amount };
  }
  const isPayment =
    row.isExternalCardPayment === true ||
    PAYMENT_PFC_PRIMARY.has(primary) ||
    detailed === PFC_CARD_PAYMENT ||
    matchesCardPaymentPattern(desc) ||
    PAYMENT_WORDS.test(desc);
  return { kind: isPayment ? "payment" : "credit", amount };
}
