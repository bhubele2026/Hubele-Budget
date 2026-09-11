import { addDaysISO } from "./householdTime";

/**
 * Plaid can date a row the bank already holds (a pending authorisation dated by
 * its expected post day, weekend activity posting Monday) up to this many
 * household days after the day the balance was read.
 */
export const PLAID_HELD_AHEAD_DAYS = 5;

export type SnapshotLedgerRow = {
  occurredOn: string;
  /** `transactions.created_at`: when the row reached our ledger. */
  createdAt: Date;
  plaidAccountId: string | null;
};

/**
 * ⭐ IS THIS ROW ALREADY IN THE BANK SNAPSHOT? True when the balance read at
 * `snapAt` already reflects the row, so adding it on top would count it twice.
 * `snapDay` is the household calendar day of `snapAt`.
 *
 *   1. Dated before the snapshot day: held.
 *   2. Dated ON the snapshot day: held, unless it reached the ledger after the
 *      balance was read.
 *   3. A Plaid row dated 1–5 days after the snapshot day: held if it already
 *      existed when the balance was read.
 *   4. Anything dated later, and manual rows dated after the snapshot day: not
 *      held — a typed balance cannot be assumed to include a row typed earlier
 *      with a later date.
 *
 * Instants compare as instants (`created_at` is the database clock at insert,
 * `snapAt` the app clock at the read); the day bounds are household days.
 */
export function isInSnapshot(row: SnapshotLedgerRow, snapAt: Date, snapDay: string): boolean {
  if (row.occurredOn < snapDay) return true;
  const createdBeforeRead = row.createdAt.getTime() <= snapAt.getTime();
  if (row.occurredOn === snapDay) return createdBeforeRead;
  if (row.plaidAccountId && row.occurredOn <= addDaysISO(snapDay, PLAID_HELD_AHEAD_DAYS)) {
    return createdBeforeRead;
  }
  return false;
}
