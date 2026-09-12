/**
 * (PR5b) The one forecast decision a bank row carries, for pages that read
 * resolutions per row (the Chase / Transactions page).
 *
 * ⚠️ "Not this" (`not_match`) answers are about one plan/row PAIR and never
 * decide the row. The server keeps them beside the real decision, in no
 * guaranteed order, so a "last write wins" read could show a matched row as
 * still in Review — and offer an action that deletes the match. They are left
 * out here, which also makes the read independent of order: the server keeps
 * at most one other resolution per row.
 *
 * A `partial` is a decision like `matched`: the row paid part of a plan.
 *
 * (One-time bill move) A `needs_review` is not a decision: a move put the match
 * in question and the row is back in Review until the user answers.
 */
export type RowResolution = {
  status: string;
  matchedTxnId?: string | null;
};

export function rowDecisionsByTxn(
  resolutions: ReadonlyArray<RowResolution>,
): Map<string, { status: string }> {
  const out = new Map<string, { status: string }>();
  for (const r of resolutions) {
    if (
      !r.matchedTxnId ||
      r.status === "not_match" ||
      r.status === "needs_review" ||
      r.status === "needs_review_partial"
    )
      continue;
    out.set(r.matchedTxnId, { status: r.status });
  }
  return out;
}
