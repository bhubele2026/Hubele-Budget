import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  db,
  forecastResolutionsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";

export type DedupeTxnReport = {
  groupsScanned: number;
  duplicatesRemoved: number;
  resolutionsRepointed: number;
};

type TxnRow = typeof transactionsTable.$inferSelect;

/**
 * (#452 / #800) Tokenize a description for fuzzy-equality matching.
 *
 * Lowercases, strips non-alphanumerics (so punctuation differences
 * like commas, parentheses, hyphens don't fragment the token set),
 * and splits on whitespace. The resulting unordered token set is
 * compared subset-wise by `descriptionsFuzzyEqual` so a short
 * merchant label ("Affirm") and the long bank-statement form
 * ("AFFIRM.COM PAYME ... Merchant: Affirm") collapse to the same
 * cluster within an exact (account, date, amount) match.
 */
function tokenize(s: string | null | undefined): Set<string> {
  const norm = (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  return new Set(norm.split(/\s+/).filter(Boolean));
}

/**
 * (#800) Two descriptions are fuzzy-equal when one's token set is a
 * subset of the other's. This is asymmetric-friendly: it lets the
 * short merchant form ("Affirm") collapse with the long bank-statement
 * form ("AFFIRM.COM PAYME ... Merchant: Affirm") but does NOT collapse
 * two truly different merchants that happen to share an amount and
 * date (e.g. "REPLIT, INC. FOSTER CITY CA" vs "LOVABLE DOVER DE" —
 * neither's tokens are a subset of the other).
 *
 * Empty token sets only match other empty token sets. A real
 * description must never collapse onto a row with no description; the
 * loss of identifying text is too easy to mis-merge.
 */
function descriptionsFuzzyEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return A.size === B.size;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

/**
 * (#800) Coarse group key — `(occurredOn, amount)` only. Within one
 * `plaid_account_id` scope this is the universe of rows that could
 * possibly represent the same posting; the description-fuzzy step
 * below partitions it further into actual dupe clusters.
 */
function coarseKey(t: Pick<TxnRow, "occurredOn" | "amount">): string {
  return `${t.occurredOn}|${t.amount}`;
}

/**
 * (#800) Partition a coarse-keyed group into dupe clusters by
 * description fuzzy-equality. A row joins an existing cluster only if
 * it is fuzzy-equal with EVERY current member — guarantees the cluster
 * is a clique under the subset relation, so we never chain unrelated
 * descriptions through an intermediate row.
 */
function clusterByFuzzyDescription<T extends Pick<TxnRow, "description">>(
  rows: T[],
): T[][] {
  const clusters: T[][] = [];
  for (const r of rows) {
    let placed = false;
    for (const c of clusters) {
      if (c.every((x) => descriptionsFuzzyEqual(x.description, r.description))) {
        c.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([r]);
  }
  return clusters;
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

    // (#800) Two-step grouping: coarse-key by (occurredOn, amount),
    // then split each coarse group into description-fuzzy clusters.
    // Singletons aren't dupes; only clusters of size >= 2 are.
    const coarseGroups = new Map<string, TxnRow[]>();
    for (const r of rows) {
      const k = coarseKey(r);
      const arr = coarseGroups.get(k);
      if (arr) arr.push(r);
      else coarseGroups.set(k, [r]);
    }
    const dupGroups: TxnRow[][] = [];
    for (const cg of coarseGroups.values()) {
      if (cg.length < 2) continue;
      for (const cluster of clusterByFuzzyDescription(cg)) {
        if (cluster.length > 1) dupGroups.push(cluster);
      }
    }
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
/**
 * (#475-followup) Map a transactions row's `source` to a coarse bank
 * family used as a partition key for cross-account dedupe. When a user
 * re-links the same bank multiple times, each link mints a fresh
 * `plaid_accounts.account_id` (external string), so duplicate rows for
 * the same real posting end up in DIFFERENT account partitions and
 * `dedupeTransactionsForAccount` (scoped to one external account_id)
 * cannot see them as twins. Grouping by source family keeps Chase
 * rows from accidentally collapsing with same-day Amex rows that
 * happen to share an amount and description.
 */
function bankFamily(source: string | null | undefined): string | null {
  if (!source) return "manual";
  const s = source.toLowerCase();
  if (s === "manual") return "manual";
  if (s === "chase" || s === "plaid:chase") return "chase";
  if (s === "amex" || s === "plaid:amex") return "amex";
  // Other plaid:<slug> forms — partition by the slug so they still
  // group correctly without leaking across institutions.
  if (s.startsWith("plaid:")) return s.slice("plaid:".length);
  return s;
}

/**
 * (#475-followup) Cross-account dedupe: collapse rows that share
 * `(userId, bankFamily, occurredOn, amount, normalizedDescription)`
 * even when their `plaid_account_id` strings differ. This is the case
 * after a user re-links the same bank repeatedly — each link gets its
 * own `plaid_accounts.account_id`, and Plaid mints a fresh
 * `plaid_transaction_id` per link, so neither the per-account dedupe
 * nor the `transactions_plaid_txn_uq` index catches the duplicates.
 *
 * Survivor selection, state-merge, resolution-repoint, and delete-
 * before-patch ordering are identical to `dedupeTransactionsForAccount`.
 * The survivor's `plaid_account_id` is preferentially set to the
 * external account id whose `plaid_accounts` row still exists, so
 * surviving rows continue to render under the user's currently-linked
 * account.
 */
export async function dedupeTransactionsAcrossAccountsForUser(
  userId: string,
): Promise<DedupeTxnReport & { rowsScanned: number }> {
  const report: DedupeTxnReport & { rowsScanned: number } = {
    groupsScanned: 0,
    duplicatesRemoved: 0,
    resolutionsRepointed: 0,
    rowsScanned: 0,
  };

  // Fast pre-check (no transaction): collect distinct plaid_account_id
  // strings actually used by this user's Plaid-origin transactions and
  // see which ones no longer resolve to a live `plaid_accounts` row.
  // If none are orphaned, this user has no cross-account duplicate
  // residue to clean and the heal short-circuits — keeps the
  // /forecast hot path cheap once cleaned.
  const usedAccts = await db
    .selectDistinct({ plaidAccountId: transactionsTable.plaidAccountId })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        sql`${transactionsTable.plaidAccountId} is not null` as SQL<unknown>,
        sql`${transactionsTable.source} like 'plaid:%'` as SQL<unknown>,
      ),
    );
  const usedExternalIds = usedAccts
    .map((a) => a.plaidAccountId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  // Plaid rows with NO account link at all (plaid_account_id IS NULL) are
  // disconnected relink residue that never shows up in usedExternalIds —
  // e.g. the "—" (no card) twin of a live card charge. Detect them so they
  // still get collapsed instead of lingering on the All-cards view.
  const [nullAcctRow] = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        sql`${transactionsTable.source} like 'plaid:%'` as SQL<unknown>,
        sql`${transactionsTable.plaidAccountId} is null` as SQL<unknown>,
      ),
    )
    .limit(1);
  const hasNullAcctPlaidRow = !!nullAcctRow;

  const live = usedExternalIds.length
    ? await db
        .select({ accountId: plaidAccountsTable.accountId })
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.userId, userId),
            inArray(plaidAccountsTable.accountId, usedExternalIds),
          ),
        )
    : [];
  const liveAccountIds = new Set<string>(live.map((l) => l.accountId));
  const orphanAccountIds = new Set<string>(
    usedExternalIds.filter((id) => !liveAccountIds.has(id)),
  );
  if (orphanAccountIds.size === 0 && !hasNullAcctPlaidRow) return report;

  return await db.transaction(async (tx) => {
    // Only inspect Plaid-origin rows. Manual rows are user-authored and
    // must not be auto-collapsed even if their fields happen to match.
    const rows = await tx
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, userId),
          sql`${transactionsTable.source} like 'plaid:%'` as SQL<unknown>,
        ),
      );
    report.rowsScanned = rows.length;
    if (rows.length < 2) return report;

    // (#800) Coarse-key by (bankFamily, occurredOn, amount), then split
    // by description fuzzy-equality. Bank family stays in the key so
    // chase-vs-amex transfer pairs on the same date+amount never even
    // enter the same coarse group.
    const coarseGroups = new Map<string, TxnRow[]>();
    for (const r of rows) {
      const fam = bankFamily(r.source);
      if (!fam) continue;
      const k = `${fam}|${coarseKey(r)}`;
      const arr = coarseGroups.get(k);
      if (arr) arr.push(r);
      else coarseGroups.set(k, [r]);
    }
    const groups = new Map<string, TxnRow[]>();
    let _clusterIdx = 0;
    for (const [ck, cg] of coarseGroups) {
      if (cg.length < 2) continue;
      for (const cluster of clusterByFuzzyDescription(cg)) {
        if (cluster.length > 1) groups.set(`${ck}#${_clusterIdx++}`, cluster);
      }
    }

    // Only collapse groups where at least one row is on an orphan
    // (no surviving plaid_accounts row) account_id. That is the real
    // relink-residue signature. Two legitimate same-day same-amount
    // same-description rows from two REAL linked accounts at the same
    // institution will have BOTH rows on live accounts and will be
    // skipped — preserving them.
    // Relink-residue fingerprint: collapse only when we are highly
    // confident the rows are re-imports of the same underlying
    // posting, not an unrelated coincidental twin.
    //   - At least one row must sit on an orphan account_id (defunct
    //     link), AND
    //   - Either the group has 3+ copies (a relink storm always
    //     produces many — the production user has 11-12 per posting),
    //     OR the createdAt spread between an orphan member and a
    //     non-orphan member is >= 24h (real same-day double charges
    //     land near-simultaneously; re-imported residue is hours/days
    //     after the original).
    // Collapse a group when at least one row has NO live account link — an
    // orphaned account_id (defunct link) OR a null account_id — and the
    // group has at most one genuinely live-linked row. That's the relink-
    // residue fingerprint: a real same-day double charge would have BOTH
    // copies on the SAME live card (no orphan-like member), so it never
    // matches here and is preserved. The merge keeps the live-linked
    // survivor and folds the residue's category/allowance flags onto it.
    // (Replaces the older 3+-copies-or-24h-spread heuristic, which missed a
    // 2-copy same-day twin created by a same-day reconnect.)
    const isOrphanLike = (r: TxnRow): boolean =>
      !r.plaidAccountId || orphanAccountIds.has(r.plaidAccountId);
    const dupGroups = Array.from(groups.values()).filter((g) => {
      if (g.length < 2) return false;
      const orphanLike = g.filter(isOrphanLike);
      if (orphanLike.length === 0) return false; // no residue → preserve
      const liveCount = g.length - orphanLike.length;
      return liveCount <= 1;
    });
    if (dupGroups.length === 0) return report;

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
      const scored = group
        .map((row) => ({
          row,
          score: userStateScore(row, resolutionsByTxn.has(row.id))
            // Bonus point for being on the currently-linked account so
            // an active row beats an orphan-account twin at score-tie.
            + (row.plaidAccountId && liveAccountIds.has(row.plaidAccountId)
              ? 1
              : 0),
          createdAt: row.createdAt?.getTime() ?? 0,
        }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.createdAt - b.createdAt;
        });
      const survivor = scored[0].row;
      const losers = scored.slice(1).map((s) => s.row);

      let patch: Partial<typeof transactionsTable.$inferInsert> = {};
      for (const loser of losers) {
        const p = mergeStatePatch({ ...survivor, ...patch } as TxnRow, loser);
        patch = { ...patch, ...p };
      }
      // If the survivor is on an orphan account but a loser is on the
      // currently-linked one, repoint the survivor onto the live id so
      // the post-cleanup row renders under the user's active account.
      if (
        (!survivor.plaidAccountId ||
          !liveAccountIds.has(survivor.plaidAccountId)) &&
        !patch.plaidAccountId
      ) {
        const liveLoser = losers.find(
          (l) => l.plaidAccountId && liveAccountIds.has(l.plaidAccountId),
        );
        if (liveLoser?.plaidAccountId) {
          patch.plaidAccountId = liveLoser.plaidAccountId;
        }
      }

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
  });
}

/**
 * (#470) Read-only sibling of `dedupeTransactionsForUser`: returns
 * how many rows the per-account dedupe pass would delete if it ran
 * right now, without mutating anything. Used by the Settings badge
 * so the "Clean up duplicate transactions" row can show "12
 * duplicates found" / hide the button entirely when there are zero.
 *
 * Same group key as the per-account heal:
 *   (userId, plaidAccountId, occurredOn, amount, normalizedDescription)
 *
 * Sums `(count - 1)` over each duplicate group so the number matches
 * `duplicatesRemoved` from a follow-up cleanup on otherwise-clean data.
 * Cross-account relink residue (the rarer signature handled by
 * `dedupeTransactionsAcrossAccountsForUser`) is intentionally NOT
 * included — its eligibility filter requires per-row data the badge
 * doesn't need to surface, and the per-account count is the dominant
 * signal users care about.
 */
export async function countDuplicateTransactionsForUser(
  userId: string,
): Promise<{ duplicateCount: number }> {
  // (#800) Coarse key — (plaid_account_id, occurred_on, amount). This
  // matches the new dedupe pass's coarse grouping; the per-row fuzzy
  // description partitioning happens in JS during the real run. The
  // badge count may very slightly over-count for legitimate same-day
  // same-amount different-merchant pairs (e.g. "REPLIT, INC." +
  // "LOVABLE DOVER DE"), which the fuzzy pass then correctly preserves;
  // the badge eventually self-corrects once the user runs the cleanup
  // (those non-dupe pairs stay, the count rebases on next probe).
  const probe = await db.execute<{ extras: number }>(sql`
    select coalesce(sum(c - 1), 0)::int as extras from (
      select count(*)::int as c
      from ${transactionsTable}
      where ${transactionsTable.userId} = ${userId}
        and ${transactionsTable.plaidAccountId} is not null
      group by
        ${transactionsTable.plaidAccountId},
        ${transactionsTable.occurredOn},
        ${transactionsTable.amount}
      having count(*) > 1
    ) as g
  `);
  const rows = (probe as { rows?: Array<{ extras: number }> }).rows
    ?? (probe as unknown as Array<{ extras: number }>);
  const duplicateCount = Number(rows?.[0]?.extras ?? 0);
  return { duplicateCount };
}

export async function dedupeTransactionsForUser(
  userId: string,
): Promise<DedupeTxnReport & { accountsScanned: number }> {
  const totals: DedupeTxnReport & { accountsScanned: number } = {
    groupsScanned: 0,
    duplicatesRemoved: 0,
    resolutionsRepointed: 0,
    accountsScanned: 0,
  };

  // (#475-followup perf) Fast pre-check on the /forecast hot path:
  // a single aggregate query asks "are there any duplicate groups
  // anywhere in this user's plaid-account rows?" — uses the same
  // (plaid_account_id, occurredOn, amount, normalized description)
  // group key the per-account heal uses. Once the user's data is
  // clean (the steady state after the one-time relink cleanup), this
  // returns zero and we skip the full per-account scan + transaction
  // entirely. A noisy user still pays the full cost on the next load.
  // (#800) Coarse-key probe — (plaid_account_id, occurred_on, amount).
  // Strictly more permissive than the old normalized-description key
  // (catches both exact and fuzzy-description duplicates). When the
  // probe fires positive, the full per-account scan applies the JS
  // fuzzy-clustering and correctly skips coarse groups that aren't
  // true dupes.
  const dupeProbe = await db.execute<{ dup_groups: number }>(sql`
    select count(*)::int as dup_groups from (
      select 1
      from ${transactionsTable}
      where ${transactionsTable.userId} = ${userId}
        and ${transactionsTable.plaidAccountId} is not null
      group by
        ${transactionsTable.plaidAccountId},
        ${transactionsTable.occurredOn},
        ${transactionsTable.amount}
      having count(*) > 1
      limit 1
    ) as g
  `);
  const dupRows = (dupeProbe as { rows?: Array<{ dup_groups: number }> }).rows
    ?? (dupeProbe as unknown as Array<{ dup_groups: number }>);
  const dupCount = Number(dupRows?.[0]?.dup_groups ?? 0);
  if (dupCount === 0) return totals;

  const accounts = await db
    .selectDistinct({ plaidAccountId: transactionsTable.plaidAccountId })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        sql`${transactionsTable.plaidAccountId} is not null` as SQL<unknown>,
      ),
    );
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
