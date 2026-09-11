import { tokenizeDescription } from "./descriptionMatch";

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
 *     WORD in the row's description): |difference| ≤ max($25, 25% of the plan);
 *   - WITHOUT it: |difference| ≤ max($1, 1% of the plan) and within 3 days.
 * Pairing is one to one, best score first; a pair whose runner-up is close is
 * flagged `ambiguous`.
 *
 * ⚠️ (PR5 review) Only an `offCurve` pair may take its plan off the forecast
 * curve before the user answers: the payee's name, not ambiguous, and the row
 * paid no less than the plan − max($1, 1%) and no more than the plan +
 * max($25, 10%). An unconfirmed guess must never overstate projected cash — the
 * reviewer found $1,500 rent taken off the curve by an unrelated $1,500 Zelle
 * with no name, and "rent" inside "PARENTS". An UNDERPAID bill stays on the
 * curve (the user confirms "partial"): dropping it would hide what is still due.
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
};

export type MatchRow = {
  txnId: string;
  occurredOn: string;
  /** Signed: negative is money out. */
  amount: number;
  description: string | null;
};

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
  /** The plan may leave the forecast curve before the user answers (see above). */
  offCurve: boolean;
};

export const MATCH_EARLY_DAYS = 10;
export const MATCH_LATE_DAYS = 14;
export const MATCH_STRICT_DAYS = 3;
/** A named, unambiguous pair overpaid by at most max($25, this share of the plan) may leave the curve. */
export const MATCH_OFF_CURVE_SHARE = 0.1;

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

function evidenceFromWords(label: ReadonlySet<string>, desc: ReadonlySet<string>): boolean {
  for (const group of ALIASES) {
    const has = (words: ReadonlySet<string>) => group.some((form) => form.every((w) => words.has(w)));
    if (has(label) && has(desc)) return true;
  }
  for (const word of label) {
    if (word.length < 4 || MATCH_STOP_WORDS.has(word)) continue;
    if (desc.has(word)) return true;
  }
  return false;
}

/** Does a distinctive word of the plan's label appear as a word in the row's description? */
export function labelEvidence(label: string, description: string | null): boolean {
  return evidenceFromWords(tokenizeDescription(label), tokenizeDescription(description));
}

type Candidate = {
  plan: MatchPlan;
  row: MatchRow;
  gapCents: number;
  dayDelta: number;
  evidence: boolean;
  score: number;
};

/**
 * Pair plans with rows one to one. `notMatch` holds `<planKey>#<txnId>` pairs
 * the user rejected; they never pair again. Each label and description is split
 * into words once, and the cheap sign/date/amount checks run first.
 */
export function matchPlansToRows(
  plans: readonly MatchPlan[],
  rows: readonly MatchRow[],
  notMatch: ReadonlySet<string> = new Set(),
): PlanRowMatch[] {
  const rowDays = rows.map((r) => dayNumber(r.occurredOn));
  const rowWords: Array<ReadonlySet<string> | undefined> = new Array(rows.length);
  const all: Candidate[] = [];
  for (const plan of plans) {
    if (plan.amount === 0) continue;
    const p = cents(plan.amount);
    const loose = Math.max(2500, Math.round(p * 0.25));
    const strict = Math.max(100, Math.round(p * 0.01));
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
      const evidence = evidenceFromWords(planWords, words);
      if (!evidence && (gapCents > strict || Math.abs(dayDelta) > MATCH_STRICT_DAYS)) return;
      all.push({ plan, row, gapCents, dayDelta, evidence, score: gapCents + 100 * Math.abs(dayDelta) - (evidence ? 5000 : 0) });
    });
  }
  all.sort(
    (a, b) => a.score - b.score || a.plan.key.localeCompare(b.plan.key) || a.row.txnId.localeCompare(b.row.txnId),
  );
  const usedPlans = new Set<string>();
  const usedRows = new Set<string>();
  const out: PlanRowMatch[] = [];
  for (const c of all) {
    if (usedPlans.has(c.plan.key) || usedRows.has(c.row.txnId)) continue;
    usedPlans.add(c.plan.key);
    usedRows.add(c.row.txnId);
    const margin = Math.max(100, Math.abs(c.score) * 0.1);
    const ambiguous = all.some(
      (o) =>
        o !== c &&
        (o.plan.key === c.plan.key || o.row.txnId === c.row.txnId) &&
        o.score - c.score <= margin,
    );
    const p = cents(c.plan.amount);
    const strict = Math.max(100, Math.round(p * 0.01));
    const offCurveGap = Math.max(2500, Math.round(p * MATCH_OFF_CURVE_SHARE));
    const confidence: MatchConfidence =
      c.evidence && c.gapCents <= strict && Math.abs(c.dayDelta) <= 5
        ? "high"
        : c.evidence && c.gapCents <= offCurveGap
          ? "medium"
          : "low";
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
      // Asymmetric: an overpaid bill already weighs its full amount as the row; an
      // underpaid one would hide the remainder still due.
      offCurve: c.evidence && !ambiguous && c.gapCents <= (cents(c.row.amount) >= p ? offCurveGap : strict),
    });
  }
  return out;
}
