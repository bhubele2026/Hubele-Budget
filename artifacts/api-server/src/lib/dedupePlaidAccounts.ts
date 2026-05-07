import { and, eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { SYNTHETIC_ACCOUNT_ID } from "./aprilChaseSeed";

export type DedupeReport = {
  groupsScanned: number;
  duplicatesRemoved: number;
  transactionsRepointed: number;
  debtsRepointed: number;
  snapshotRepointed: boolean;
  syntheticDropped: boolean;
};

type AcctRow = typeof plaidAccountsTable.$inferSelect;

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
  };

  return await db.transaction(async (tx) => {
    const [settings] = await tx
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, userId));
    const snapshotAccountId = settings?.bankSnapshotAccountId ?? null;

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
      // debts.plaidAccountId is the row uuid.
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
      // Snapshot pointer (per-user, uuid).
      if (settings?.bankSnapshotAccountId === loser.acct.id) {
        await repointSnapshotTo(survivor.acct.id);
        report.snapshotRepointed = true;
      }
      await tx
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.id, loser.acct.id));
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

    return report;
  });
}
