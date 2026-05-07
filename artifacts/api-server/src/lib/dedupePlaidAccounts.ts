import { and, eq, inArray } from "drizzle-orm";
import {
  budgetCategoriesTable,
  db,
  debtBalanceHistoryTable,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { SYNTHETIC_ACCOUNT_ID } from "./aprilChaseSeed";
import { dedupeTransactionsForAccount } from "./dedupeTransactions";

export type DedupeReport = {
  groupsScanned: number;
  duplicatesRemoved: number;
  transactionsRepointed: number;
  debtsRepointed: number;
  snapshotRepointed: boolean;
  syntheticDropped: boolean;
  // (#429) Number of `forecast_settings.accountSnapshots` keys that
  // were repointed onto a survivor row during this run.
  accountSnapshotsRepointed: number;
  // (#429) Number of orphaned `forecast_settings.accountSnapshots`
  // keys (no live `plaid_accounts.id` match) that the trailing
  // backfill removed. Some of these may have been salvaged onto a
  // surviving row first via (institutionName, mask) matching — those
  // also bump `accountSnapshotsRepointed`.
  accountSnapshotsPruned: number;
  // (#452) Number of duplicate `transactions` rows collapsed by the
  // post-merge row-level dedupe pass that runs in the same
  // transaction. Optional so callers from before #452 keep type-
  // checking; the implementation always populates it.
  transactionsDeduped?: number;
  // (#452) Number of `forecast_resolutions.matched_txn_id` rows
  // repointed onto a survivor transaction during the row-level
  // dedupe pass.
  transactionResolutionsRepointed?: number;
};

type AcctRow = typeof plaidAccountsTable.$inferSelect;
type AcctSnapshotEntry = {
  balance: string;
  at: string;
  source: "manual" | "plaid";
  name: string | null;
  mask: string | null;
};
type AcctSnapshotMap = Record<string, AcctSnapshotEntry>;

// (#429) Pick the entry with the newer `at` timestamp; falls back to
// `incoming` when timestamps are unparseable or equal so a fresher
// loser entry wins over a stale survivor entry.
function pickFresherSnapshot(
  existing: AcctSnapshotEntry | undefined,
  incoming: AcctSnapshotEntry,
): AcctSnapshotEntry {
  if (!existing) return incoming;
  const ea = Date.parse(existing.at);
  const ia = Date.parse(incoming.at);
  if (Number.isFinite(ea) && Number.isFinite(ia) && ea > ia) return existing;
  return incoming;
}

/**
 * (#410) Merge duplicate `plaid_accounts` rows for a single user.
 *
 * Duplicates are grouped by `(institutionName, mask)` (case-insensitive).
 * For each group with >1 row we pick a survivor (the row currently
 * referenced by `forecast_settings.bankSnapshotAccountId` if any, else
 * the most-recently-created row), repoint `transactions.plaidAccountId`
 * (keyed off Plaid's external `account_id` text), `debts.plaidAccountId`
 * (uuid → row id), and the `forecast_settings.bankSnapshotAccountId`
 * pointer onto the survivor, then delete the loser rows.
 *
 * Also collapses the synthetic Chase ··0000 seed row (#298) when a real
 * Chase row exists for the same user: the snapshot pointer is moved to
 * the real row and the synthetic is removed so it stops appearing in
 * the picker as "Chase ··0000 · snapshot".
 */
export async function dedupePlaidAccountsForUser(
  userId: string,
): Promise<DedupeReport> {
  const report: DedupeReport = {
    groupsScanned: 0,
    duplicatesRemoved: 0,
    transactionsRepointed: 0,
    debtsRepointed: 0,
    snapshotRepointed: false,
    syntheticDropped: false,
    accountSnapshotsRepointed: 0,
    accountSnapshotsPruned: 0,
    transactionsDeduped: 0,
    transactionResolutionsRepointed: 0,
  };

  return await db.transaction(async (tx) => {
    const [settings] = await tx
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, userId));
    const snapshotAccountId = settings?.bankSnapshotAccountId ?? null;
    // (#429) Track per-account snapshot map mutations across all
    // merges in this transaction so we can persist a single update
    // at the end. Starts as a shallow copy of the persisted map.
    let acctSnapshots: AcctSnapshotMap = {
      ...((settings?.accountSnapshots as AcctSnapshotMap | null) ?? {}),
    };
    let acctSnapshotsDirty = false;

    const rows = await tx
      .select({
        acct: plaidAccountsTable,
        institutionName: plaidItemsTable.institutionName,
      })
      .from(plaidAccountsTable)
      .leftJoin(
        plaidItemsTable,
        eq(plaidAccountsTable.itemId, plaidItemsTable.id),
      )
      .where(eq(plaidAccountsTable.userId, userId));

    type Bundle = { acct: AcctRow; institutionName: string | null };
    const all: Bundle[] = rows.map((r) => ({
      acct: r.acct,
      institutionName: r.institutionName,
    }));

    // Group by (institution, mask). Skip rows missing a mask: we can't
    // tell those apart safely, leave them as-is.
    const groups = new Map<string, Bundle[]>();
    for (const b of all) {
      if (!b.acct.mask) continue;
      const key = `${(b.institutionName ?? "").toLowerCase()}|${b.acct.mask.toLowerCase()}`;
      const arr = groups.get(key);
      if (arr) arr.push(b);
      else groups.set(key, [b]);
    }

    const repointSnapshotTo = async (newId: string): Promise<void> => {
      await tx
        .update(forecastSettingsTable)
        .set({ bankSnapshotAccountId: newId, updatedAt: new Date() })
        .where(eq(forecastSettingsTable.userId, userId));
    };

    const mergeLoserIntoSurvivor = async (
      survivor: Bundle,
      loser: Bundle,
    ): Promise<void> => {
      // transactions.plaidAccountId is the external Plaid account_id text.
      if (loser.acct.accountId !== survivor.acct.accountId) {
        const updatedTxns = await tx
          .update(transactionsTable)
          .set({ plaidAccountId: survivor.acct.accountId })
          .where(
            and(
              eq(transactionsTable.userId, userId),
              eq(transactionsTable.plaidAccountId, loser.acct.accountId),
            ),
          )
          .returning({ id: transactionsTable.id });
        report.transactionsRepointed += updatedTxns.length;
      }
      // debts.plaidAccountId is the row uuid. The DB enforces
      // `debts_plaid_account_unique`, so if the survivor already has
      // its own debt row we cannot blindly repoint the loser's debt
      // onto the survivor's account id (the unique constraint would
      // fire and the whole transaction would roll back, leaving the
      // user's duplicate state unhealed). When that happens, repoint
      // the loser-debt's manual transactions onto the survivor-debt
      // and delete the loser-debt row instead. (#416)
      const [survivorDebt] = await tx
        .select({ id: debtsTable.id })
        .from(debtsTable)
        .where(
          and(
            eq(debtsTable.userId, userId),
            eq(debtsTable.plaidAccountId, survivor.acct.id),
          ),
        );
      const loserDebts = await tx
        .select({ id: debtsTable.id })
        .from(debtsTable)
        .where(
          and(
            eq(debtsTable.userId, userId),
            eq(debtsTable.plaidAccountId, loser.acct.id),
          ),
        );
      if (survivorDebt && loserDebts.length > 0) {
        const loserIds = loserDebts.map((d) => d.id);
        // Repoint manual transactions onto the survivor-debt.
        await tx
          .update(transactionsTable)
          .set({ debtId: survivorDebt.id })
          .where(
            and(
              eq(transactionsTable.userId, userId),
              inArray(transactionsTable.debtId, loserIds),
            ),
          );
        // Repoint debt_balance_history rows onto the survivor-debt
        // BEFORE deleting loser-debt (FK is `on delete cascade`, so
        // a naive delete would drop the user's balance history).
        // The (userId, debtId, day) unique constraint means we must
        // skip any (debtId, day) that already exists on the
        // survivor — keep the survivor's row in that case and drop
        // the loser's row when it cascades. (#416)
        const survivorHistoryDays = await tx
          .select({ recordedOn: debtBalanceHistoryTable.recordedOn })
          .from(debtBalanceHistoryTable)
          .where(
            and(
              eq(debtBalanceHistoryTable.userId, userId),
              eq(debtBalanceHistoryTable.debtId, survivorDebt.id),
            ),
          );
        const survivorDays = new Set(
          survivorHistoryDays.map((r) => String(r.recordedOn)),
        );
        const loserHistory = await tx
          .select({
            id: debtBalanceHistoryTable.id,
            recordedOn: debtBalanceHistoryTable.recordedOn,
          })
          .from(debtBalanceHistoryTable)
          .where(
            and(
              eq(debtBalanceHistoryTable.userId, userId),
              inArray(debtBalanceHistoryTable.debtId, loserIds),
            ),
          );
        const repointableIds = loserHistory
          .filter((r) => !survivorDays.has(String(r.recordedOn)))
          .map((r) => r.id);
        if (repointableIds.length > 0) {
          await tx
            .update(debtBalanceHistoryTable)
            .set({ debtId: survivorDebt.id })
            .where(
              and(
                eq(debtBalanceHistoryTable.userId, userId),
                inArray(debtBalanceHistoryTable.id, repointableIds),
              ),
            );
        }
        // Repoint debt-linked budget_categories onto the
        // survivor-debt. The (userId, debtId) unique constraint
        // means at most one category may be repointed; if the
        // survivor already has one, the loser's category cascades
        // away when its debt is deleted. (#416)
        const [survivorCategory] = await tx
          .select({ id: budgetCategoriesTable.id })
          .from(budgetCategoriesTable)
          .where(
            and(
              eq(budgetCategoriesTable.userId, userId),
              eq(budgetCategoriesTable.debtId, survivorDebt.id),
            ),
          );
        if (!survivorCategory) {
          const loserCategories = await tx
            .select({ id: budgetCategoriesTable.id })
            .from(budgetCategoriesTable)
            .where(
              and(
                eq(budgetCategoriesTable.userId, userId),
                inArray(budgetCategoriesTable.debtId, loserIds),
              ),
            );
          if (loserCategories.length > 0) {
            // Promote the first loser-category to the survivor-debt;
            // any remaining loser-categories cascade with the debt
            // delete (and would have collided on the unique anyway).
            await tx
              .update(budgetCategoriesTable)
              .set({ debtId: survivorDebt.id })
              .where(eq(budgetCategoriesTable.id, loserCategories[0]!.id));
          }
        }
        await tx
          .delete(debtsTable)
          .where(
            and(
              eq(debtsTable.userId, userId),
              inArray(debtsTable.id, loserIds),
            ),
          );
        report.debtsRepointed += loserDebts.length;
      } else if (loserDebts.length > 0) {
        const updatedDebts = await tx
          .update(debtsTable)
          .set({ plaidAccountId: survivor.acct.id, updatedAt: new Date() })
          .where(
            and(
              eq(debtsTable.userId, userId),
              eq(debtsTable.plaidAccountId, loser.acct.id),
            ),
          )
          .returning({ id: debtsTable.id });
        report.debtsRepointed += updatedDebts.length;
      }
      // Snapshot pointer (per-user, uuid).
      if (settings?.bankSnapshotAccountId === loser.acct.id) {
        await repointSnapshotTo(survivor.acct.id);
        report.snapshotRepointed = true;
      }
      // (#429) Per-account snapshot JSON map: keyed by `plaid_accounts.id`.
      // Move `acctSnapshots[loserId]` onto `acctSnapshots[survivorId]`
      // (preferring the entry with the newer `at` timestamp when the
      // survivor already owns one), then drop the loser key. Without
      // this, a survivor whose id has no entry in the map renders the
      // "Unavailable" placeholder on the Chase page even though
      // Money in / Money out are correct.
      const loserSnap = acctSnapshots[loser.acct.id];
      if (loserSnap) {
        const winning = pickFresherSnapshot(
          acctSnapshots[survivor.acct.id],
          loserSnap,
        );
        acctSnapshots[survivor.acct.id] = winning;
        delete acctSnapshots[loser.acct.id];
        acctSnapshotsDirty = true;
        report.accountSnapshotsRepointed += 1;
      }
      await tx
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.id, loser.acct.id));
      // (#452) After the loser's transactions have been repointed onto
      // the survivor's external account_id, the survivor may now own
      // two `transactions` rows (one from each former Plaid item) for
      // the same real posting. Run the row-level dedupe in the same
      // transaction so the cleanup is atomic with the account merge —
      // never leaves the user briefly looking at a doubled ledger.
      const txnReport = await dedupeTransactionsForAccount(
        userId,
        survivor.acct.accountId,
        tx,
      );
      report.transactionsDeduped =
        (report.transactionsDeduped ?? 0) + txnReport.duplicatesRemoved;
      report.transactionResolutionsRepointed =
        (report.transactionResolutionsRepointed ?? 0) +
        txnReport.resolutionsRepointed;
      report.duplicatesRemoved += 1;
    };

    for (const arr of groups.values()) {
      if (arr.length <= 1) continue;
      report.groupsScanned += 1;
      arr.sort((a, b) => {
        const aSnap = a.acct.id === snapshotAccountId ? 0 : 1;
        const bSnap = b.acct.id === snapshotAccountId ? 0 : 1;
        if (aSnap !== bSnap) return aSnap - bSnap;
        const at = a.acct.createdAt?.getTime() ?? 0;
        const bt = b.acct.createdAt?.getTime() ?? 0;
        return bt - at;
      });
      const survivor = arr[0];
      for (let i = 1; i < arr.length; i++) {
        await mergeLoserIntoSurvivor(survivor, arr[i]);
      }
    }

    // (#410) Collapse the synthetic Chase ··0000 seed row when a real
    // Chase checking row exists. We treat any non-synthetic checking
    // row whose institution is Chase as the survivor; the synthetic's
    // snapshot pointer (and any test-data transactions / debts) move
    // onto it and the synthetic itself is deleted.
    const synthetic = all.find(
      (b) => b.acct.accountId === SYNTHETIC_ACCOUNT_ID,
    );
    if (synthetic) {
      const realChase = all.find(
        (b) =>
          b.acct.id !== synthetic.acct.id &&
          (b.institutionName ?? "").toLowerCase() === "chase" &&
          (b.acct.subtype === "checking" ||
            b.acct.type === "depository" ||
            b.acct.subtype === "savings"),
      );
      // Re-fetch survivor so we don't try to repoint onto a row that
      // was already deleted by the (institution, mask) pass above.
      if (realChase) {
        const [stillThere] = await tx
          .select({ id: plaidAccountsTable.id })
          .from(plaidAccountsTable)
          .where(eq(plaidAccountsTable.id, realChase.acct.id));
        const [synthStillThere] = await tx
          .select({ id: plaidAccountsTable.id })
          .from(plaidAccountsTable)
          .where(eq(plaidAccountsTable.id, synthetic.acct.id));
        if (stillThere && synthStillThere) {
          await mergeLoserIntoSurvivor(realChase, synthetic);
          report.syntheticDropped = true;
        }
      }
    }

    // (#429) Trailing backfill: prune `accountSnapshots` keys that no
    // longer correspond to a live `plaid_accounts.id` for this user.
    // Before dropping an orphan key we try to salvage it onto the
    // current survivor for the same (institutionName, mask) — this
    // repairs already-broken users whose loser id was never moved
    // because the dedupe that removed it predated this fix. Idempotent:
    // a clean user is a no-op.
    const liveRows = await tx
      .select({
        id: plaidAccountsTable.id,
        mask: plaidAccountsTable.mask,
        institutionName: plaidItemsTable.institutionName,
      })
      .from(plaidAccountsTable)
      .leftJoin(
        plaidItemsTable,
        eq(plaidAccountsTable.itemId, plaidItemsTable.id),
      )
      .where(eq(plaidAccountsTable.userId, userId));
    const liveIds = new Set(liveRows.map((r) => r.id));
    for (const orphanId of Object.keys(acctSnapshots)) {
      if (liveIds.has(orphanId)) continue;
      const entry = acctSnapshots[orphanId]!;
      // Try to find a surviving row with the same mask. We don't have
      // institutionName on the entry itself, so prefer rows whose
      // institutionName loosely matches the entry's `name` (e.g. an
      // entry name of "Chase Total Checking" matches a row whose
      // institutionName is "Chase"); when no name is available, mask
      // alone is the matcher.
      const entryMask = entry.mask?.toLowerCase() ?? null;
      const entryName = (entry.name ?? "").toLowerCase();
      let salvageId: string | null = null;
      if (entryMask) {
        const candidates = liveRows.filter(
          (r) => (r.mask ?? "").toLowerCase() === entryMask,
        );
        const byInstitution = candidates.find((r) => {
          const inst = (r.institutionName ?? "").toLowerCase();
          return inst.length > 0 && entryName.includes(inst);
        });
        salvageId = (byInstitution ?? candidates[0])?.id ?? null;
      }
      if (salvageId) {
        const winning = pickFresherSnapshot(acctSnapshots[salvageId], entry);
        // Only count as a repoint when the salvage actually changed the
        // survivor's entry (avoids inflating the count for an orphan
        // whose survivor already has a fresher snapshot).
        if (acctSnapshots[salvageId] !== winning) {
          acctSnapshots[salvageId] = winning;
          report.accountSnapshotsRepointed += 1;
        }
      }
      delete acctSnapshots[orphanId];
      acctSnapshotsDirty = true;
      report.accountSnapshotsPruned += 1;
    }

    if (acctSnapshotsDirty) {
      await tx
        .update(forecastSettingsTable)
        .set({ accountSnapshots: acctSnapshots, updatedAt: new Date() })
        .where(eq(forecastSettingsTable.userId, userId));
    }

    return report;
  });
}
