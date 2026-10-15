/**
 * ⭐ (F6 round 3) The quiet label on an expired hold — a row still pending more
 * than 7 days after its date that no posted row replaced, or its reversal. The
 * server says which (`expiredHold` on the list and ledger rows); it counts in no
 * total (`isCounted`, lib/countedRows.ts). The row stays visible, its amount out
 * of every total on the page. (F6 round 4) Its own module, so any page that
 * lists such a row can say so without pulling in the account-page row.
 */
export function ExpiredHoldLabel({ id }: { id: string }) {
  return (
    <span
      className="chip gray whitespace-nowrap"
      title="Still pending more than 7 days after its date. Not counted anywhere. If it posts, the posted charge counts."
      data-testid={`label-expired-hold-${id}`}
    >
      Expired hold · not counted
    </span>
  );
}

/**
 * ⭐ (F6 round 6) The quiet label on a HELD PAIR in a spending list — a hold the
 * bank snapshot already held, and its reversal (`expiredPair`). The bank
 * balance and the register count both (they net to 0), so the row is not
 * "not counted"; but no spending total counts it (`isCountedSpend`). Listed
 * with this label, the rows a group shows add up to its header.
 */
export function ExpiredPairLabel({ id }: { id: string }) {
  return (
    <span
      className="chip gray whitespace-nowrap"
      title="A hold and its reversal. They cancel out in the bank balance. Not counted in spending."
      data-testid={`label-expired-pair-${id}`}
    >
      Hold and its reversal · not counted here
    </span>
  );
}
