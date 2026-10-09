import type { LearnedRule } from "@workspace/api-client-react/features";
import { shortDateOfInstant } from "@/lib/dates";
import { fmtMoney } from "@/lib/money";

/**
 * (F2) Words and order for the "Learned from your corrections" panel on
 * Mapping rules. A learned rule is H2's merchant memory: the category the
 * household chose for a merchant, how far it applies and how often a person
 * confirmed it. Behaviour ported from the frozen h2 app's
 * `screens/activity/RulesView.tsx` (never imported from it). Display only:
 * every figure here is one the server returned.
 */

export type LearnedScope = LearnedRule["scope"];

export const LEARNED_SCOPES: ReadonlyArray<{ key: LearnedScope; label: string }> = [
  { key: "merchant", label: "Any account, any amount" },
  { key: "merchant_account", label: "This account only" },
  { key: "merchant_amount", label: "Similar amounts only" },
];

/** Off rules last; then the most recently confirmed first; then by name. */
export function sortLearnedRules(rules: readonly LearnedRule[]): LearnedRule[] {
  return [...rules].sort(
    (a, b) =>
      Number(a.disabled) - Number(b.disabled) ||
      (b.lastConfirmedAt ?? "").localeCompare(a.lastConfirmedAt ?? "") ||
      a.signature.localeCompare(b.signature),
  );
}

/** "corner market" → "Corner Market". The signature is already normalised. */
export function merchantName(signature: string): string {
  return signature.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** "Confirmed 6 times · last Oct 5". */
export function confirmedWords(rule: Pick<LearnedRule, "count" | "lastConfirmedAt">): string {
  const times = `Confirmed ${rule.count} ${rule.count === 1 ? "time" : "times"}`;
  const last = rule.lastConfirmedAt ? shortDateOfInstant(rule.lastConfirmedAt) : "";
  return last ? `${times} · last ${last}` : times;
}

/** "$40.00 to $60.00" for a rule narrowed to similar amounts; null otherwise. */
export function amountBandWords(
  rule: Pick<LearnedRule, "scope" | "amountBandLo" | "amountBandHi">,
): string | null {
  if (rule.scope !== "merchant_amount") return null;
  if (rule.amountBandLo == null || rule.amountBandHi == null) return null;
  return `${fmtMoney(rule.amountBandLo)} to ${fmtMoney(rule.amountBandHi)}`;
}

/**
 * Whether a rule can be narrowed to `scope`. The server refuses an account
 * scope for a rule that has no account, and an amount scope for one with no
 * band (`routes/learnedRules.ts`), so those choices are offered disabled.
 */
export function scopeAvailable(
  rule: Pick<LearnedRule, "scope" | "plaidAccountId" | "amountBandLo" | "amountBandHi">,
  scope: LearnedScope,
): boolean {
  if (scope === rule.scope || scope === "merchant") return true;
  if (scope === "merchant_account") return !!rule.plaidAccountId;
  return rule.amountBandLo != null && rule.amountBandHi != null;
}

function pastCharges(n: number): string {
  return `past ${n === 1 ? "charge" : "charges"}`;
}

/** The toast after a real run. */
export function filedWords(updated: number): string {
  return updated === 0 ? "No past charges to file." : `Filed ${updated} ${pastCharges(updated)}.`;
}

/** The words after the count on the dry-run line: "past charges will move into Groceries." */
export function previewTail(count: number, categoryName: string): string {
  return `${pastCharges(count)} will move into ${categoryName}.`;
}
