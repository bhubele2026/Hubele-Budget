// ⭐ (BANK-AUTO) A PROMOTION: the bank auto-sort (lib/bankAutoSort.ts) files a
// provisional decision for good when the household's own hand filings of the
// merchant agree. It is an ordinary `auto`-band decision of the same stage,
// told apart by its input hash, which names the provisional decision it
// promoted — so its undo (`undoDecision`) puts that decision back in the queue,
// and the unique (transaction_id, input_hash) keeps it from happening twice.
const PROMOTE_PREFIX = "promote:";

/** A promotion's input hash: the provisional decision it promotes. */
export const promoteHashOf = (decisionId: string): string => `${PROMOTE_PREFIX}${decisionId}`;

/** The provisional decision a promotion promoted, or null when `inputHash` is not a promotion's. */
export const promotedDecisionIdOf = (inputHash: string): string | null =>
  inputHash.startsWith(PROMOTE_PREFIX) ? inputHash.slice(PROMOTE_PREFIX.length) : null;

/** The LIKE pattern every promotion's input hash matches. */
export const PROMOTE_HASH_LIKE = `${PROMOTE_PREFIX}%`;
