// ⭐ (F5) THE CARD'S OWN LEDGER — which card a payment reached, and which of
// that card's debt minimums it paid. Pure, dependency-free (see the package
// header).
//
// A payment to a card shows twice: a checking outflow ("AMERICAN EXPRESS ACH
// PMT −300.00") and a payment credit on the card that received it ("ONLINE
// PAYMENT - THANK YOU +300.00"). The checking row alone does not say WHICH card
// of the issuer it paid; the credit does. F1 paired the two inside the hooks'
// loader only, so the debt-minimum rules (which run before it) read every
// issuer payment as "names the card": a household with two Amex cards had the
// weekly (in_full) card's payment paying the debt-plan card's minimum, and the
// debt-plan card's own payment paying nothing (live, 2026-10-14). F5 pairs them
// ONCE, before the matcher, and every rule reads that one answer.

/** A payment credit on a card's own ledger. */
export interface CardLedgerCredit {
  txnId: string;
  /** External account id of the card. */
  accountId: string;
  occurredOn: string;
  /** What reached the card, cents (> 0). */
  cents: number;
  /**
   * (F5 round 2) The debts linked to the card. A checking row the household
   * tagged to a debt pairs first with a credit on that debt's card; (round 3)
   * only a row no such credit claimed may pair with another card's. Absent: none.
   */
  debtIds?: readonly string[];
}

/** A counted checking outflow (any: a plan may have used it). */
export interface CardLedgerOutflow {
  txnId: string;
  occurredOn: string;
  /** cents (> 0). */
  cents: number;
  /**
   * ⭐ (F5 round 2) The ISSUER-NAME GUARD: does the row name the card's issuer
   * ("AMERICAN EXPRESS ACH PMT"; round 5: abbreviations too, "AMERICAN EXP CO" —
   * `paymentNamesCardIssuer`)? A row that neither names it nor carries a tag
   * to the card's debt never pairs: a same-amount transfer to someone else is
   * not that card's payment. Absent (an older caller): read as naming it.
   */
  namesIssuer?: boolean;
  /** (F5 round 2) The debt the household tagged the row to, or null. */
  debtId?: string | null;
  /** (F5 round 2) Still pending on checking: the money cannot have reached the card's balance yet. */
  pending?: boolean;
}

/**
 * Days the checking row may sit before (−) or after (+) the card's credit and
 * still be the same payment. (F5 round 2) After: 2 → 5. The card credits the
 * payment the day it is made; the bank debit lands one to three business days
 * later, so a payment made on a Friday reached checking on the Tuesday and did
 * not pair — its checking row then paid a second obligation.
 */
export const CARD_CREDIT_PAIR_BEFORE = 5;
export const CARD_CREDIT_PAIR_AFTER = 5;

/**
 * ⭐ (F5 round 5) THE PAIRING'S ISSUER NAME, abbreviations included: the bank
 * writes an Amex payment as "AMERICAN EXPRESS ACH PMT", "AMEX EPAYMENT",
 * "AMEXEPAYMENT", "AMERICAN EXP CO", "AMER EXP". Looser than `namesCardIssuer`
 * (the hooks' evidence rule, which pays a week on the name alone): here a
 * card credit of the same cents within days must corroborate it. Never
 * "CAMEXICO", "AMERICAN EXPEDITIONS", "AMERICAN EXPORT".
 */
const ISSUER_PAYMENT_NAME = /\bamex(?:\b|e?pay)|\bamer(?:ican)?[\s.\-]*exp(?:ress)?\b/i;

/** (F5 round 5) Does a checking row's text name the card issuer, abbreviations too? The pairing's guard. */
export function paymentNamesCardIssuer(description: string | null | undefined): boolean {
  return ISSUER_PAYMENT_NAME.test(description ?? "");
}

const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const dayGap = (a: string, b: string): number => Math.round(dayNumber(a) - dayNumber(b));
const shiftDaysISO = (iso: string, days: number): string => new Date((dayNumber(iso) + days) * 86_400_000).toISOString().slice(0, 10);
const byDateThenId = <T extends { occurredOn: string; txnId: string }>(a: T, b: T): number =>
  a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.txnId < b.txnId ? -1 : a.txnId > b.txnId ? 1 : 0;

/**
 * (F5 round 2) May this checking row be this card credit's other half, in the
 * first pass? The issuer-name guard; a tag on this card's debt says yes. (Round
 * 3) A tag on another debt says no HERE only: `pairCardPaymentCredits`' second
 * pass still lets the card's ledger claim the row (round 4: when it names the
 * issuer; round 5: or its tagged debt's own card ledger did not receive it).
 */
export function canPairCardCredit(credit: Pick<CardLedgerCredit, "debtIds">, outflow: Pick<CardLedgerOutflow, "namesIssuer" | "debtId">): boolean {
  if (outflow.debtId) return (credit.debtIds ?? []).includes(outflow.debtId);
  return outflow.namesIssuer ?? true;
}

/**
 * ⭐ A CARD CREDIT AND THE CHECKING ROW THAT SENT IT ARE ONE PAYMENT. Credits
 * in date order; each takes the unpaired checking outflow of the SAME cents
 * dated from 5 days before to 5 days after it that names the issuer (or is
 * tagged to the card's debt — `canPairCardCredit`), the closest first (the
 * earlier on a tie); (round 3) a credit still alone then takes a same-cents row
 * in its window tagged to ANOTHER debt (the card's ledger wins over the tag)
 * when the row names the issuer (round 4) or (round 5) the tagged debt is a
 * card whose own ledger H2 reads (`opts.ledgerDebtIds`) — (round 6) a row
 * tagged to such a card only once its window to reach that card has closed
 * (`opts.todayISO`). A credit with none
 * was paid from elsewhere (`outflow` null). Each outflow pairs once. F1's rule,
 * moved out of the hooks' loader so the ledger computes it once; (F5 round 2)
 * with the issuer-name guard and a wider after-window. Pure.
 */
export function pairCardPaymentCredits(
  credits: readonly CardLedgerCredit[],
  outflows: readonly CardLedgerOutflow[],
  opts: {
    /**
     * (F5 round 5) The debts linked to a card whose ledger H2 reads (every card
     * of the roster, credits or not). A row tagged to one of them that its own
     * card's ledger did not receive (pass 1 would have paired it there) went
     * somewhere else: pass 2 may give it to the card whose credit matches,
     * whatever its text says.
     */
    ledgerDebtIds?: Iterable<string>;
    /**
     * ⭐ (F5 round 6) The household's today. Pass 2 takes a row tagged to one of
     * `ledgerDebtIds` (named or not) only once its own card had its whole
     * window to receive it: dated on or before today − `CARD_CREDIT_PAIR_BEFORE`.
     * Absent: never (no row is known to be old enough).
     */
    todayISO?: string;
  } = {},
): Array<{ credit: CardLedgerCredit; outflow: CardLedgerOutflow | null }> {
  const sortedCredits = [...credits].sort(byDateThenId);
  const sortedOutflows = [...outflows].sort(byDateThenId);
  const ledgerDebts = new Set(opts.ledgerDebtIds ?? []);
  const windowClosedBy = opts.todayISO ? shiftDaysISO(opts.todayISO, -CARD_CREDIT_PAIR_BEFORE) : null;
  const paired = new Set<string>();
  /** The closest fitting row (the earlier on a tie). */
  const bestFor = (c: CardLedgerCredit, fits: (r: CardLedgerOutflow) => boolean): CardLedgerOutflow | null => {
    let best: CardLedgerOutflow | null = null;
    for (const r of sortedOutflows) {
      if (paired.has(r.txnId) || r.cents !== c.cents) continue;
      const gap = dayGap(r.occurredOn, c.occurredOn);
      if (gap < -CARD_CREDIT_PAIR_BEFORE || gap > CARD_CREDIT_PAIR_AFTER) continue;
      if (!fits(r)) continue;
      if (!best || Math.abs(gap) < Math.abs(dayGap(best.occurredOn, c.occurredOn))) best = r;
    }
    return best;
  };
  // Pass 1: the tag and the issuer-name guard (`canPairCardCredit`).
  const first = new Map<CardLedgerCredit, CardLedgerOutflow | null>();
  for (const c of sortedCredits) {
    const best = bestFor(c, (r) => canPairCardCredit(c, r));
    if (best) paired.add(best.txnId);
    first.set(c, best);
  }
  // ⭐ (F5 round 3) Pass 2: THE CARD'S LEDGER WINS OVER A TAG THAT NAMES ANOTHER
  // DEBT. A credit still alone may take a same-cents row in its window that the
  // household tagged to a debt NOT linked to this card — a mis-tag, or a tag on a
  // debt tracked by hand — once no credit on the tagged debt's own card claimed
  // it (pass 1). Left apart, the credit read "paid from elsewhere" and paid this
  // card while the row paid the tagged debt too: one payment, counted twice.
  // A tag only ever says yes; it never keeps a row from the card that received it.
  // (Round 4) The row must NAME THE ISSUER, as pass 1 asks of an untagged row: a
  // same-cents "AUTO FINANCE PMT" tagged to a car loan is the loan's payment, not
  // a card credit's other half (paired, it left the loan's minimum unpaid while
  // the bank had paid it — one payment, two outflows on the curve).
  // ⭐ (Round 5) …OR be tagged to a debt whose card's own ledger H2 reads. Round 4
  // asked every such row to name the issuer, and a mis-tagged card payment the
  // bank writes "ONLINE PMT CARD 7101" (or "AMERICAN EXP CO", before the
  // abbreviations) stayed apart: the credit paid this card's weeks and the row
  // paid the tagged debt's minimum — one payment, counted twice. A card with a
  // ledger is the evidence: had it received the row, pass 1 would have paired
  // them there. A debt with no ledger here (a loan, a card H2 does not read)
  // still needs the issuer's name.
  // ⭐ (Round 6) …and only once that card had its WHOLE window to receive it: a
  // row tagged to a ledger card's debt, named or not, is taken only when dated on
  // or before today − `CARD_CREDIT_PAIR_BEFORE`. Before then its card's credit
  // may still post; round 5 gave a correctly tagged payment still on its way to
  // another card's same-cents credit (paid from elsewhere), and the tagged card
  // in full held the whole payment over what it owes (no week paid, not in
  // flight). A debt with no ledger here is not gated: its card's credit never
  // shows, so waiting tells nothing.
  const takenInPass2 = (r: CardLedgerOutflow): boolean => {
    if (!r.debtId) return false;
    if (!ledgerDebts.has(r.debtId)) return r.namesIssuer ?? true;
    return windowClosedBy != null && r.occurredOn <= windowClosedBy;
  };
  const out: Array<{ credit: CardLedgerCredit; outflow: CardLedgerOutflow | null }> = [];
  for (const c of sortedCredits) {
    let best = first.get(c) ?? null;
    if (!best) {
      best = bestFor(c, takenInPass2);
      if (best) paired.add(best.txnId);
    }
    out.push({ credit: c, outflow: best });
  }
  return out;
}

/** The same day `months` months away, clamped to the month's last day ("2026-10-31" − 1 → "2026-09-30"). */
export function shiftMonthsISO(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A debt minimum due on or before today, waiting for its payment. */
export interface CardLedgerMinimum {
  /** The occurrence (`debt:<id>|<date>`). */
  key: string;
  debtId: string;
  /** Its due date (after any reschedule). */
  dueDate: string;
  /** The minimum, cents (> 0). */
  cents: number;
}

/** A payment the debt's own card received. */
export interface CardLedgerPayment {
  /** The checking row that sent it, or the card credit itself when none did (paid from elsewhere). */
  txnId: string;
  occurredOn: string;
  cents: number;
  debtId: string;
}

export interface CardLedgerMinimumPaid {
  key: string;
  txnId: string;
  /** The payment's own cents (what the row paid in all). */
  paymentCents: number;
  /** (F5 round 2) What it paid toward this minimum: the minimum, in full. */
  cents: number;
}

/**
 * (F5 round 2) Days before a minimum's due date its statement is taken to have
 * closed. A card's statement closes about 25 days before the due date; 20 is
 * the CAUTIOUS close: a payment between the real close and this one does not
 * count for the minimum (it stays on the curve — the forecast reads low).
 */
export const CARD_MINIMUM_CLOSE_DAYS = 20;

/** The cautious statement close of a minimum due on `dueDate`. */
export const minimumStatementCloseISO = (dueDate: string): string => {
  const d = new Date(Date.parse(`${dueDate}T00:00:00Z`) - CARD_MINIMUM_CLOSE_DAYS * 86_400_000);
  return d.toISOString().slice(0, 10);
};

/**
 * ⭐ (F5) A PAYMENT THE CARD'S OWN LEDGER RECEIVED PAYS THAT CARD'S DEBT
 * MINIMUMS, BY BILLING CYCLE, OLDEST FIRST. A minimum due on D is paid by a
 * payment made after its statement closed (the cautious close, D − 20 days —
 * `minimumStatementCloseISO`) and before the next due date (D + 1 month):
 * early inside its own cycle, or late while it is still unpaid. A payment made
 * before a statement closed never pays that statement's minimum, so one late
 * payment can no longer pay the next month's minimum too (round 2: the window
 * used to open at the previous due date). One payment may pay several minimums
 * — each only when it is dated after that minimum's close ($300 on 9/23 pays a
 * late 9/4 $45 and the 10/4 $45, whose statement closed 9/14); a minimum is
 * paid only in full; what is left of a payment paid the balance. Strongest
 * evidence there is: the money is on the card's ledger, so it can never be
 * another card's. Pure.
 */
export function minimumsPaidByCardLedger(
  minimums: readonly CardLedgerMinimum[],
  payments: readonly CardLedgerPayment[],
): CardLedgerMinimumPaid[] {
  const open = minimums
    .filter((m) => m.cents > 0)
    .map((m) => ({ ...m, from: minimumStatementCloseISO(m.dueDate), to: shiftMonthsISO(m.dueDate, 1), paid: false }))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: CardLedgerMinimumPaid[] = [];
  for (const p of payments.filter((x) => x.cents > 0).slice().sort(byDateThenId)) {
    let left = Math.round(p.cents);
    for (const m of open) {
      if (m.paid || m.debtId !== p.debtId) continue;
      if (!(p.occurredOn > m.from && p.occurredOn < m.to)) continue;
      if (left < m.cents) continue;
      m.paid = true;
      left -= m.cents;
      out.push({ key: m.key, txnId: p.txnId, paymentCents: Math.round(p.cents), cents: Math.round(m.cents) });
    }
  }
  return out;
}
