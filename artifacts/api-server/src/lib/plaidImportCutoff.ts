import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";

type PlaidAccountRow = typeof plaidAccountsTable.$inferSelect;

/**
 * (#361) Auto-detect the import cutoff for a freshly linked Plaid
 * account. Returns the latest `occurredOn` (YYYY-MM-DD) of an existing
 * manual / imported transaction that plausibly covers the same data
 * Plaid is about to back-fill, so the very first /transactions/sync can
 * skip rows on/before that date instead of duplicating the user's
 * existing history. Null when no overlap is detected (no gate — same
 * behavior as before this feature).
 *
 * Scoping mirrors the task spec:
 *   - Credit / loan accounts: rows whose `debtId` points to a debt
 *     already linked to this Plaid account (rare at link time but
 *     possible on re-link), restricted to `source` in
 *     ("manual", "amex"). For Amex specifically, fall back to *any*
 *     `source = 'amex'` row when no debt is linked yet (the user
 *     hand-imported their statement before linking).
 *   - Depository accounts: rows tied to the user's checking-anchor
 *     selection (`forecast_settings.bank_snapshot_account_id`),
 *     restricted to `source` in ("manual", "bank") with `debtId IS
 *     NULL`.
 */
/**
 * (#403) Clamp an auto-detected cutoff so it can never reach into the
 * current calendar month. Without this, a stray manual / imported row
 * dated in the current month (e.g. a placeholder budget entry, or an
 * Amex statement that overlaps the link day) drives the cutoff
 * forward and the very first /transactions/sync silently drops every
 * Plaid row up to that date — which is exactly the "linked Chase but
 * May activity is missing" symptom the user reported. We always want
 * the user's *current month* of bank activity to land, even when their
 * manual history extends into it.
 *
 * `today` is injectable so tests can pin a deterministic clock.
 */
export function clampCutoffBeforeCurrentMonth(
  cutoff: string | null,
  today: Date = new Date(),
): string | null {
  if (!cutoff) return null;
  // Compute YYYY-MM-{lastDayOfPriorMonth} in UTC to match the YYYY-MM-DD
  // strings stored in transactions.occurred_on.
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-based; first-of-current-month
  // `Date.UTC(y, m, 0)` rolls back to the last day of the prior month.
  const priorMonthEnd = new Date(Date.UTC(y, m, 0));
  const yyyy = priorMonthEnd.getUTCFullYear();
  const mm = String(priorMonthEnd.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(priorMonthEnd.getUTCDate()).padStart(2, "0");
  const ceiling = `${yyyy}-${mm}-${dd}`;
  return cutoff > ceiling ? ceiling : cutoff;
}

export async function computeImportCutoffForAccount(
  userId: string,
  account: PlaidAccountRow,
  institutionSlug: string | null,
): Promise<string | null> {
  const isCreditLike =
    account.type === "credit" ||
    account.type === "loan" ||
    institutionSlug === "amex";
  if (isCreditLike) {
    const linkedDebts = await db
      .select({ id: debtsTable.id })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, userId),
          eq(debtsTable.plaidAccountId, account.id),
        ),
      );
    const debtIds = linkedDebts.map((d) => d.id);
    if (debtIds.length > 0) {
      const [r] = await db
        .select({
          maxDate: sql<string | null>`max(${transactionsTable.occurredOn})::text`,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.userId, userId),
            inArray(transactionsTable.debtId, debtIds),
            inArray(transactionsTable.source, ["manual", "amex"]),
          ),
        );
      if (r?.maxDate) return clampCutoffBeforeCurrentMonth(r.maxDate);
    }
    if (institutionSlug === "amex") {
      const [r] = await db
        .select({
          maxDate: sql<string | null>`max(${transactionsTable.occurredOn})::text`,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.userId, userId),
            eq(transactionsTable.source, "amex"),
          ),
        );
      if (r?.maxDate) return clampCutoffBeforeCurrentMonth(r.maxDate);
    }
    return null;
  }
  if (account.type === "depository") {
    const [fs] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, userId));
    if (fs?.bankSnapshotAccountId === account.id) {
      const [r] = await db
        .select({
          maxDate: sql<string | null>`max(${transactionsTable.occurredOn})::text`,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.userId, userId),
            inArray(transactionsTable.source, ["manual", "bank"]),
            sql`${transactionsTable.debtId} is null`,
          ),
        );
      if (r?.maxDate) return clampCutoffBeforeCurrentMonth(r.maxDate);
    }
  }
  return null;
}

/**
 * Persist the computed cutoff for every account belonging to a freshly
 * linked Plaid item, only when no value is already on record. Safe to
 * call multiple times — once `firstSyncCompletedAt` is stamped the
 * cutoff is locked anyway.
 */
export async function autoDetectCutoffsForItem(
  userId: string,
  itemRowId: string,
  institutionSlug: string | null,
): Promise<void> {
  const accounts = await db
    .select()
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.itemId, itemRowId),
        eq(plaidAccountsTable.userId, userId),
      ),
    );
  for (const acct of accounts) {
    // (#403) Once first sync stamps `firstSyncCompletedAt` the gate is
    // permanently off — never recompute. But while it's still null
    // (e.g. a re-link of an item whose initial sync never finished, or
    // whose stale cutoff sits in the future and is silently blocking
    // recent rows) we DO recompute every time the user comes back
    // through Plaid Link. That is what makes a re-link reliably
    // refresh a stale cutoff without forcing the user to clear it by
    // hand.
    if (acct.firstSyncCompletedAt) continue;
    const cutoff = await computeImportCutoffForAccount(
      userId,
      acct,
      institutionSlug,
    );
    // Always write the freshly computed value (even when null) so a
    // previously over-shooting cutoff is cleared on re-link.
    await db
      .update(plaidAccountsTable)
      .set({ importCutoffDate: cutoff })
      .where(eq(plaidAccountsTable.id, acct.id));
  }
}
