/** A ledger row the ±2-day re-mint check found: same account and amount, a different Plaid id. */
export type RemintCandidate = {
  id: string;
  oldPtid: string | null;
  occurredOn: string;
};

const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/**
 * ⭐ WHICH EXISTING ROW, IF ANY, IS THIS INCOMING PLAID ROW A RE-MINT OF? (PR4d)
 *
 * Same account, same amount and a date within two days is not proof: two real
 * charges look exactly like that (parking, coffee, a $100 ATM withdrawal). When
 * the check adopted such a row it moved a real charge onto another charge's id
 * and date, so one of the two vanished from cash — and, keeping its old
 * `created_at`, it could be held as "already in the bank snapshot".
 *
 * A candidate is adopted only when `isGone` says its old id no longer exists at
 * Plaid; the caller supplies that evidence for its path. Among those, the
 * nearest date wins (then id, for a stable pick). Null when none qualifies —
 * the incoming row is a separate transaction and is inserted.
 */
export function pickRemintCandidate<T extends RemintCandidate>(
  candidates: readonly T[],
  incomingDate: string,
  isGone: (candidate: T & { oldPtid: string }) => boolean,
): T | null {
  const target = dayNumber(incomingDate);
  const gone = candidates.filter(
    (c): c is T & { oldPtid: string } => c.oldPtid != null && isGone(c as T & { oldPtid: string }),
  );
  gone.sort(
    (a, b) =>
      Math.abs(dayNumber(a.occurredOn) - target) - Math.abs(dayNumber(b.occurredOn) - target) ||
      a.id.localeCompare(b.id),
  );
  return gone[0] ?? null;
}

/** One row of the incoming Plaid batch, as the re-mint tie-break sees it. */
export type RemintBatchEntry = {
  id: string;
  accountId: string;
  date: string;
  signedAmount: string;
  /** Names a pending row (`pending_transaction_id`): the pending→posted re-key claims that row instead. */
  namesPendingRow: boolean;
  /** A ledger row already held this id when the batch started: it is an update, never a claimant. */
  onFileAtStart: boolean;
  /** The first occurrence of this id in the batch. A later copy only updates the row the first one wrote. */
  firstCopy: boolean;
};

/**
 * (PR4d review) Should the row at `index` leave a gone candidate to a later row?
 *
 * The batch is handled in list order. Without this, the first same-amount row
 * takes a gone row even when a later one is its re-mint: a separate charge dated
 * today took yesterday's re-minted row (keeping its pre-read `created_at`, so the
 * snapshot rule held it) and the re-mint was inserted as a second held row — cash
 * overstated. True when a later row on the same account with the same amount —
 * the first copy of its id, not on file at the start, not naming a pending row —
 * is nearer the candidate's date.
 *
 * (PR4d-2) An exact tie goes to the earlier-dated row. The snapshot already holds
 * rows dated before its day, so without institution times an ambiguous tie errs
 * toward understating cash (or nets to the true figure). ⚠️ Not always with times:
 * a re-mint carrying its old row's pre-read authorisation time is held by the
 * snapshot rule, so if the separate charge wins the tie nothing offsets it and
 * cash is overstated by one charge (PR4d-2 review, case T1). Rare: it needs a
 * bank that sends times and a tie in one cursor batch.
 */
export function laterRowIsNearer(
  batch: readonly RemintBatchEntry[],
  index: number,
  candidateDate: string,
): boolean {
  const me = batch[index];
  if (!me) return false;
  const target = dayNumber(candidateDate);
  const myGap = Math.abs(dayNumber(me.date) - target);
  for (let j = index + 1; j < batch.length; j++) {
    const other = batch[j]!;
    if (other.id === me.id || other.accountId !== me.accountId || other.signedAmount !== me.signedAmount) continue;
    if (other.namesPendingRow || other.onFileAtStart || !other.firstCopy) continue;
    const otherGap = Math.abs(dayNumber(other.date) - target);
    if (otherGap < myGap || (otherGap === myGap && other.date < me.date)) return true;
  }
  return false;
}
