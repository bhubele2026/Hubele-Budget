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
  /**
   * `transactions.occurred_at`: the institution's own time for the transaction
   * (Plaid `datetime`, else `authorized_datetime`; midnight placeholders are
   * stored as null). Absent for most rows.
   */
  occurredAt?: Date | null;
  plaidAccountId: string | null;
};

/**
 * ⭐ IS THIS ROW ALREADY IN THE BANK SNAPSHOT? True when the balance read at
 * `snapAt` already reflects the row, so adding it on top would count it twice.
 * `snapDay` is the household calendar day of `snapAt`.
 *
 *   1. Dated before the snapshot day: held.
 *   2. Dated ON the snapshot day: held when it is known to have existed by the
 *      read — it happened (`occurredAt`) or reached the ledger (`created_at`) at
 *      or before `snapAt`.
 *   3. A Plaid row dated 1–5 days after the snapshot day: held on the same
 *      evidence (a pending authorisation dated by its expected post day).
 *   4. Anything dated later, and manual rows dated after the snapshot day: not
 *      held — a typed balance cannot be assumed to include a row typed earlier
 *      with a later date.
 *
 * ⚠️ WHY TWO CLOCKS. `created_at` alone mistakes feed latency for a late
 * purchase: Chase rows can reach Plaid hours or days after they happen, so a
 * morning charge delivered after an evening read would look new and be counted
 * on top of a balance that already held it. When the institution supplied a
 * real transaction time, a time at or before the read proves the bank had it.
 * A time after the read proves nothing on its own (a charge authorised before
 * the read can carry a later posting time), so it falls back to `created_at`.
 *
 * Instants compare as instants (`created_at` is the database clock at insert,
 * `occurredAt` the institution's, `snapAt` the app clock at the read); the day
 * bounds are household days.
 */
export function isInSnapshot(row: SnapshotLedgerRow, snapAt: Date, snapDay: string): boolean {
  if (row.occurredOn < snapDay) return true;
  const read = snapAt.getTime();
  const existedByRead =
    (row.occurredAt != null && row.occurredAt.getTime() <= read) ||
    row.createdAt.getTime() <= read;
  if (row.occurredOn === snapDay) return existedByRead;
  if (row.plaidAccountId && row.occurredOn <= addDaysISO(snapDay, PLAID_HELD_AHEAD_DAYS)) {
    return existedByRead;
  }
  return false;
}
