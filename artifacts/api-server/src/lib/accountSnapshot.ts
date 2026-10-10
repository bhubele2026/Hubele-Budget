import type { forecastSettingsTable } from "@workspace/db";

type SettingsRow = Pick<
  typeof forecastSettingsTable.$inferSelect,
  "bankSnapshotBalance" | "bankSnapshotAt" | "bankSnapshotSource" | "bankSnapshotAccountId" | "accountSnapshots"
>;

export interface AccountSnapshot {
  balance: string;
  at: string;
  source: "manual" | "plaid";
}

/**
 * (WP3) The last balance READING H2 holds for one linked account — a snapshot,
 * never rolled forward. `GET /plaid/items` sends it on every account so a
 * savings account (or a second checking account) can say "Snapshot $X · as of
 * <date> · not rolled forward" instead of "not tracked", and the accounts page
 * no longer needs the whole forecast to find one number.
 *
 * Resolution, the Chase page's own (`h2budget/src/lib/effectiveSnapshot.ts`,
 * steps 1–2):
 *   1. The account the household's bank snapshot points at reads the
 *      snapshot columns (`bank_snapshot_*`). A manual balance entry writes only
 *      those (`POST /forecast/bank-snapshot`), so they can be newer than the
 *      account's map entry.
 *   2. Any other account reads its `forecast_settings.account_snapshots` entry,
 *      keyed by the internal `plaid_accounts.id` (written by every Plaid
 *      balance read, `#296`).
 *   3. Otherwise null: no reading yet. Never a zero.
 * The post-dedupe mask fallbacks (steps 3a/3b there) are deliberately not
 * copied: a balance is never borrowed from another account by its mask.
 */
export function accountSnapshotOf(settings: SettingsRow | null | undefined, accountRowId: string): AccountSnapshot | null {
  if (!settings) return null;
  if (settings.bankSnapshotAccountId === accountRowId) {
    if (settings.bankSnapshotBalance != null && settings.bankSnapshotAt) {
      return {
        balance: settings.bankSnapshotBalance,
        at: settings.bankSnapshotAt.toISOString(),
        source: settings.bankSnapshotSource === "plaid" ? "plaid" : "manual",
      };
    }
  }
  const e = settings.accountSnapshots?.[accountRowId];
  if (!e || e.balance == null || e.balance === "" || !e.at) return null;
  return { balance: String(e.balance), at: e.at, source: e.source === "plaid" ? "plaid" : "manual" };
}
