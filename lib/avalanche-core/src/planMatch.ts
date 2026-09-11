import { tokenizeDescription } from "./descriptionMatch";

/**
 * ⭐ "PROBABLY PAID" — WHICH PLANNED PAYMENT DID THIS BANK ROW PAY? (PR5)
 *
 * Read-only. The server never writes a match on its own (auto-match stays off);
 * a pair found here takes the plan off the forecast curve until the user
 * confirms it ("matched"), rejects it ("not_match") or confirms part of it
 * ("partial"). The bank row itself always stays in cash.
 *
 * A plan and a row pair when:
 *   - same sign;
 *   - the row is dated 10 days before to 14 days after the plan;
 *   - WITH label evidence (a label word appears in the row's description):
 *       |difference| ≤ max($25, 25% of the plan);
 *   - WITHOUT it: |difference| ≤ max($1, 1% of the plan) and within 3 days.
 * Pairing is one to one, best score first; a pair whose runner-up is close is
 * flagged `ambiguous`.
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
};

export const MATCH_EARLY_DAYS = 10;
export const MATCH_LATE_DAYS = 14;
export const MATCH_STRICT_DAYS = 3;

/**
 * Words that appear in plan labels or bank descriptions without identifying a
 * payee. Every debt minimum's label ends in "minimum"; the avalanche plan is
 * "Avalanche extra payment"; bank rows say "ACH PMT", "AUTOPAY", "ONLINE".
 */
export const MATCH_STOP_WORDS: ReadonlySet<string> = new Set([
  "minimum", "payment", "payments", "pmt", "ach", "debit", "credit", "card", "online",
  "transfer", "autopay", "auto", "bill", "pay", "the", "and", "bank", "checking",
  "avalanche", "extra", "monthly", "weekly", "purchase", "recurring",
]);

/** Brand aliases: either form on the label is evidence for either form in the description. */
const ALIASES: ReadonlyArray<readonly string[]> = [["amex", "american express"]];

const cents = (n: number): number => Math.round(Math.abs(n) * 100);
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const normalise = (s: string | null | undefined): string =>
  ` ${[...tokenizeDescription(s)].join(" ")} `;

/** Does a distinctive word of the plan's label appear in the row's description? */
export function labelEvidence(label: string, description: string | null): boolean {
  const desc = normalise(description);
  const lab = normalise(label);
  for (const group of ALIASES) {
    if (group.some((a) => lab.includes(` ${a} `)) && group.some((a) => desc.includes(a))) return true;
  }
  for (const word of tokenizeDescription(label)) {
    if (word.length < 4 || MATCH_STOP_WORDS.has(word)) continue;
    if (desc.includes(word)) return true;
  }
  return false;
}

type Candidate = {
  plan: MatchPlan;
  row: MatchRow;
  gapCents: number;
  dayDelta: number;
  evidence: boolean;
  score: number;
};

function candidate(plan: MatchPlan, row: MatchRow): Candidate | null {
  if (plan.amount === 0 || Math.sign(plan.amount) !== Math.sign(row.amount)) return null;
  const dayDelta = dayNumber(row.occurredOn) - dayNumber(plan.date);
  if (dayDelta < -MATCH_EARLY_DAYS || dayDelta > MATCH_LATE_DAYS) return null;
  const p = cents(plan.amount);
  const gapCents = Math.abs(cents(row.amount) - p);
  const evidence = labelEvidence(plan.label, row.description);
  if (evidence) {
    if (gapCents > Math.max(2500, Math.round(p * 0.25))) return null;
  } else if (gapCents > Math.max(100, Math.round(p * 0.01)) || Math.abs(dayDelta) > MATCH_STRICT_DAYS) {
    return null;
  }
  const score = gapCents + 100 * Math.abs(dayDelta) - (evidence ? 5000 : 0);
  return { plan, row, gapCents, dayDelta, evidence, score };
}

function confidenceOf(c: Candidate): MatchConfidence {
  const strictGap = Math.max(100, Math.round(cents(c.plan.amount) * 0.01));
  if (c.evidence && c.gapCents <= strictGap && Math.abs(c.dayDelta) <= 5) return "high";
  if (c.evidence || (c.gapCents === 0 && Math.abs(c.dayDelta) <= MATCH_STRICT_DAYS)) return "medium";
  return "low";
}

/**
 * Pair plans with rows one to one. `notMatch` holds `<planKey>#<txnId>` pairs
 * the user rejected; they never pair again.
 */
export function matchPlansToRows(
  plans: readonly MatchPlan[],
  rows: readonly MatchRow[],
  notMatch: ReadonlySet<string> = new Set(),
): PlanRowMatch[] {
  const all: Candidate[] = [];
  for (const plan of plans) {
    for (const row of rows) {
      if (notMatch.has(`${plan.key}#${row.txnId}`)) continue;
      const c = candidate(plan, row);
      if (c) all.push(c);
    }
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
    out.push({
      planKey: c.plan.key,
      planItemId: c.plan.itemId,
      planDate: c.plan.occurrenceDate,
      txnId: c.row.txnId,
      planAmount: c.plan.amount,
      txnAmount: c.row.amount,
      difference: (cents(c.row.amount) - cents(c.plan.amount)) / 100,
      dayDelta: c.dayDelta,
      confidence: confidenceOf(c),
      ambiguous,
    });
  }
  return out;
}
