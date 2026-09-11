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
