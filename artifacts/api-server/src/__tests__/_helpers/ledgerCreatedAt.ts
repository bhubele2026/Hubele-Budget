import { householdDateOf } from "@workspace/avalanche-core/householdTime";

/**
 * ⭐ WHEN A LEDGER FIXTURE ROW WAS "CREATED": 00:00 on its own household day
 * (America/Chicago), DST-correct.
 *
 * PR4b reads `transactions.created_at` to decide whether the bank snapshot
 * already holds a row. Postgres fills `created_at` with `now()` on insert,
 * which in a test is the real wall clock, not the fixture's pinned "now". A
 * fixture that leaves it out therefore changes meaning depending on WHEN the
 * suite runs; a fixture snapshot dated in October 2026 made every row inserted
 * in September look older than it.
 *
 * The start of the row's own day keeps each fixture meaning what it meant
 * before `created_at` mattered, without knowing its snapshot:
 *   - a row dated ON the snapshot day was created at or before the snapshot, so
 *     the balance holds it;
 *   - a row dated AFTER the snapshot day was created after it, so it counts.
 * A test that wants a row to have arrived at a specific moment sets
 * `createdAt` itself.
 */
export function createdAtStartOfHouseholdDay(occurredOn: string): Date {
  // Chicago midnight is 05:00Z (CDT) or 06:00Z (CST). It is the candidate whose
  // household date is `occurredOn` while one minute earlier is the day before.
  for (const utcHour of ["05", "06"]) {
    const t = new Date(`${occurredOn}T${utcHour}:00:00.000Z`);
    const aMinuteBefore = new Date(t.getTime() - 60_000);
    if (householdDateOf(t) === occurredOn && householdDateOf(aMinuteBefore) !== occurredOn) {
      return t;
    }
  }
  throw new Error(`No household midnight found for ${occurredOn}`);
}
