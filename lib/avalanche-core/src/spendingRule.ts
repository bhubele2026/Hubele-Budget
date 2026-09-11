// ⭐ THE ONE SPENDING RULE (PR7). Pure, dependency-free, shared by the server
// (`artifacts/api-server/src/lib/spendingFilter.ts` re-exports it) and the web
// app (the Spending page's Recategorize popover). One copy, so the banner and
// the rows it offers to fix cannot disagree about what a card payment is.
//
// "Real spending" = money leaving the household to a MERCHANT for goods or
// services. It explicitly does NOT include:
//   - transfers between the household's own accounts
//   - debt payments (a row tagged to a debt, or a category linked to one)
//   - payments to a credit card (the purchases were counted on the card)
//   - reimbursable charges (someone else pays them back)
//   - reimbursement / ignore / transfer categories, and income categories
//   - bank-noise ACH/transfer/payment description patterns
//
// Sign convention (matches the rest of the app): a bank/Chase outflow is a
// NEGATIVE amount; a manual-workbook Amex charge (`source: "amex"`) is
// POSITIVE. `spendAmount()` normalizes both into a positive spend magnitude
// (0 when the row is not an outflow).
//
// Card payments are recognized AUTOMATICALLY, in spending totals only (owner's
// decision). Nothing here writes, and no per-row flag switches recognition
// off: a hand-picked category, a cleared Transfer chip or any other edit leaves
// a card payment a card payment.

// Every field the rules read is REQUIRED on purpose: a caller that forgets to
// select a column fails to compile instead of silently classifying with a
// default (a missing `debtId` would count a debt payment as spending).
export interface SpendTxn {
  amount: string | number;
  source: string;
  isTransfer: boolean;
  categoryId: string | null;
  description: string;
  /** Tagged debt payment (rule 2). */
  debtId: string | null;
  /** The user's explicit "this is a card payment" flag (rule 3). */
  isExternalCardPayment: boolean;
  /** Paid back by someone else (rule 7). */
  reimbursable: boolean;
  /** Plaid `personal_finance_category.detailed` (rule 8). */
  pfcDetailed: string | null;
}

export interface SpendContext {
  categoriesById: Map<
    string,
    { name: string; debtId: string | null; kind: string }
  >;
  debtCategoryIds: Set<string>;
}

// Category NAMES that are never real spend (case-insensitive). The system
// "Uncategorized" category is deliberately NOT here: a row parked there is
// still money spent.
const EXCLUDED_CATEGORY_NAMES: ReadonlySet<string> = new Set(
  [
    "Reimbursement",
    "Ignore",
    "Transfer",
    "Transfers in",
    "Transfers out",
    "Uncategorized — transfer",
  ].map((s) => s.toLowerCase()),
);

// Bank-noise description patterns that signal a transfer or a debt/card
// payment rather than a merchant purchase. Tested against the RAW (lowercased)
// description: several of these tokens ("web id:", "ach pmt") only exist in
// the raw bank string and are stripped by merchant-name extraction.
//
// ⚠️ Unchanged from before PR7, substring match included. "epay" therefore
// also drops a purchase whose name contains those letters ("REPAY *PEST
// CONTROL", "EPAYMENTS PLUMBING LLC"). Tightening it would count rows the app
// has always excluded, so it is left for a change that can measure that.
const TRANSFER_PAYMENT_PATTERNS: ReadonlyArray<string> = [
  "online transfer",
  "ach pmt",
  "ach payment",
  "web id:",
  "credit card pmt",
  "autopay",
  "payment thank you",
  "card pmt",
  "epay",
  "chase credit",
  "bk of amer",
  "wells fargo card",
];

/**
 * Raw-description phrases that identify a payment TO a credit card from
 * another account (rule 9). Written in normalized form: lowercase, letters and
 * digits only, single spaces.
 *
 * A description matches when the phrase appears as WHOLE WORDS after the same
 * normalization, so punctuation and padding in bank strings do not matter
 * ("SYNCHRONY BANK/PAYPAL", "PAYPAL *PAYMTHLY", "CAPITAL ONE   CRCARDPMT") and a
 * phrase cannot fire inside a longer word.
 *
 * Only issuer payment phrases belong here, never a merchant or brand name on
 * its own: "Capital One Café", "Apple Store", "Discover Books", "American
 * Express Travel", "PayPal *Netflix", "Best Buy", "Target" and "Mattress Firm"
 * are purchases. `spendingFilter.test.ts` pins both lists.
 */
export const CARD_PAYMENT_PATTERNS: readonly string[] = [
  "crcardpmt",
  "capital one mobile pymt",
  "capital one online pymt",
  "applecard gsbank",
  "goldman sachs apple",
  "discover e payment",
  "discover dc pymnts",
  "citi card online",
  "credit one bank",
  "synchrony paypal",
  "synchrony bank paypal",
  "synchrony bank payment",
  "synchrony ashley",
  "paypal paymthly",
  "barclaycard us creditcard",
  "target card srvc",
  "menards big card",
  "amex epayment",
  "amex ach pmt",
  "american express ach",
  // (PR7b)
  "payment to chase card ending in",
  "us bank credit card payment",
  "wf credit card auto pay",
  "target card services",
];

/**
 * (PR7b) Issuer codes a bank glues to a reference number
 * ("CRCARDPMT5KX9ABC"), which whole-word matching misses. A word matches when
 * it STARTS with a code and the rest of the word is empty or carries a digit
 * (a reference, not a name: "CRCARDPMTSHOP" is not a payment). A code never
 * matches in the middle of a word ("XCRCARDPMTX").
 */
export const CARD_PAYMENT_WORD_PREFIXES: readonly string[] = ["crcardpmt"];

/**
 * (PR7b) Payment phrases with no issuer in them ("CREDIT CARD PYMT"). They
 * follow the same position rule as every other phrase (see
 * `matchesCardPaymentPattern`); they are listed apart because on their own
 * they say nothing about WHICH card.
 */
export const GENERIC_CARD_PAYMENT_PHRASES: readonly string[] = [
  "credit card pymt",
  "credit card payment",
  "credit card auto pay",
];

/** ACH boilerplate that may follow a payment phrase. */
const REFERENCE_WORDS: ReadonlySet<string> = new Set([
  "ach",
  "ppd",
  "ccd",
  "web",
  "tel",
  "sec",
  "id",
  "ref",
  "conf",
  "trn",
  "pmt",
  "pymt",
  "payment",
  "auto",
  "pay",
  "autopay",
  "thank",
  "you",
]);

/** A word after one of these is an identifier, whatever its letters ("ID:WFCCAUTOPY"). */
const ID_LABELS: ReadonlySet<string> = new Set(["id", "ref", "conf", "trn"]);

/** Words that are labels only in front of "id" ("CO ID:", "ORIG ID:", "IND ID:"). */
const ID_QUALIFIERS: ReadonlySet<string> = new Set(["co", "orig", "ind"]);

/**
 * BofA's individual-name label ("INDN:JANE DOE"). Up to four words after it are
 * the account holder's name, not a merchant.
 */
const NAME_LABELS: ReadonlySet<string> = new Set(["indn"]);
const MAX_NAME_WORDS = 4;

/**
 * ACH entry-description labels: Chase's "CO ENTRY DESCR:", BofA's "DES:". A
 * phrase right after one is what the payer called the payment.
 */
const ENTRY_DESCRIPTION_LABELS: ReadonlySet<string> = new Set(["descr", "des"]);

/** After "to": the network or issuer being paid ("CREDIT CARD PYMT TO VISA"). */
const PAYEE_WORDS: ReadonlySet<string> = new Set([
  "visa",
  "mastercard",
  "mc",
  "amex",
  "american",
  "express",
  "discover",
  "citi",
  "citibank",
  "chase",
  "barclays",
  "barclaycard",
  "synchrony",
  "capital",
  "one",
  "us",
  "usbank",
  "bank",
  "wells",
  "fargo",
  "wf",
  "bofa",
  "boa",
  "of",
  "america",
  "elan",
  "fnbo",
  "apple",
  "goldman",
  "sachs",
  "card",
]);

/**
 * Card processors that put a merchant's name after them: "SQ *", "PAYPAL *",
 * "TST*", "SP ". A phrase after one is that merchant's name, so a description
 * that STARTS with one is a purchase unless the phrase itself starts there
 * ("PAYPAL *PAYMTHLY" is PayPal Credit's own payment).
 */
const PROCESSOR_PREFIXES: ReadonlySet<string> = new Set([
  "sq",
  "square",
  "paypal",
  "pp",
  "tst",
  "toast",
  "sp",
  "stripe",
  "clover",
  "clv",
  "pos",
]);

/** The words after a phrase: nothing but references, IDs, a labelled name or "to <issuer>". */
function followsLikeAPayment(rest: readonly string[]): boolean {
  let k = 0;
  if (rest[0] === "to") {
    k = 1;
    if (!PAYEE_WORDS.has(rest[k] ?? "")) return false;
    while (k < rest.length && PAYEE_WORDS.has(rest[k]!)) k += 1;
  }
  while (k < rest.length) {
    const w = rest[k]!;
    if (/\d/.test(w) || REFERENCE_WORDS.has(w)) {
      k += 1;
    } else if (k > 0 && ID_LABELS.has(rest[k - 1]!)) {
      k += 1;
    } else if (ID_QUALIFIERS.has(w) && rest[k + 1] === "id") {
      k += 1;
    } else if (NAME_LABELS.has(w)) {
      k += 1;
      for (
        let n = 0;
        n < MAX_NAME_WORDS &&
        k < rest.length &&
        !/\d/.test(rest[k]!) &&
        !REFERENCE_WORDS.has(rest[k]!) &&
        !ID_QUALIFIERS.has(rest[k]!);
        n += 1
      ) {
        k += 1;
      }
    } else {
      return false;
    }
  }
  return true;
}

/** Does a phrase found at words[start, end) read as a payment where it sits? */
function hitIsPayment(words: readonly string[], start: number, end: number): boolean {
  if (start > 0 && PROCESSOR_PREFIXES.has(words[0]!)) return false;
  if (start > 0 && ENTRY_DESCRIPTION_LABELS.has(words[start - 1]!)) return true;
  return followsLikeAPayment(words.slice(end));
}

function phraseIsPayment(words: readonly string[], phrase: readonly string[]): boolean {
  for (let i = 0; i + phrase.length <= words.length; i += 1) {
    if (!phrase.every((w, j) => words[i + j] === w)) continue;
    if (hitIsPayment(words, i, i + phrase.length)) return true;
  }
  return false;
}

/** Plaid's detailed category for a payment to a credit card (rule 8). */
export const PFC_CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

/** Lowercase, punctuation to spaces, single spaces, padded for word matching. */
export function normalizeDescription(description: string | null | undefined): string {
  return (description ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function spendAmount(tx: Pick<SpendTxn, "amount" | "source">): number {
  const a = typeof tx.amount === "number" ? tx.amount : parseFloat(tx.amount);
  if (!Number.isFinite(a)) return 0;
  if (tx.source === "amex") return a > 0 ? a : 0; // Amex charge is positive
  return a < 0 ? -a : 0; // bank outflow is negative
}

export function matchesTransferPattern(description: string): boolean {
  const d = (description ?? "").toLowerCase();
  return TRANSFER_PAYMENT_PATTERNS.some((p) => d.includes(p));
}

/**
 * Rule 9: the description names a payment to a credit card.
 *
 * WHAT: an issuer phrase (`CARD_PAYMENT_PATTERNS`), a generic phrase
 * (`GENERIC_CARD_PAYMENT_PHRASES`) — both as whole words — or a word starting
 * with an issuer code (`CARD_PAYMENT_WORD_PREFIXES`).
 *
 * WHERE (PR7b review N1, L1): the same words are a merchant's name in
 * "TARGET CARD SERVICES GIFT CARD" or "SQ *CREDIT CARD PAYMENT", so a match
 * counts only in a payment's position:
 *   - never after a leading card processor ("SQ *", "PAYPAL *", "TST*", …);
 *   - right after an ACH entry-description label ("… DESCR:CRCARDPMT",
 *     "… DES:CREDIT CARD PYMT …"), whatever follows; or
 *   - followed by nothing but references: words with a digit, ACH boilerplate,
 *     the value after an ID label ("PPD ID: WFCCAUTOPY", "CO ID:9999"), a name
 *     after BofA's "INDN:", or "to <issuer>" ("TO VISA").
 *
 * ⚠️ IT ERRS TOWARD MISSING, ON PURPOSE. A payment it misses still counts as
 * spending, but the user can flag it (`isExternalCardPayment`, rule 3). A
 * purchase it wrongly caught could not be put back: there is no "this was a
 * purchase" override yet. So an unlabelled name after a phrase
 * ("US BANK CREDIT CARD PAYMENT JANE DOE") reads as a purchase.
 */
export function matchesCardPaymentPattern(description: string): boolean {
  const norm = normalizeDescription(description);
  if (norm === "") return false;
  const words = norm.split(" ");
  for (const p of [...CARD_PAYMENT_PATTERNS, ...GENERIC_CARD_PAYMENT_PHRASES]) {
    if (phraseIsPayment(words, p.split(" "))) return true;
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    for (const code of CARD_PAYMENT_WORD_PREFIXES) {
      if (!w.startsWith(code)) continue;
      const tail = w.slice(code.length);
      if (tail !== "" && !/\d/.test(tail)) continue;
      if (hitIsPayment(words, i, i + 1)) return true;
    }
  }
  return false;
}

export function isExcludedCategoryName(name: string | null | undefined): boolean {
  return EXCLUDED_CATEGORY_NAMES.has((name ?? "").trim().toLowerCase());
}

export function isDebtCategory(
  tx: Pick<SpendTxn, "categoryId">,
  ctx: SpendContext,
): boolean {
  if (!tx.categoryId) return false;
  if (ctx.debtCategoryIds.has(tx.categoryId)) return true;
  const cat = ctx.categoriesById.get(tx.categoryId);
  return !!cat?.debtId;
}

export type OutflowKind =
  | "not_outflow"
  | "transfer"
  | "debt_payment"
  | "card_payment"
  | "excluded_category"
  | "income"
  | "reimbursable"
  | "bank_noise"
  | "spend";

/** Which rule decided, for tests and the transparency panel. */
export type OutflowRule =
  | "inflow"
  | "1-transfer"
  | "2-debt-id"
  | "3-external-card-payment"
  | "4-debt-category"
  | "5-excluded-category"
  | "6-income-category"
  | "7-reimbursable"
  | "8-pfc-card-payment"
  | "9-card-payment-pattern"
  | "9b-bank-noise"
  | "10-spend";

export interface OutflowClassification {
  kind: OutflowKind;
  rule: OutflowRule;
  /**
   * Only meaningful for `spend`: true when the row sits in a category that
   * still exists. No category, or a category that was deleted, is
   * uncategorized spend — still spending, shown in its own bucket.
   */
  categorized: boolean;
}

export interface ClassifyOptions {
  /**
   * Skip rule 7. The Amex payoff counts what is owed on the card, and a
   * reimbursable charge is owed to Amex whoever pays it back. Spending never
   * sets this.
   */
  reimbursableIsSpend?: boolean;
}

const out = (
  kind: OutflowKind,
  rule: OutflowRule,
  categorized = false,
): OutflowClassification => ({ kind, rule, categorized });

/**
 * ⭐ THE spending rule. First match wins:
 *
 *   1. `isTransfer`                                   → transfer
 *   2. tagged to a debt (`debtId`)                     → debt payment
 *   3. `isExternalCardPayment`                         → card payment
 *   4. category linked to a debt                       → debt payment
 *   5. excluded category name (Transfer, Ignore, …)    → excluded category
 *   6. income category                                 → income
 *   7. `reimbursable`                                  → reimbursable
 *   8. Plaid PFC LOAN_PAYMENTS_CREDIT_CARD_PAYMENT     → card payment
 *   9. `CARD_PAYMENT_PATTERNS`                         → card payment
 *   9b. bank-noise patterns (ACH PMT, WEB ID:, …)      → bank noise
 *   10. otherwise                                      → spend
 *
 * A category id that no longer resolves (the category was deleted) is treated
 * as no category: rules 4–6 cannot apply, and the row is uncategorized spend.
 *
 * Rules 8–9 apply whatever category the row carries and whoever set it. There
 * is deliberately no user override yet: a "this was a purchase" marker needs its
 * own column (a follow-up PR). `isTransferUserOverridden` is NOT that marker —
 * it is set by every hand-picked category — and is not read here.
 */
export function classifyOutflow(
  tx: SpendTxn,
  ctx: SpendContext,
  opts: ClassifyOptions = {},
): OutflowClassification {
  if (spendAmount(tx) <= 0) return out("not_outflow", "inflow");

  if (tx.isTransfer === true) return out("transfer", "1-transfer");
  if (tx.debtId) return out("debt_payment", "2-debt-id");
  if (tx.isExternalCardPayment === true) {
    return out("card_payment", "3-external-card-payment");
  }

  const cat = tx.categoryId ? ctx.categoriesById.get(tx.categoryId) : undefined;
  if (cat) {
    if (isDebtCategory(tx, ctx)) return out("debt_payment", "4-debt-category");
    if (isExcludedCategoryName(cat.name)) {
      return out("excluded_category", "5-excluded-category");
    }
    if (cat.kind === "income") return out("income", "6-income-category");
  }

  if (tx.reimbursable === true && !opts.reimbursableIsSpend) {
    return out("reimbursable", "7-reimbursable");
  }

  if ((tx.pfcDetailed ?? "").toUpperCase() === PFC_CARD_PAYMENT) {
    return out("card_payment", "8-pfc-card-payment");
  }
  if (matchesCardPaymentPattern(tx.description)) {
    return out("card_payment", "9-card-payment-pattern");
  }

  if (matchesTransferPattern(tx.description)) {
    return out("bank_noise", "9b-bank-noise");
  }

  return out("spend", "10-spend", !!cat);
}

// A categorized merchant purchase. Uncategorized rows return false here — the
// backlog is its own surface (see buildSpendingFacts.uncategorized).
export function isRealSpend(
  tx: SpendTxn,
  ctx: SpendContext,
  opts?: ClassifyOptions,
): boolean {
  const c = classifyOutflow(tx, ctx, opts);
  return c.kind === "spend" && c.categorized;
}

// Would-be real spend that is only excluded because it has no category yet
// (or its category was deleted).
export function isUncategorizedSpend(tx: SpendTxn, ctx: SpendContext): boolean {
  const c = classifyOutflow(tx, ctx);
  return c.kind === "spend" && !c.categorized;
}

// The inflow mirror of `spendAmount()`. A bank deposit is a POSITIVE amount;
// an Amex row is never income — a credit there is a refund or the monthly
// payment arriving, both of which are the household moving its own money.
export function incomeAmount(tx: Pick<SpendTxn, "amount" | "source">): number {
  const a = typeof tx.amount === "number" ? tx.amount : parseFloat(tx.amount);
  if (!Number.isFinite(a)) return 0;
  if (tx.source === "amex") return 0;
  return a > 0 ? a : 0;
}

// "Real income" = money arriving from OUTSIDE the household — the mirror of
// `isRealSpend`, and the denominator behind "how much of what we earned did we
// spend". It is deliberately category-led: an inflow counts only when it sits
// in a category the household itself classes as income, which is what keeps
// transfers in, refunds, reimbursements and debt draws out of the figure.
//
// ⚠️ Unlike the spend side this does NOT screen on description patterns. A real
// direct deposit routinely carries the same raw ACH tokens ("web id:") the
// spend filter uses to catch bank noise, so pattern-matching here would drop
// paychecks — the one row that must never go missing. An explicit `isTransfer`
// flag still excludes, because that is a human/importer decision about THIS
// row rather than a guess from its wording.
export function isRealIncome(
  tx: Pick<SpendTxn, "amount" | "source" | "isTransfer" | "categoryId">,
  ctx: SpendContext,
): boolean {
  if (incomeAmount(tx) <= 0) return false; // not an inflow
  if (tx.isTransfer === true) return false;
  if (!tx.categoryId) return false; // uncategorized -> not yet claimed as income
  const cat = ctx.categoriesById.get(tx.categoryId);
  if (!cat) return false;
  if (cat.kind !== "income") return false;
  if (isExcludedCategoryName(cat.name)) return false;
  if (cat.debtId || ctx.debtCategoryIds.has(tx.categoryId)) return false;
  return true;
}
