import { asc, inArray } from "drizzle-orm";
import { db, debtBalanceHistoryTable } from "@workspace/db";
import { householdDayOf } from "./householdClock";

/**
 * ⭐ WHEN WAS THIS DEBT'S BALANCE SET? (PR-E review H3)
 *
 * `debts.last_balance_update` is not enough on its own. Before PR-E a hand edit
 * (PATCH /debts/:id) never stamped it: a legacy debt kept NULL (so the date fell
 * back to `created_at`, months early) or an old bank date. Dated early, the Amex
 * page rolls forward from that day and counts charges the typed balance already
 * holds — twice. Every such edit did write a `debt_balance_history` row, so the
 * day the balance last CHANGED there is evidence of when it was set. Nothing is
 * backfilled; the date is read, never written.
 *
 * The rule: the later of `last_balance_update ?? created_at` and the household
 * day the balance last changed in history (see `lastBalanceChangeDayByDebt` for
 * what counts as a change; as an instant, noon UTC on that day,
 * the convention POST /amex/anchor uses for a bare day). A stamp on or after
 * that day wins; history can only move the date later.
 */

/**
 * The household day each debt's balance last changed in `debt_balance_history`.
 * The SAME definition as the `last_change` CTE in
 * artifacts/api-server/scripts/sql/preview-debt-balance-provenance.sql:
 *
 *   - a later row is a change when its balance differs from the row before it;
 *   - (PR-E review, decided) a debt's FIRST row is a change only when its
 *     household day equals the household day of `debts.updated_at`.
 *
 * Why the first-row condition: GET /debts writes a row for every active debt on
 * every view (so do a Plaid refresh, an archive and "Use bank balance"), so a
 * never-edited debt's first row is usually just the day someone first looked.
 * Counting it dated a Jun 1 balance at a Jun 15 view and dropped the charges in
 * between. A pre-merge hand edit that wrote the first row also moved
 * `updated_at` that day, so that case still counts. (Comparing the first row to
 * `original_balance` would not work: a legacy raise bumps that too.)
 */
export async function lastBalanceChangeDayByDebt(
  debts: Array<{ id: string; updatedAt: Date }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (debts.length === 0) return out;
  const debtIds = debts.map((d) => d.id);
  const updatedDay = new Map(debts.map((d) => [d.id, householdDayOf(d.updatedAt)]));
  const rows = await db
    .select({
      debtId: debtBalanceHistoryTable.debtId,
      recordedOn: debtBalanceHistoryTable.recordedOn,
      balance: debtBalanceHistoryTable.balance,
    })
    .from(debtBalanceHistoryTable)
    .where(inArray(debtBalanceHistoryTable.debtId, debtIds))
    .orderBy(asc(debtBalanceHistoryTable.debtId), asc(debtBalanceHistoryTable.recordedOn));
  let prevDebt: string | null = null;
  let prevCents: number | null = null;
  for (const r of rows) {
    const cents = Math.round(Number(r.balance) * 100);
    if (r.debtId !== prevDebt) {
      prevDebt = r.debtId;
      prevCents = null;
    }
    const isChange =
      prevCents === null
        ? r.recordedOn === updatedDay.get(r.debtId)
        : cents !== prevCents;
    if (isChange) out.set(r.debtId, r.recordedOn);
    prevCents = cents;
  }
  return out;
}

/** A bare household day as an instant that stays on that day all year. */
export function householdDayInstant(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}

/** The instant a debt's balance is dated by (see the file header). */
export function debtBalanceAsOf(
  d: { lastBalanceUpdate: Date | null; createdAt: Date },
  lastChangeDay: string | null | undefined,
): Date {
  const stamped = d.lastBalanceUpdate ?? d.createdAt;
  if (!lastChangeDay) return stamped;
  return householdDayOf(stamped) < lastChangeDay
    ? householdDayInstant(lastChangeDay)
    : stamped;
}
