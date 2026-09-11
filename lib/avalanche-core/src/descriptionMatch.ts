/**
 * (#452 / #800) Description fuzzy-equality, shared by the ledger dedupe pass
 * (`artifacts/api-server/src/lib/dedupeTransactions.ts`) and the pending→posted
 * supersede rule (`pendingSupersede.ts`, PR4c). Moved here verbatim from the
 * dedupe pass so both use one definition.
 */

/**
 * (#452 / #800) Tokenize a description for fuzzy-equality matching.
 *
 * Lowercases, strips non-alphanumerics (so punctuation differences
 * like commas, parentheses, hyphens don't fragment the token set),
 * and splits on whitespace. The resulting unordered token set is
 * compared subset-wise by `descriptionsFuzzyEqual` so a short
 * merchant label ("Affirm") and the long bank-statement form
 * ("AFFIRM.COM PAYME ... Merchant: Affirm") collapse to the same
 * cluster within an exact (account, date, amount) match.
 */
export function tokenizeDescription(s: string | null | undefined): Set<string> {
  const norm = (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  return new Set(norm.split(/\s+/).filter(Boolean));
}

/**
 * (#800) Two descriptions are fuzzy-equal when one's token set is a
 * subset of the other's. This is asymmetric-friendly: it lets the
 * short merchant form ("Affirm") collapse with the long bank-statement
 * form ("AFFIRM.COM PAYME ... Merchant: Affirm") but does NOT collapse
 * two truly different merchants that happen to share an amount and
 * date (e.g. "REPLIT, INC. FOSTER CITY CA" vs "LOVABLE DOVER DE" —
 * neither's tokens are a subset of the other).
 *
 * Empty token sets only match other empty token sets. A real
 * description must never collapse onto a row with no description; the
 * loss of identifying text is too easy to mis-merge.
 */
export function descriptionsFuzzyEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const A = tokenizeDescription(a);
  const B = tokenizeDescription(b);
  if (A.size === 0 || B.size === 0) return A.size === B.size;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}
