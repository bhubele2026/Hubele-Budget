import { tokenizeDescription } from "./descriptionMatch";
import { matchesCardPaymentPattern, PFC_CARD_PAYMENT } from "./spendingRule";

/**
 * ⭐ "PROBABLY PAID" — WHICH PLANNED PAYMENT DID THIS BANK ROW PAY? (PR5)
 *
 * Read-only. The server never writes a match on its own (auto-match stays off).
 * The user confirms a suggestion ("matched"), rejects it ("not_match") or
 * confirms part of it ("partial"). The bank row itself always stays in cash.
 *
 * A plan and a row PAIR (a suggestion) when:
 *   - same sign;
 *   - the row is dated 10 days before to 14 days after the plan;
 *   - WITH the payee's name (a distinctive word of the plan's label appears as a
 *     WORD in the row's description, or — decision 13 — the description matches a
 *     row the user confirmed for this item, see `descriptorsMatch`): |difference|
 *     ≤ max($25, 25% of the plan);
 *   - WITHOUT it: |difference| ≤ max($1, 1% of the plan) and within 3 days.
 * Pairing is one to one. A pair that can be tier-1/2 evidence (below, ignoring
 * ambiguity) is taken before one that cannot; then a Plaid checking row before a
 * manual one; then best score first. A runner-up of the same or a better rank
 * whose score is close makes a pair `ambiguous`.
 *
 * ⭐ (Owner decision 13) WHAT A PAIR PROVES — ITS `tier`.
 * "A different charge from the same company must not hide an unpaid bill.
 * Merchant similarity alone is insufficient proof of payment." — and knowingly
 * understating cash is not acceptable either.
 *   - Tier 1, EXPLICIT: a checking row the user tagged to the plan's debt, paying
 *     no less than the plan − max($1, 1%). (A matched or partial resolution is
 *     explicit too; those plans never reach the matcher.)
 *     ⚠️ HOOK: a stored payment link and an Amex payoff event are tier-1
 *     evidence in later PRs — see `explicitEvidence`.
 *   - Tier 2, OBLIGATION EVIDENCE, requires ALL of: not ambiguous; the row is
 *     checking cash and not a logged debt payment (`onChecking`); dated 10 days
 *     before to 14 days after the plan (the pairing window); paying at most the
 *     plan + max($25, 10%); AND ONE of:
 *       (a) `category` — the row's category is the plan's, and no other active item
 *           of the same direction carries it (a one-time item counts only when it
 *           is dated within 31 days of the plan). May pay as little as the plan −
 *           max($25, 10%);
 *       (d) `confirmed_descriptor` — the row's description matches a row the user
 *           confirmed ("matched"/"partial") for this item (the last 12;
 *           `descriptorsMatch`), AND it pays inside those confirmed rows' amounts,
 *           widened by max($1, 1%) each way (and no less than the plan −
 *           max($25, 10%));
 *       (b) `full_name` — the plan's FULL name, and no other active item of the
 *           same direction carries its full name in this row too;
 *       (c) `name_exact` — some of the plan's name, within max($1, 1%), ≤ 5 days;
 *       (c′) `name_exact_unique` — some of the plan's name, within max($1, 1%),
 *           anywhere in the window, and no other active item of the same
 *           direction shares a name word with the row.
 *     (b), (c) and (c′) must pay at least the plan − max($1, 1%).
 *   - Tier 3, SUGGESTION ONLY: every other pair, including a row tagged to another
 *     debt. It stays on the curve (an overdue plan drags) until the user answers.
 * `offCurve` is `tier ≤ 2` AND the row pays at least the plan − max($1, 1%): an
 * UNDERPAID bill stays on the curve before it is due (the user confirms
 * "partial"), with the difference reported; once due, a tier-2 underpayment pays
 * the bill and only the remainder drags (the ledger). An unconfirmed guess must
 * never overstate projected cash — the PR5 reviewer found $1,500 rent taken off
 * the curve by an unrelated $1,500 Zelle with no name, and "rent" inside
 * "PARENTS". A different bill from the same payee ("VERIZON FIOS" for "Verizon
 * Wireless") shares only part of the name and stays a suggestion too.
 */

export type MatchPlan = {
  /** `<itemId>|<occurrenceDate>` — the resolution key. */
  key: string;
  itemId: string;
  /** The occurrence date resolutions are keyed on. */
  occurrenceDate: string;
  /** The date the plan lands on (after any reschedule, before any drag). */
  date: string;
  /** Signed: negative is money out. */
  amount: number;
  label: string;
  /**
   * (Debt tag) The debt this plan pays: a `debt:` minimum's debt, or the debt a
   * recurring bill is linked to. A row tagged to the same debt is tier-1
   * evidence; a row tagged to another debt is never evidence (tier 3).
   */
  debtId?: string | null;
  /**
   * (Decision 13) The plan's category — a recurring bill's `category_id`. Null
   * for a debt minimum and the Avalanche extra, which have none.
   */
  categoryId?: string | null;
  /**
   * (Decision 13, d) The rows the user confirmed as "matched" or "partial" for
   * this item: their descriptions and signed amounts (the ledger sends the last 12).
   */
  confirmedRows?: readonly ConfirmedRow[];
};

/** (Decision 13, d) A row the user confirmed for an item. */
export type ConfirmedRow = { description: string; amount: number };

export type MatchRow = {
  txnId: string;
  occurredOn: string;
  /** Signed: negative is money out. */
  amount: number;
  description: string | null;
  /** (PR6 second review) The user's "this is a card payment" flag (PR7 rule 3). */
  isExternalCardPayment?: boolean;
  /** (PR6 second review) Plaid's detailed category (PR7 rule 8). */
  pfcDetailed?: string | null;
  /**
   * (Debt tag) The debt the user tagged this row to (PR7 rule 2). The ledger
   * passes it only for a Plaid row on the checking account (review M2).
   */
  debtId?: string | null;
  /** (Decision 13) The row's category (a mapping rule's or the user's). */
  categoryId?: string | null;
  /**
   * (Decision 13) The row counts as checking cash (`classifyCashRows`: a Plaid row
   * on the configured account, or a manual/imported checking row) and is not a
   * payment logged in the app against a debt (a manual row carrying a `debtId`).
   * Only such a row can be tier-1 or tier-2 evidence: a cash row that proves
   * nothing would leave the bill dragging while the row also subtracts.
   */
  onChecking: boolean;
  /**
   * (Decision 13) A Plaid row on the configured checking account. PR7's
   * card-payment rule (`plansPaidInFullByName`) reads only these: a manual
   * "CAPITAL ONE MOBILE PYMT" beside its bank debit paid two Capital One minimums.
   * In pairing, a Plaid row is taken before a manual one: a manual twin of a bank
   * payment must not make the bank's pair ambiguous.
   */
  plaidChecking: boolean;
};

/**
 * (Decision 13) An active planned item: every recurring item marked active, and
 * each debt minimum and the Avalanche extra the forecast expands. Tier 2 judges
 * "no other item in the category", "no other item with the full name" and "no
 * other item sharing a name word" against this list, so it must hold every
 * active item — not only the plans inside the matching window.
 */
export type MatchItem = {
  itemId: string;
  label: string;
  categoryId: string | null;
  income: boolean;
  /** A one-time item's date (its anchor); null for a repeating item. */
  oneTimeDate?: string | null;
};

/** (Decision 13) 1 = explicit, 2 = obligation evidence, 3 = suggestion only. */
export type MatchTier = 1 | 2 | 3;

/** (Decision 13) Why a pair is tier 1 (`debt_tag`) or tier 2 (the rest). */
export type MatchEvidence =
  | "debt_tag"
  | "category"
  | "confirmed_descriptor"
  | "full_name"
  | "name_exact"
  | "name_exact_unique";

/**
 * (PR6 second review) Is this row a payment TO A CREDIT CARD, by PR7's rule
 * (`classifyOutflow` rules 3, 8 and 9): the user flagged it, Plaid calls it
 * `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`, or its description names an issuer's
 * payment ("CAPITAL ONE MOBILE PYMT", "DISCOVER E-PAYMENT"). A store purchase
 * ("TARGET T-2331", "APPLE STORE") or a car loan ("CAPITAL ONE AUTO CARPAY") is not.
 */
export function isCardPaymentRow(row: MatchRow): boolean {
  if (row.isExternalCardPayment === true) return true;
  if ((row.pfcDetailed ?? "").toUpperCase() === PFC_CARD_PAYMENT) return true;
  return matchesCardPaymentPattern(row.description ?? "");
}

export type MatchConfidence = "high" | "medium" | "low";

export type PlanRowMatch = {
  planKey: string;
  planItemId: string;
  planDate: string;
  txnId: string;
  planAmount: number;
  txnAmount: number;
  /** |txn| − |plan|: positive means more was paid than planned. */
  difference: number;
  /** txn date − plan date, in days: negative means paid early. */
  dayDelta: number;
  confidence: MatchConfidence;
  ambiguous: boolean;
  /** (Decision 13) What the pair proves: 1 explicit, 2 obligation evidence, 3 suggestion only. */
  tier: MatchTier;
  /** (Decision 13) Why the pair is tier 1 or 2; null for tier 3. Not sent to the web. */
  evidence: MatchEvidence | null;
  /**
   * The plan may leave the forecast curve before the user answers: `tier ≤ 2`
   * and the row pays at least the plan − max($1, 1%).
   */
  offCurve: boolean;
};

export const MATCH_EARLY_DAYS = 10;
export const MATCH_LATE_DAYS = 14;
export const MATCH_STRICT_DAYS = 3;
/** A tier-2 pair may pay at most max($25, this share of the plan) more — or, on its own category, less — than planned. */
export const MATCH_OFF_CURVE_SHARE = 0.1;
/** (Decision 13, c) Some of the name, within max($1, 1%), at most this many days from the plan. */
export const MATCH_PROMPT_DAYS = 5;
/** (Decision 13, a) A one-time item shares a category with a plan only when dated within this many days of it. */
export const MATCH_ONE_TIME_CATEGORY_DAYS = 31;
/** (Decision 13, d) How many confirmed rows per item the ledger reads as references. */
export const MATCH_CONFIRMED_DESCRIPTORS = 12;

/**
 * ⭐ (One-time bill move) THE EDIT RE-CHECK USES THE MATCHER'S CANDIDATE BOUNDS.
 *
 * `rowInMatchWindow` and `rowWithinMatchAmount` are exactly the date window
 * (`MATCH_EARLY_DAYS` / `MATCH_LATE_DAYS`) and the loose amount tolerance
 * (`MATCH_LOOSE_MIN_CENTS` / `MATCH_LOOSE_SHARE`) inside which `matchPlansToRows`
 * pairs a row carrying the payee's name at all — the CANDIDATE bounds, not a
 * confidence tier (the 5-day "high" window, the strict nameless tolerance, or
 * any tier window added later). A one-time bill edited so its confirmed row falls
 * outside them could never have been suggested for it, so its match needs a fresh
 * answer. ⚠️ `matchPlansToRows` still writes these bounds inline;
 * `planMatch.test.ts` pins both helpers to its pairing at the edges, so changing
 * the candidate bounds there fails that test until these follow.
 */
export function rowInMatchWindow(planISO: string, rowISO: string): boolean {
  const dayDelta = dayNumber(rowISO) - dayNumber(planISO);
  return dayDelta >= -MATCH_EARLY_DAYS && dayDelta <= MATCH_LATE_DAYS;
}

/** The loose amount tolerance's floor, in cents: a named row may miss the plan by $25. */
export const MATCH_LOOSE_MIN_CENTS = 2500;
/** The loose amount tolerance's share of the plan: a named row may miss it by 25%. */
export const MATCH_LOOSE_SHARE = 0.25;

/** Same sign, and |row| within max($25, 25% of the plan) of |plan| — the matcher's loose tolerance. */
export function rowWithinMatchAmount(planAmount: number, rowAmount: number): boolean {
  if (planAmount === 0 || Math.sign(planAmount) !== Math.sign(rowAmount)) return false;
  const p = cents(planAmount);
  return Math.abs(cents(rowAmount) - p) <= Math.max(MATCH_LOOSE_MIN_CENTS, Math.round(p * MATCH_LOOSE_SHARE));
}

/**
 * (One-time bill move, round 3) Does the row pay the plan IN FULL: same sign,
 * short by at most max($1, 1%), over by at most max($25, 10%)? That is the band
 * inside which a pair carrying the plan's full name leaves the forecast curve
 * (`offCurve`) — the only proof that pays a plan before anyone answers. A
 * confirmed match whose bill's amount is changed stays paid only inside it; the
 * loose tolerance would let a $300 row keep a $376 bill paid. Pinned to
 * `matchPlansToRows` in `planMatch.test.ts`.
 */
export function rowPaysPlanInFull(planAmount: number, rowAmount: number): boolean {
  if (planAmount === 0 || Math.sign(planAmount) !== Math.sign(rowAmount)) return false;
  const p = cents(planAmount);
  const r = cents(rowAmount);
  const short = Math.max(100, Math.round(p * 0.01));
  const over = Math.max(2500, Math.round(p * MATCH_OFF_CURVE_SHARE));
  return r >= p ? r - p <= over : p - r <= short;
}

/**
 * Words that appear in plan labels or bank descriptions without identifying a
 * payee. Every debt minimum's label ends in "minimum"; the avalanche plan is
 * "Avalanche extra payment"; bank rows say "ACH PMT", "AUTOPAY", "ONLINE"; and
 * generic nouns (city, insurance, loan, service, home) name no one in particular.
 * "American"/"express" are handled by the Amex alias instead.
 */
export const MATCH_STOP_WORDS: ReadonlySet<string> = new Set([
  "minimum", "payment", "payments", "pmt", "ach", "debit", "credit", "card", "online",
  "transfer", "autopay", "auto", "bill", "bills", "pay", "the", "and", "bank", "checking",
  "avalanche", "extra", "monthly", "weekly", "purchase", "recurring",
  "city", "county", "state", "insurance", "loan", "loans", "service", "services",
  "company", "inc", "llc", "corp", "group", "center", "home", "account",
  "american", "express",
]);

/** Brand aliases as word sequences: any form on the label is evidence for any form in the description. */
const ALIASES: ReadonlyArray<ReadonlyArray<readonly string[]>> = [[["amex"], ["american", "express"]]];

const cents = (n: number): number => Math.round(Math.abs(n) * 100);
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
/** max($1, 1% of the amount), in cents. */
const strictCents = (amountCents: number): number => Math.max(100, Math.round(amountCents * 0.01));
/** max($25, 10% of the plan), in cents. */
const wideCents = (planCents: number): number => Math.max(2500, Math.round(planCents * MATCH_OFF_CURVE_SHARE));

/**
 * How much of the plan's name the description carries: 0 = none, 1 = some
 * distinctive word, 2 = every distinctive word (an alias group counts as one).
 */
function nameMatch(label: ReadonlySet<string>, desc: ReadonlySet<string>): 0 | 1 | 2 {
  let distinctive = 0;
  let matched = 0;
  const aliasWords = new Set<string>();
  for (const group of ALIASES) {
    const has = (words: ReadonlySet<string>) => group.some((form) => form.every((w) => words.has(w)));
    if (!has(label)) continue;
    for (const form of group) for (const w of form) aliasWords.add(w);
    distinctive++;
    if (has(desc)) matched++;
  }
  for (const word of label) {
    if (word.length < 4 || MATCH_STOP_WORDS.has(word) || aliasWords.has(word)) continue;
    distinctive++;
    if (desc.has(word)) matched++;
  }
  return matched === 0 ? 0 : matched === distinctive ? 2 : 1;
}

/** Does a distinctive word of the plan's label appear as a word in the row's description? */
export function labelEvidence(label: string, description: string | null): boolean {
  return nameMatch(tokenizeDescription(label), tokenizeDescription(description)) > 0;
}

/** (Decision 13, d) A word that names someone on its own: not a stop word, with ≥ 4 letters or ≥ 3 digits. */
function distinctiveWord(word: string): boolean {
  if (MATCH_STOP_WORDS.has(word)) return false;
  return word.replace(/[^a-z]/g, "").length >= 4 || word.replace(/[^0-9]/g, "").length >= 3;
}

/**
 * ⭐ (Decision 13, d) DOES A ROW'S DESCRIPTION MATCH A CONFIRMED ONE?
 *
 * Stricter than `descriptionsFuzzyEqual` (the dedupe pass's token-subset rule,
 * unchanged): the two word sets are EQUAL, or one is a subset of the other and
 * the shorter carries at least two distinctive words. "ZELLE" is inside "ZELLE TO
 * JORDAN LEE" but names no one, so it never borrows Jordan's confirmation; "MADISON
 * GAS EL" (one distinctive word) matches only itself. Empty descriptions never match.
 */
export function descriptorsMatch(confirmed: string | null | undefined, description: string | null | undefined): boolean {
  const a = tokenizeDescription(confirmed);
  const b = tokenizeDescription(description);
  if (a.size === 0 || b.size === 0) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of small) if (!big.has(w)) return false;
  if (small.size === big.size) return true;
  let distinctive = 0;
  for (const w of small) if (distinctiveWord(w)) distinctive++;
  return distinctive >= 2;
}

export type PaidInFull = {
  planKey: string;
  txnId: string;
  txnAmount: number;
  /**
   * What made the row a payment of this plan: `card_payment` (a card payment
   * naming the card — decision 13's tier-2 "payment reference") or `debt_tag`
   * (the user tagged the row to the plan's debt — tier 1).
   */
  evidence: "card_payment" | "debt_tag";
};

/**
 * ⭐ (PR6 review) A PAYMENT OF THE DEBT THAT PAYS AT LEAST THE PLAN.
 *
 * Overdue evidence only: the ledger asks this about debt minimums already due,
 * never about a plan due after today, and it never changes `matchPlansToRows`.
 * A card's minimum is rarely paid at the minimum ($40 due, $812.40 paid), and the
 * matcher caps a named row at max($25, 25%) off the plan, so an overdue minimum
 * would drag although the card was paid. A plan is paid by a row when:
 *   - same sign;
 *   - the row is dated 10 days before to 14 days after the plan;
 *   - the row pays at least the plan (no upper bound: real card payments run
 *     many times the minimum);
 *   - the pair was not rejected ("Not this");
 *   - and the row is a payment OF THIS DEBT, by one of:
 *     - (debt tag, decision 13 tier 1) the user tagged the row to the plan's debt
 *       (`debtId`, PR7's rule 2). The name is not needed: "CHASE ONLINE PAYMENT"
 *       tagged to Chase Sapphire pays its minimum, although PR7's phrases don't
 *       know it. ⚠️ A row tagged to ANOTHER debt never pays this plan, by tag or by name;
 *     - (card_payment, decision 13 tier 2 "payment reference") an untagged PLAID
 *       row on the checking account (`plaidChecking`; a manual "CAPITAL ONE MOBILE
 *       PYMT" beside its bank debit paid two Capital One minimums) that is a CARD
 *       PAYMENT by PR7's rule (`isCardPaymentRow`; second review: a name word
 *       alone let "TARGET T-2331", a purchase, pay the Target RedCard minimum,
 *       "APPLE STORE" the Apple Card, and "CAPITAL ONE AUTO CARPAY", a car loan, a
 *       Capital One card) AND carries a distinctive word of the plan's label as a
 *       word of its description (the matcher's name rule: "Capital One Platinum
 *       minimum" ↔ "CAPITAL ONE MOBILE PYMT").
 * One row pays one plan and one plan takes one row: tagged pairs first, then
 * nearest date first. A row inside two occurrences' windows pays only one.
 */
export function plansPaidInFullByName(
  plans: readonly MatchPlan[],
  rows: readonly MatchRow[],
  notMatch: ReadonlySet<string> = new Set(),
): PaidInFull[] {
  const candidates: Array<{ plan: MatchPlan; row: MatchRow; days: number; evidence: PaidInFull["evidence"] }> = [];
  const rowWords = rows.map((r) => tokenizeDescription(r.description));
  for (const plan of plans) {
    if (plan.amount === 0) continue;
    const planDay = dayNumber(plan.date);
    const planWords = tokenizeDescription(plan.label);
    rows.forEach((row, j) => {
      if (Math.sign(plan.amount) !== Math.sign(row.amount)) return;
      const days = dayNumber(row.occurredOn) - planDay;
      if (days < -MATCH_EARLY_DAYS || days > MATCH_LATE_DAYS) return;
      if (cents(row.amount) < cents(plan.amount)) return;
      if (notMatch.has(`${plan.key}#${row.txnId}`)) return;
      if (row.debtId) {
        // The user's tag decides: this debt's payment, or not this plan at all.
        if (plan.debtId && row.debtId === plan.debtId) candidates.push({ plan, row, days, evidence: "debt_tag" });
        return;
      }
      if (!row.plaidChecking) return;
      if (nameMatch(planWords, rowWords[j]!) === 0) return;
      if (!isCardPaymentRow(row)) return;
      candidates.push({ plan, row, days, evidence: "card_payment" });
    });
  }
  const rank = (e: PaidInFull["evidence"]) => (e === "debt_tag" ? 0 : 1);
  candidates.sort(
    (a, b) =>
      rank(a.evidence) - rank(b.evidence) ||
      Math.abs(a.days) - Math.abs(b.days) ||
      a.plan.key.localeCompare(b.plan.key) ||
      a.row.txnId.localeCompare(b.row.txnId),
  );
  const usedPlans = new Set<string>();
  const usedRows = new Set<string>();
  const out: PaidInFull[] = [];
  for (const c of candidates) {
    if (usedPlans.has(c.plan.key) || usedRows.has(c.row.txnId)) continue;
    usedPlans.add(c.plan.key);
    usedRows.add(c.row.txnId);
    out.push({ planKey: c.plan.key, txnId: c.row.txnId, txnAmount: c.row.amount, evidence: c.evidence });
  }
  return out;
}

type Candidate = {
  plan: MatchPlan;
  row: MatchRow;
  rowWords: ReadonlySet<string>;
  gapCents: number;
  dayDelta: number;
  named: boolean;
  name: 0 | 1 | 2;
  score: number;
  /**
   * (Decision 13) Pairing order, taken lowest first: 0/1 whether the pair would
   * be tier 1 or 2 if not ambiguous (×2), plus 0 for a Plaid checking row, 1 for
   * a manual one.
   */
  rank: number;
};

type Tiered = { tier: MatchTier; evidence: MatchEvidence | null };
const SUGGESTION: Tiered = { tier: 3, evidence: null };

/**
 * (Decision 13) TIER 1 — explicit evidence that the row paid the plan.
 * ⚠️ HOOK for later PRs: a stored payment link (the user linked this row to this
 * plan) and an Amex payoff event are tier-1 evidence and belong here.
 */
function explicitEvidence(c: Candidate): MatchEvidence | null {
  const { plan, row } = c;
  const p = cents(plan.amount);
  if (
    row.onChecking &&
    !!row.debtId &&
    row.debtId === (plan.debtId ?? null) &&
    cents(row.amount) >= p - strictCents(p)
  ) {
    return "debt_tag";
  }
  return null;
}

type ItemIndex = {
  list: Array<{ item: MatchItem; words: ReadonlySet<string> }>;
};

function indexItems(items: readonly MatchItem[]): ItemIndex {
  const seen = new Set<string>();
  const list: ItemIndex["list"] = [];
  for (const item of items) {
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    list.push({ item, words: tokenizeDescription(item.label) });
  }
  return { list };
}

/** (a) No other active item of the plan's direction carries its category (a one-time item only within 31 days). */
function soleInCategory(plan: MatchPlan, income: boolean, items: ItemIndex): boolean {
  const planDay = dayNumber(plan.date);
  return !items.list.some(
    ({ item }) =>
      item.itemId !== plan.itemId &&
      item.income === income &&
      item.categoryId === plan.categoryId &&
      (!item.oneTimeDate || Math.abs(dayNumber(item.oneTimeDate) - planDay) <= MATCH_ONE_TIME_CATEGORY_DAYS),
  );
}

/** (d) The row's description matches a row the user confirmed for this item. */
function confirmedDescriptor(plan: MatchPlan, row: MatchRow): boolean {
  if (!plan.confirmedRows?.length) return false;
  return plan.confirmedRows.some((c) => descriptorsMatch(c.description, row.description));
}

/** (d) The row pays inside the item's confirmed amounts, widened by max($1, 1%) each way. */
function inConfirmedRange(plan: MatchPlan, rowCents: number): boolean {
  const rows = plan.confirmedRows ?? [];
  if (rows.length === 0) return false;
  let lo = Infinity;
  let hi = 0;
  for (const c of rows) {
    const x = cents(c.amount);
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return rowCents >= lo - strictCents(lo) && rowCents <= hi + strictCents(hi);
}

/** (Decision 13) The tier of a pair. See the file header. */
function tierOf(c: Candidate, ambiguous: boolean, items: ItemIndex): Tiered {
  const { plan, row } = c;
  // A row the user tagged to another debt is never a payment of this plan.
  if (row.debtId && plan.debtId && row.debtId !== plan.debtId) return SUGGESTION;
  const explicit = explicitEvidence(c);
  if (explicit) return { tier: 1, evidence: explicit };
  if (ambiguous || !row.onChecking) return SUGGESTION;
  const p = cents(plan.amount);
  const r = cents(row.amount);
  const wide = wideCents(p);
  if (r > p + wide || r < p - wide) return SUGGESTION;
  const income = plan.amount > 0;
  // (a) Its own category may pay as little as the plan − max($25, 10%).
  if (plan.categoryId && row.categoryId === plan.categoryId && soleInCategory(plan, income, items)) {
    return { tier: 2, evidence: "category" };
  }
  // (d) A confirmed descriptor, inside the confirmed amounts ± max($1, 1%).
  if (confirmedDescriptor(plan, row) && inConfirmedRange(plan, r)) {
    return { tier: 2, evidence: "confirmed_descriptor" };
  }
  // NAME evidence must pay at least the plan − max($1, 1%).
  const strict = strictCents(p);
  if (r < p - strict) return SUGGESTION;
  const others = items.list.filter((it) => it.item.itemId !== plan.itemId && it.item.income === income);
  // (b) The plan's full name, and no other active item's full name, in the row.
  if (c.name === 2 && !others.some((it) => nameMatch(it.words, c.rowWords) === 2)) {
    return { tier: 2, evidence: "full_name" };
  }
  if (c.named && c.gapCents <= strict) {
    // (c) Some of the name, paid within max($1, 1%) and 5 days.
    if (Math.abs(c.dayDelta) <= MATCH_PROMPT_DAYS) return { tier: 2, evidence: "name_exact" };
    // (c′) …anywhere in the window, when no other item shares a name word with the row.
    if (!others.some((it) => nameMatch(it.words, c.rowWords) > 0)) return { tier: 2, evidence: "name_exact_unique" };
  }
  return SUGGESTION;
}

/**
 * Pair plans with rows one to one, and grade each pair (decision 13). `items`
 * is every active planned item (see `MatchItem`). `notMatch` holds
 * `<planKey>#<txnId>` pairs the user rejected; they never pair again. Each label
 * and description is split into words once, and the cheap sign/date/amount
 * checks run first.
 */
export function matchPlansToRows(
  plans: readonly MatchPlan[],
  rows: readonly MatchRow[],
  items: readonly MatchItem[],
  notMatch: ReadonlySet<string> = new Set(),
): PlanRowMatch[] {
  const index = indexItems(items);
  const rowDays = rows.map((r) => dayNumber(r.occurredOn));
  const rowWords: Array<ReadonlySet<string> | undefined> = new Array(rows.length);
  const all: Candidate[] = [];
  for (const plan of plans) {
    if (plan.amount === 0) continue;
    const p = cents(plan.amount);
    const loose = Math.max(2500, Math.round(p * 0.25));
    const strict = strictCents(p);
    const planDay = dayNumber(plan.date);
    let planWords: ReadonlySet<string> | undefined;
    rows.forEach((row, j) => {
      if (Math.sign(plan.amount) !== Math.sign(row.amount)) return;
      const dayDelta = rowDays[j]! - planDay;
      if (dayDelta < -MATCH_EARLY_DAYS || dayDelta > MATCH_LATE_DAYS) return;
      const gapCents = Math.abs(cents(row.amount) - p);
      if (gapCents > loose) return;
      if (notMatch.has(`${plan.key}#${row.txnId}`)) return;
      planWords ??= tokenizeDescription(plan.label);
      const words = (rowWords[j] ??= tokenizeDescription(row.description));
      const name = nameMatch(planWords, words);
      const named = name > 0;
      // (Decision 13, d) A description the user confirmed for this item names its
      // payee as surely as the label does ("MADISON GAS EL" for "MGE Electric & Gas").
      const referenced = !named && confirmedDescriptor(plan, row);
      if (!named && !referenced && (gapCents > strict || Math.abs(dayDelta) > MATCH_STRICT_DAYS)) return;
      const c: Candidate = {
        plan,
        row,
        rowWords: words,
        gapCents,
        dayDelta,
        named,
        name,
        score: gapCents + 100 * Math.abs(dayDelta) - (named || referenced ? 5000 : 0),
        rank: 0,
      };
      // (Decision 13) A pair that would be evidence is taken before one that would
      // not; then a Plaid checking row before a manual one.
      c.rank = (tierOf(c, false, index).tier <= 2 ? 0 : 2) + (row.plaidChecking ? 0 : 1);
      all.push(c);
    });
  }
  all.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.score - b.score ||
      a.plan.key.localeCompare(b.plan.key) ||
      a.row.txnId.localeCompare(b.row.txnId),
  );
  const usedPlans = new Set<string>();
  const usedRows = new Set<string>();
  const out: PlanRowMatch[] = [];
  for (const c of all) {
    if (usedPlans.has(c.plan.key) || usedRows.has(c.row.txnId)) continue;
    usedPlans.add(c.plan.key);
    usedRows.add(c.row.txnId);
    const margin = Math.max(100, Math.abs(c.score) * 0.1);
    // A close runner-up makes a pair ambiguous only when it is of the same or a
    // better rank: a pair that proves nothing, or a manual twin of a Plaid row,
    // never casts doubt on one that ranks above it.
    const ambiguous = all.some(
      (o) =>
        o !== c &&
        o.rank <= c.rank &&
        (o.plan.key === c.plan.key || o.row.txnId === c.row.txnId) &&
        o.score - c.score <= margin,
    );
    const p = cents(c.plan.amount);
    const confidence: MatchConfidence =
      c.named && c.gapCents <= strictCents(p) && Math.abs(c.dayDelta) <= MATCH_PROMPT_DAYS
        ? "high"
        : c.named && c.gapCents <= wideCents(p)
          ? "medium"
          : "low";
    const { tier, evidence } = tierOf(c, ambiguous, index);
    out.push({
      planKey: c.plan.key,
      planItemId: c.plan.itemId,
      planDate: c.plan.occurrenceDate,
      txnId: c.row.txnId,
      planAmount: c.plan.amount,
      txnAmount: c.row.amount,
      difference: (cents(c.row.amount) - p) / 100,
      dayDelta: c.dayDelta,
      confidence,
      ambiguous,
      tier,
      evidence,
      // Underpaid past max($1, 1%): stays on the curve before it is due.
      offCurve: tier <= 2 && cents(c.row.amount) >= p - strictCents(p),
    });
  }
  return out;
}
