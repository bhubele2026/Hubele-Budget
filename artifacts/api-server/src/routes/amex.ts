import { Router, type IRouter } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
  settingsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { AMEX_TXN_SOURCES } from "../lib/amexAnchor";
import { dedupePlaidAccountsForUser } from "../lib/dedupePlaidAccounts";

const router: IRouter = Router();

/**
 * Resolved Amex ending balance for the current user. Used by the Amex page
 * as a server-side fallback so it does not silently show "Unavailable" when
 * the linked debt row is removed or renamed.
 *
 * Resolution order:
 *   1) `debt`     — a debts row whose name matches /amex|american express/i
 *                   or whose plaid_account_id matches an Amex transaction.
 *   2) `anchor`   — a previously persisted value at
 *                   `settings.preferences.amexAnchor`.
 *   3) `computed` — net change of all `source='amex'` transactions from $0.
 *   4) `missing`  — no Amex data at all.
 */
router.get("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const ownerId = req.householdOwnerId!;
  const householdId = req.householdId!;

  // (#416) One-shot heal hook. Collapse any duplicate Amex
  // `plaid_accounts` rows the user accumulated from re-linking
  // American Express (one Plaid item, three physical cards) AND merge
  // any duplicate `debts` rows pointing at the same survivor account,
  // before we resolve the ending-balance anchor. Gated by
  // `settings.preferences.amexCleanupDoneAt` so the heal runs once
  // per user instead of on every Amex page hit; once stamped, the
  // (institution, mask) upsert guard at /plaid/exchange and the
  // post-exchange dedupe sweep keep things clean going forward.
  try {
    const [prefRow] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerId));
    const prefs =
      (prefRow?.preferences as Record<string, unknown> | null | undefined) ??
      {};
    const alreadyCleaned =
      typeof prefs.amexCleanupDoneAt === "string" &&
      prefs.amexCleanupDoneAt.length > 0;
    if (!alreadyCleaned) {
      const report = await dedupePlaidAccountsForUser(userId);
      if (
        report.duplicatesRemoved > 0 ||
        report.snapshotRepointed ||
        report.syntheticDropped
      ) {
        req.log.info(
          { userId, ...report },
          "[amex-anchor] one-shot heal collapsed duplicate plaid_accounts on Amex page hit",
        );
      }
      // NB: a parallel debt-side merge is unnecessary because the
      // `debts_plaid_account_unique` constraint already prevents two
      // debt rows from pointing at the same plaid_account — the
      // dedupe above repoints surviving debts atomically.
      const nextPrefs = {
        ...prefs,
        amexCleanupDoneAt: new Date().toISOString(),
      };
      if (prefRow) {
        await db
          .update(settingsTable)
          .set({ preferences: nextPrefs, updatedAt: new Date() })
          .where(eq(settingsTable.userId, ownerId));
      } else {
        await db
          .insert(settingsTable)
          .values({ userId: ownerId, householdId, preferences: nextPrefs })
          .onConflictDoUpdate({
            target: settingsTable.userId,
            set: { preferences: nextPrefs, updatedAt: new Date() },
          });
      }
    }
  } catch (e) {
    req.log.warn(
      { err: e, userId },
      "[amex-anchor] one-shot heal failed (non-fatal)",
    );
  }

  const acctRows = await db
    .selectDistinct({ plaidAccountId: transactionsTable.plaidAccountId })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
        sql`${transactionsTable.plaidAccountId} is not null`,
      ),
    );
  const amexPlaidAccountIdSet = new Set<string>(
    acctRows
      .map((r) => r.plaidAccountId)
      .filter((v): v is string => !!v),
  );

  // (#483) Also discover Amex-owned Plaid accounts directly from
  // `plaid_items.institution_slug` so a freshly-linked Amex item with
  // no transactions yet still lights up the Plaid balance fallback
  // below — txn-derived discovery alone misses the no-transactions
  // window between Plaid Link completing and the first
  // /transactions/sync run landing rows on this user.
  const amexAcctRows = await db
    .select({ accountId: plaidAccountsTable.accountId })
    .from(plaidAccountsTable)
    .innerJoin(plaidItemsTable, eq(plaidAccountsTable.itemId, plaidItemsTable.id))
    .where(
      and(
        eq(plaidAccountsTable.householdId, householdId),
        sql`${plaidItemsTable.institutionSlug} ~* '(amex|american[-_\\s]*express)'`,
      ),
    );
  for (const r of amexAcctRows) {
    if (r.accountId) amexPlaidAccountIdSet.add(r.accountId);
  }
  const amexPlaidAccountIds = Array.from(amexPlaidAccountIdSet);

  // (#416) Aggregate across every Amex debt row when the user has more
  // than one (one Plaid item with three physical cards yields three
  // debt rows). Sum the balances and use the most recent updatedAt as
  // the asOf so the Amex page's Ending Balance tile reflects the
  // combined liability across all cards rather than just whichever row
  // happened to come back first.
  let debt:
    | { id: string; balance: string; updatedAt: Date | null }
    | undefined;
  let debtRows: { id: string; balance: string; updatedAt: Date | null }[] = [];
  if (amexPlaidAccountIds.length > 0) {
    debtRows = await db
      .select({
        id: debtsTable.id,
        balance: debtsTable.balance,
        updatedAt: debtsTable.updatedAt,
      })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.householdId, householdId),
          inArray(sql`${debtsTable.plaidAccountId}::text`, amexPlaidAccountIds),
        ),
      );
  }
  if (debtRows.length === 0) {
    debtRows = await db
      .select({
        id: debtsTable.id,
        balance: debtsTable.balance,
        updatedAt: debtsTable.updatedAt,
      })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.householdId, householdId),
          sql`${debtsTable.name} ~* '(amex|american\\s*express)'`,
        ),
      );
  }
  if (debtRows.length > 0) {
    const totalBalance = debtRows.reduce(
      (acc, r) => acc + Number(r.balance ?? 0),
      0,
    );
    const latestUpdatedAt = debtRows.reduce<Date | null>((acc, r) => {
      if (!r.updatedAt) return acc;
      if (!acc) return r.updatedAt;
      return r.updatedAt > acc ? r.updatedAt : acc;
    }, null);
    debt = {
      id: debtRows[0].id,
      balance: String(totalBalance),
      updatedAt: latestUpdatedAt,
    };
  }

  // Always read the settings anchor (even when a debt row resolves) so we
  // can advance the returned `asOf` to the most recent of the two
  // timestamps. Without this, an auto-refresh that intentionally LEAVES the
  // debt row alone (manual UI override wins) would never bump the anchor's
  // `asOf` for clients hitting this endpoint, defeating the auto-update.
  const [settingsRow] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerId));
  const anchor =
    settingsRow?.preferences &&
    typeof settingsRow.preferences === "object" &&
    "amexAnchor" in (settingsRow.preferences as Record<string, unknown>)
      ? ((settingsRow.preferences as { amexAnchor?: unknown }).amexAnchor as
          | { balance?: number | string; asOf?: string }
          | undefined)
      : undefined;

  // (#651) Prefer the live Plaid liability balance over the
  // cached `debts.balance` row whenever Plaid has actually returned a
  // balance for the linked Amex sub-accounts. The debt row's `balance`
  // column can drift stale (manual edits, paused syncs, mid-relink
  // races), and the user has explicitly asked that the Amex Ending
  // Balance come from the Plaid connection — Plaid is the source of
  // truth here, the debt row is just a convenience cache.
  //
  // (#651) Filter the sum to *credit/loan* accounts only. The
  // discovery set above (txn-derived ∪ institution-slug-derived) can
  // pull in non-debt sub-accounts on the same Amex login (Membership
  // Rewards / High-Yield Savings / brokerage cash). Their
  // `liability_balance` column may be populated from /accounts/get's
  // generic balance (positive cash) and would otherwise be summed in
  // alongside the credit-card debt — yielding a wrong, often
  // negative-signed Ending Balance because cash partially offsets
  // owed-debt. Restrict to `type IN ('credit','loan')` (or to rows
  // where `liability_kind` is set, which only happens for accounts
  // the liabilities-product run actually classified) so cash sub-
  // accounts can never poison the sum.
  if (amexPlaidAccountIds.length > 0) {
    const balRows = await db
      .select({
        liabilityBalance: plaidAccountsTable.liabilityBalance,
        liabilityLastFetchedAt: plaidAccountsTable.liabilityLastFetchedAt,
      })
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.householdId, householdId),
          inArray(plaidAccountsTable.accountId, amexPlaidAccountIds),
          sql`(${plaidAccountsTable.type} in ('credit','loan') or ${plaidAccountsTable.liabilityKind} is not null)`,
        ),
      );
    let total = 0;
    let any = false;
    let latest: Date | null = null;
    for (const r of balRows) {
      if (r.liabilityBalance == null) continue;
      const n = Number(r.liabilityBalance);
      if (!Number.isFinite(n)) continue;
      total += n;
      any = true;
      const t = r.liabilityLastFetchedAt;
      if (t && (!latest || t > latest)) latest = t;
    }
    if (any) {
      res.json({
        amexEndingBalance: total,
        asOf: (latest ?? new Date()).toISOString(),
        source: "plaid" as const,
      });
      return;
    }
  }

  if (debt) {
    const debtAsOf = (debt.updatedAt ?? new Date()).toISOString();
    const anchorAsOf = anchor?.asOf ?? null;
    const asOf =
      anchorAsOf && anchorAsOf > debtAsOf ? anchorAsOf : debtAsOf;
    res.json({
      amexEndingBalance: Number(debt.balance),
      asOf,
      source: "debt" as const,
    });
    return;
  }

  if (anchor && anchor.balance !== undefined && anchor.balance !== null) {
    const n = Number(anchor.balance);
    if (Number.isFinite(n)) {
      res.json({
        amexEndingBalance: n,
        asOf: anchor.asOf ?? new Date().toISOString(),
        source: "anchor" as const,
      });
      return;
    }
  }

  const [agg] = await db
    .select({
      net: sql<string>`coalesce(sum(${transactionsTable.amount})::text, '0')`,
      cnt: sql<number>`count(*)::int`,
      latest: sql<string | null>`max(${transactionsTable.occurredOn})::text`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
      ),
    );

  if (agg && (agg.cnt ?? 0) > 0) {
    res.json({
      amexEndingBalance: Number(agg.net),
      asOf:
        (agg.latest ?? new Date().toISOString().slice(0, 10)) +
        "T00:00:00.000Z",
      source: "computed" as const,
    });
    return;
  }

  res.json({
    amexEndingBalance: null,
    asOf: new Date().toISOString(),
    source: "missing" as const,
  });
});

/**
 * Persist a user-provided actual Amex balance to
 * `settings.preferences.amexAnchor`. The Amex page exposes this when the
 * computed/transaction-derived ending balance is the only thing available
 * (no linked debt row, no prior anchor) so the user can pin reality and
 * have the chip switch back to "From saved anchor".
 *
 * Body: { balance: number, asOf?: string (ISO) }
 */
router.post("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const ownerId = req.householdOwnerId!;
  const householdId = req.householdId!;
  const body = (req.body ?? {}) as { balance?: unknown; asOf?: unknown };
  const balanceNum = Number(body.balance);
  if (!Number.isFinite(balanceNum)) {
    res.status(400).json({ error: "balance must be a finite number" });
    return;
  }
  let asOf: string;
  if (typeof body.asOf === "string" && body.asOf) {
    const d = new Date(body.asOf);
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: "asOf must be a valid ISO date string" });
      return;
    }
    asOf = d.toISOString();
  } else {
    asOf = new Date().toISOString();
  }

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerId));
    const prevPrefs =
      (existing?.preferences as Record<string, unknown> | null | undefined) ??
      {};
    const nextPrefs = {
      ...prevPrefs,
      amexAnchor: { balance: balanceNum, asOf },
    };
    if (existing) {
      await tx
        .update(settingsTable)
        .set({ preferences: nextPrefs, updatedAt: new Date() })
        .where(eq(settingsTable.userId, ownerId));
    } else {
      await tx
        .insert(settingsTable)
        .values({ userId: ownerId, householdId, preferences: nextPrefs })
        .onConflictDoUpdate({
          target: settingsTable.userId,
          set: { preferences: nextPrefs, updatedAt: new Date() },
        });
    }
  });

  res.json({
    amexEndingBalance: balanceNum,
    asOf,
    source: "anchor" as const,
  });
});

/**
 * Clear a previously persisted Amex anchor at
 * `settings.preferences.amexAnchor`. Lets the user remove the saved value so
 * the Amex page falls back to the linked debt row, the computed running sum,
 * or the missing state — whichever resolves next via GET /amex/anchor.
 */
router.delete("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const ownerId = req.householdOwnerId!;
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerId));
    if (!existing) return;
    const prevPrefs =
      (existing.preferences as Record<string, unknown> | null | undefined) ??
      {};
    if (!("amexAnchor" in prevPrefs)) return;
    const nextPrefs = { ...prevPrefs };
    delete (nextPrefs as Record<string, unknown>).amexAnchor;
    await tx
      .update(settingsTable)
      .set({ preferences: nextPrefs, updatedAt: new Date() })
      .where(eq(settingsTable.userId, ownerId));
  });
  res.json({ ok: true });
});

export default router;
