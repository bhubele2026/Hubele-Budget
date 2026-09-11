import { addDaysISO } from "./householdTime";

/**
 * A charge Plaid dates up to this many household days after the day the
 * balance was read can already be inside that balance: typically a posted row
 * re-keyed from its pending row, which keeps the pending row's `created_at`.
 */
export const PLAID_HELD_AHEAD_DAYS = 5;

export type SnapshotLedgerRow = {
  occurredOn: string;
  /** Signed: negative is money out (a charge), positive money in. */
  amount: number;
  /** `transactions.created_at`: when the row reached our ledger (the database clock). */
  createdAt: Date;
  /**
   * `transactions.occurred_at`: the institution's own time for the transaction
   * (Plaid `datetime`, else `authorized_datetime`). Absent for most Chase rows.
   */
  occurredAt?: Date | null;
  plaidAccountId: string | null;
};

/**
 * A usable institution time, or null. Whole-hour values (hh:00:00.000 UTC) are
 * treated as placeholders: Plaid warns institutions send default times, and a
 * midnight in the institution's own offset lands on a whole UTC hour.
 */
function realTimeMs(t: Date | null | undefined): number | null {
  if (!t) return null;
  const ms = t.getTime();
  if (Number.isNaN(ms)) return null;
  if (t.getUTCMinutes() === 0 && t.getUTCSeconds() === 0 && t.getUTCMilliseconds() === 0) return null;
  return ms;
}

/**
 * ⭐ IS THIS ROW ALREADY IN THE BANK SNAPSHOT? True when the balance read at
 * `snapAt` already reflects the row, so adding it on top would count it twice.
 * `snapDay` is the household calendar day of `snapAt`.
 *
 *   1. Dated before the snapshot day: held.
 *   2. Dated ON the snapshot day: held — unless the institution's own time
 *      is after the read AND the ledger did not have the row at the read.
 *   3. A Plaid CHARGE dated 1–5 days after the snapshot day: held when the
 *      ledger already had it at the read, or its own time is before the read.
 *   4. Anything else counts: deposits dated after the snapshot day, charges
 *      dated later, and manual rows dated after the snapshot day.
 *
 * ⚠️ WHY `created_at` DOES NOT DECIDE THE SNAPSHOT DAY. `created_at` is when our
 * feed delivered the row, not when it happened, and Chase rows reach Plaid
 * hours to days late (plaidSync #720: a 24–72h background poll). Counting every
 * snapshot-day row that arrived after the read would count, after nearly every
 * Sync, that day's purchases a second time — the balance already held them. A
 * snapshot-day row therefore needs positive evidence to count: a real
 * transaction time after the read, on a row the ledger did not have at the
 * read. What that leaves: a purchase after the read with no transaction time
 * waits for the next Sync, as before PR4b.
 *
 * ⚠️ WHY CHARGES ONLY AHEAD OF THE DAY. The anchor is `available`, which holds
 * pending charges but not pending deposits; a pending paycheck that posts the
 * next day is not inside the balance and must count.
 *
 * `created_at` is the database clock and `snapAt` the app clock. Rule 3 compares
 * them across the days between a pending row and its posting; in rule 2 the
 * comparison can only veto counting, never count a row on its own.
 */
export function isInSnapshot(row: SnapshotLedgerRow, snapAt: Date, snapDay: string): boolean {
  if (row.occurredOn < snapDay) return true;
  const read = snapAt.getTime();
  const happenedAt = realTimeMs(row.occurredAt);
  if (row.occurredOn === snapDay) {
    // Counts only on both kinds of evidence. `occurred_at` can be a POSTING
    // time: a pending row re-keyed onto its posted row keeps the pending row's
    // `created_at` but takes the posting time, and the authorisation was
    // already inside `available` when the balance was read.
    const newAfterRead = happenedAt !== null && happenedAt > read && row.createdAt.getTime() > read;
    return !newAfterRead;
  }
  if (
    row.plaidAccountId &&
    row.amount < 0 &&
    row.occurredOn <= addDaysISO(snapDay, PLAID_HELD_AHEAD_DAYS)
  ) {
    return row.createdAt.getTime() <= read || (happenedAt !== null && happenedAt <= read);
  }
  return false;
}
