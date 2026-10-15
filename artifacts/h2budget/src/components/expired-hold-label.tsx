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
