import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  db,
  forecastResolutionsTable,
  transactionsTable,
} from "@workspace/db";

export type DedupeTxnReport = {
  groupsScanned: number;
  duplicatesRemoved: number;
  resolutionsRepointed: number;
};

type TxnRow = typeof transactionsTable.$inferSelect;

/**
 * (#452) Normalize a description for the duplicate-detection key.
 * Lowercases, collapses runs of whitespace, and trims so that two rows
 * carrying "EXACT SCIENCES PAYMENT" and "exact sciences   payment"
 * group together. Pending/posted text noise (e.g. trailing "[pending]"
 * notes) lives in `notes`, not `description`, so the description alone
 * is a stable group key.
 */
function normalizeDescription(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function groupKey(t: Pick<TxnRow, "occurredOn" | "amount" | "description">): string {
  return `${t.occurredOn}|${t.amount}|${normalizeDescription(t.description)}`;
}

/**
 * (#452) Per-row score of "user-applied state". Rows with more state
 * win the survivor selection so a forecast-matched, category-overridden,
 * sent-to-forecast row is never the one we delete in favor of a
 * brand-new bare twin from a fresh Plaid item.
 */
function userStateScore(
  t: TxnRow,
  hasResolution: boolean,
): number {
  let score = 0;
  if (hasResolution) score += 4;
  if (t.forecastFlag) score += 2;
  if (t.categoryId) score += 2;
  if (t.debtId) score += 1;
  if (t.weeklyAllowance) score += 1;
  if (t.monthlyAllowance) score += 1;
  if (t.unplannedAllowance) score += 1;
  if (t.reimbursable) score += 1;
  if (t.reimbursed) score += 1;
  if (t.weeklyBucket) score += 1;
  if (t.notes && t.notes.trim().length > 0 && t.notes !== "[pending]") {
    score += 1;
  }
  if (t.member) score += 1;
  if (t.owedBy) score += 1;
  if (t.isTransfer) score += 1;
  return score;
}

/**
 * (#452) Merge any loser-only user state onto the survivor. Only fills
 * in fields the survivor has left blank — never clobbers a survivor
 * value with a loser value.
 */
function mergeStatePatch(
  survivor: TxnRow,
  loser: TxnRow,
): Partial<typeof transactionsTable.$inferInsert> {
  const patch: Partial<typeof transactionsTable.$inferInsert> = {};
  if (!survivor.categoryId && loser.categoryId) patch.categoryId = loser.categoryId;
  if (!survivor.debtId && loser.debtId) patch.debtId = loser.debtId;
  if (!survivor.forecastFlag && loser.forecastFlag) patch.forecastFlag = true;
  if (!survivor.weeklyAllowance && loser.weeklyAllowance) patch.weeklyAllowance = true;
  if (!survivor.monthlyAllowance && loser.monthlyAllowance) patch.monthlyAllowance = true;
  if (!survivor.unplannedAllowance && loser.unplannedAllowance) {
    patch.unplannedAllowance = true;
  }
  if (!survivor.reimbursable && loser.reimbursable) patch.reimbursable = true;
  if (!survivor.reimbursed && loser.reimbursed) patch.reimbursed = true;
  if (!survivor.weeklyBucket && loser.weeklyBucket) patch.weeklyBucket = loser.weeklyBucket;
  if (!survivor.member && loser.member) patch.member = loser.member;
  if (!survivor.owedBy && loser.owedBy) patch.owedBy = loser.owedBy;
  if (!survivor.isTransfer && loser.isTransfer) patch.isTransfer = true;
  if (
    (!survivor.notes || survivor.notes === "[pending]") &&
    loser.notes &&
    loser.notes !== "[pending]"
  ) {
    patch.notes = loser.notes;
  }
  // Prefer to keep a real Plaid transaction id on the survivor if it
  // doesn't have one yet — that way the next /transactions/sync can
  // refresh the row in-place via onConflictDoUpdate instead of
  // inserting a third copy.
  if (!survivor.plaidTransactionId && loser.plaidTransactionId) {
    patch.plaidTransactionId = loser.plaidTransactionId;
  }
  if (!survivor.plaidAccountId && loser.plaidAccountId) {
    patch.plaidAccountId = loser.plaidAccountId;
  }
  return patch;
}

/**
 * (#452) Collapse duplicate `transactions` rows for one Plaid account.
 *
 * Duplicate key: `(userId, plaidAccountId, occurredOn, amount,
 * normalizedDescription)`. The `transactions_plaid_txn_uq` unique
 * index is on `plaid_transaction_id` alone, so when the same real
 * posting arrives a second time under a different Plaid item (re-link,
 * cross-Plaid-item duplicate) it survives the upsert and shows up as
 * a second row in the ledger. This routine picks a survivor (most
 * user state wins, ties break on oldest createdAt), repoints any
 * `forecast_resolutions.matched_txn_id` references onto the survivor,
 * merges loser-only user state onto the survivor, and deletes the
 * loser row(s). Idempotent — a clean account is a no-op.
 */
export async function dedupeTransactionsForAccount(
  userId: string,
  plaidAccountId: string,
  outerTx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<DedupeTxnReport> {
  const report: DedupeTxnReport = {
    groupsScanned: 0,
    duplicatesRemoved: 0,
    resolutionsRepointed: 0,
  };
  const run = async (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ): Promise<DedupeTxnReport> => {
    const rows = await tx
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, userId),
          eq(transactionsTable.plaidAccountId, plaidAccountId),
        ),
      );
    if (rows.length < 2) return report;

    const groups = new Map<string, TxnRow[]>();
    for (const r of rows) {
      const k = groupKey(r);
      const arr = groups.get(k);
      if (arr) arr.push(r);
      else groups.set(k, [r]);
    }

    const dupGroups = Array.from(groups.values()).filter((g) => g.length > 1);
    if (dupGroups.length === 0) return report;

    // Look up forecast_resolutions matches for any candidate row in one
    // shot so the per-group scoring step has the data it needs without
    // N round-trips.
    const candidateIds = dupGroups.flatMap((g) => g.map((r) => r.id));
    const resolutions = candidateIds.length
      ? await tx
          .select({
            id: forecastResolutionsTable.id,
            matchedTxnId: forecastResolutionsTable.matchedTxnId,
          })
          .from(forecastResolutionsTable)
          .where(
            and(
              eq(forecastResolutionsTable.userId, userId),
              inArray(forecastResolutionsTable.matchedTxnId, candidateIds),
            ),
          )
      : [];
    const resolutionsByTxn = new Map<string, string[]>();
    for (const r of resolutions) {
      if (!r.matchedTxnId) continue;
      const arr = resolutionsByTxn.get(r.matchedTxnId) ?? [];
      arr.push(r.id);
      resolutionsByTxn.set(r.matchedTxnId, arr);
    }

    for (const group of dupGroups) {
      report.groupsScanned += 1;
      // Sort: highest score first, then oldest createdAt first.
      const scored = group
        .map((row) => ({
          row,
          score: userStateScore(row, resolutionsByTxn.has(row.id)),
          createdAt: row.createdAt?.getTime() ?? 0,
        }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.createdAt - b.createdAt;
        });
      const survivor = scored[0].row;
      const losers = scored.slice(1).map((s) => s.row);

      // Build a single patch from all losers — fill in any field the
      // survivor doesn't already have, taking the first loser that
      // provides it.
      let patch: Partial<typeof transactionsTable.$inferInsert> = {};
      for (const loser of losers) {
        const p = mergeStatePatch({ ...survivor, ...patch } as TxnRow, loser);
        patch = { ...patch, ...p };
      }
      // Repoint forecast_resolutions matched_txn_id from each loser
      // onto the survivor BEFORE deleting the loser rows (matched_txn_id
      // is only a soft FK so the delete wouldn't cascade, but losing
      // the pointer would orphan the resolution). When the survivor
      // already has its own resolution row pointing to it, the
      // repointed loser-row becomes a duplicate resolution; that's
      // expected and harmless — both refer to the same survivor txn.
      const loserIds = losers.map((l) => l.id);
      const repointable = loserIds.filter((id) => resolutionsByTxn.has(id));
      if (repointable.length > 0) {
        const updated = await tx
          .update(forecastResolutionsTable)
          .set({ matchedTxnId: survivor.id })
          .where(
            and(
              eq(forecastResolutionsTable.userId, userId),
              inArray(forecastResolutionsTable.matchedTxnId, repointable),
            ),
          )
          .returning({ id: forecastResolutionsTable.id });
        report.resolutionsRepointed += updated.length;
      }

      // Drop the loser rows BEFORE applying the patch — the patch
      // may include a `plaidTransactionId` adopted from a loser, and
      // `transactions_plaid_txn_uq` would fire if the loser still
      // owned that id at update time.
      await tx
        .delete(transactionsTable)
        .where(
          and(
            eq(transactionsTable.userId, userId),
            inArray(transactionsTable.id, loserIds),
          ),
        );
      report.duplicatesRemoved += loserIds.length;

      if (Object.keys(patch).length > 0) {
        await tx
          .update(transactionsTable)
          .set(patch)
          .where(eq(transactionsTable.id, survivor.id));
      }
    }

    return report;
  };

  if (outerTx) return run(outerTx);
  return await db.transaction(run);
}

/**
 * (#452) Convenience wrapper: dedupe every Plaid account belonging to
 * the user. Used by the admin endpoint and by the post-sync cleanup
 * pass when we need to scan multiple accounts at once.
 */
export async function dedupeTransactionsForUser(
  userId: string,
): Promise<DedupeTxnReport & { accountsScanned: number }> {
  const accounts = await db
    .selectDistinct({ plaidAccountId: transactionsTable.plaidAccountId })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        sql`${transactionsTable.plaidAccountId} is not null` as SQL<unknown>,
      ),
    );
  const totals: DedupeTxnReport & { accountsScanned: number } = {
    groupsScanned: 0,
    duplicatesRemoved: 0,
    resolutionsRepointed: 0,
    accountsScanned: 0,
  };
  for (const a of accounts) {
    if (!a.plaidAccountId) continue;
    totals.accountsScanned += 1;
    const r = await dedupeTransactionsForAccount(userId, a.plaidAccountId);
    totals.groupsScanned += r.groupsScanned;
    totals.duplicatesRemoved += r.duplicatesRemoved;
    totals.resolutionsRepointed += r.resolutionsRepointed;
  }
  return totals;
}
