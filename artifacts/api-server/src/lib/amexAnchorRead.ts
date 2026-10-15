// ⭐ (S5) THE AMEX ANCHOR READ — what `GET /amex/anchor` answers, as a function,
// so `GET /amex/summary`'s `owed` is the same call and never a second copy.
//
// ⚠️ THIS IS A MOVE, NOT A NEW CALCULATION. The body below is the route
// handler's, verbatim, with each `res.json(x); return;` now `return x;` and the
// request's `householdId`, owner and `?accountId=` passed in. The route calls
// it and sends what it returns, so its answers are byte-identical — pinned by
// `amexAnchorRoute`, `amexAnchorPerCard`, `amexAnchorPlaidBalance` and the B4
// scenario (`amexCheckingScenario`) integration tests.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
  settingsTable,
} from "@workspace/db";
import { normalizeCardAmount } from "@workspace/avalanche-core";
import { AMEX_TXN_SOURCES } from "./amexAnchor";
import { householdTodayISO } from "./householdClock";
import { expiredHoldsRuleOn, findExpiredHoldsAmong } from "./supersededPending";

/** What `GET /amex/anchor` answers. */
export interface AmexAnchorAnswer {
  amexEndingBalance: number | null;
  /** An ISO instant, except for `computed`: the latest Amex row's household day (YYYY-MM-DD). */
  asOf: string;
  source: "plaid" | "debt" | "anchor" | "computed" | "missing";
}

/** (WP8b) Is this external Plaid `account_id` a credit card of the household? */
async function isHouseholdCreditCard(householdId: string, externalId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: plaidAccountsTable.id })
    .from(plaidAccountsTable)
    .where(
      and(
        eq(plaidAccountsTable.householdId, householdId),
        eq(plaidAccountsTable.accountId, externalId),
        eq(plaidAccountsTable.type, "credit"),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Resolved Amex ending balance for the household. Used by the Amex page
 * as a server-side fallback so it does not silently show "Unavailable" when
 * the linked debt row is removed or renamed.
 *
 * Resolution order:
 *   1) `debt`     — a debts row whose name matches /amex|american express/i
 *                   or whose plaid_account_id matches an Amex transaction.
 *   2) `anchor`   — a previously persisted value at
 *                   `settings.preferences.amexAnchor`.
 *   3) `computed` — net change of all Amex rows (`amex` + `plaid:amex`) from $0,
 *                   each source put on the owed sign first (Q3).
 *   4) `missing`  — no Amex data at all.
 * (Plaid's stored liability balance, `plaid`, is read before all of these
 * whenever the cards in scope have one — #651 below.)
 *
 * (WP8b) Per card (`scopedAccountId`): any credit card of the household, Amex
 * or not, answers its Plaid liability balance (`plaid`) or its debt row
 * (`debt`), else `missing` — never the saved combined anchor and never
 * `computed`.
 *
 * (#748) `scopedAccountId` (an external Plaid account_id) scopes resolution to
 * a single physical Amex card: every downstream lookup (Plaid liability sum,
 * debt-row lookup) is restricted to that one account, so a per-card figure
 * never carries the combined roll-up. Null = the combined anchor.
 */
export async function resolveAmexAnchor(
  householdId: string,
  ownerId: string,
  scopedAccountId: string | null,
): Promise<AmexAnchorAnswer> {
  // (WP9) No heal here. Twin plaid_accounts rows (a re-link's second row for
  // the same card) are merged only when a bank sync runs (syncPlaidItem →
  // dedupePlaidAccountsForUser), never on a page read: this GET is read-only
  // for account rows, so a figure never depends on which page opened first.
  // (It used to collapse twins on the first Amex page hit, #416.)
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
  // (#gold) Exclude the Delta SkyMiles charge card from the Amex ending-balance
  // account set. It's a pay-in-full CHARGE card, not revolving Amex credit, so
  // its (~$11.5k) balance must never inflate the anchor / chart. Mirrors
  // reportsBalances' /delta/i exclusion and the client resolver. Filtering the
  // account SET here covers BOTH the Plaid-liability sum and the debt-row sum.
  if (amexPlaidAccountIdSet.size > 0) {
    const namedRows = await db
      .select({
        accountId: plaidAccountsTable.accountId,
        name: plaidAccountsTable.name,
        officialName: plaidAccountsTable.officialName,
      })
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.householdId, householdId),
          inArray(plaidAccountsTable.accountId, [...amexPlaidAccountIdSet]),
        ),
      );
    for (const r of namedRows) {
      const nm = `${r.name ?? ""} ${r.officialName ?? ""}`;
      if (r.accountId && /delta/i.test(nm)) {
        amexPlaidAccountIdSet.delete(r.accountId);
      }
    }
  }
  // (#748) Per-card scope filter. If the client passed
  // `?accountId=...` we only proceed for that single card; if the
  // requested account is not a card here we short-circuit to
  // `missing` so the client renders the empty state instead of
  // falling through to the global `settings.amexAnchor` fallback
  // below (which would otherwise yield the combined value for an
  // invalid per-card request).
  //
  // ⭐ (WP8b) ANY CREDIT CARD OF THE HOUSEHOLD, at any bank — not only the Amex
  // set. A card's own page lists that card's rows (WP7), so it anchors on that
  // card's own figure: Plaid's stored liability balance (the card model's
  // `creditorCurrent` for a card with no debt row, which the account Summary
  // prints as "Card's current balance") or its debt row. Outside the Amex set
  // this answered `missing` and the page ran its running balances and chart up
  // from $0. (The Delta charge card stays out of the combined set above, but
  // its own page reads its own figure.)
  let amexPlaidAccountIds: string[];
  if (scopedAccountId) {
    if (
      !amexPlaidAccountIdSet.has(scopedAccountId) &&
      !(await isHouseholdCreditCard(householdId, scopedAccountId))
    ) {
      return {
        amexEndingBalance: null,
        asOf: new Date().toISOString(),
        source: "missing" as const,
      };
    }
    amexPlaidAccountIds = [scopedAccountId];
  } else {
    amexPlaidAccountIds = Array.from(amexPlaidAccountIdSet);
  }

  // (#748) For per-card debt lookup we need the internal
  // `plaid_accounts.id` UUID — `debts.plaid_account_id` is a UUID FK
  // (lib/db/src/schema/index.ts), not the external Plaid `account_id`
  // string. Resolve it once for the scoped card so the debt query
  // below can be keyed correctly.
  let scopedInternalPlaidAccountRowId: string | null = null;
  if (scopedAccountId) {
    const [row] = await db
      .select({ id: plaidAccountsTable.id })
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.householdId, householdId),
          eq(plaidAccountsTable.accountId, scopedAccountId),
        ),
      );
    scopedInternalPlaidAccountRowId = row?.id ?? null;
  }

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
  if (scopedAccountId) {
    // (#748) Per-card path: key debts on the resolved internal UUID.
    if (scopedInternalPlaidAccountRowId) {
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
            eq(debtsTable.plaidAccountId, scopedInternalPlaidAccountRowId),
          ),
        );
    }
  } else if (amexPlaidAccountIds.length > 0) {
    // Combined-Amex path: resolve every internal row id for the set
    // of external Amex account_ids in scope, then match debts on
    // those UUIDs. `debts.plaid_account_id` is a UUID FK to
    // `plaid_accounts.id`, not the external string, so the prior
    // `::text`-cast inArray could never match in practice.
    const rowIds = await db
      .select({ id: plaidAccountsTable.id })
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.householdId, householdId),
          inArray(plaidAccountsTable.accountId, amexPlaidAccountIds),
        ),
      );
    const internalIds = rowIds.map((r) => r.id);
    if (internalIds.length > 0) {
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
            inArray(debtsTable.plaidAccountId, internalIds),
          ),
        );
    }
  }
  // (#748) When a card was specifically requested, do NOT fall back
  // to the legacy name-regex matcher — that would re-aggregate every
  // Amex debt and reintroduce the combined-tile bug for the per-card
  // chip. Per-card resolution stays strict and lets the next fallback
  // tier (computed-from-txns) take over instead.
  if (debtRows.length === 0 && !scopedAccountId) {
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
  // (#651) Filter the sum to *credit-card* accounts only. The
  // discovery set above (txn-derived ∪ institution-slug-derived) can
  // pull in non-debt sub-accounts on the same Amex login (Membership
  // Rewards / High-Yield Savings / brokerage cash). Their
  // `liability_balance` column may be populated from /accounts/get's
  // generic balance (positive cash) and would otherwise be summed in
  // alongside the credit-card debt — yielding a wrong, often
  // negative-signed Ending Balance because cash partially offsets
  // owed-debt.
  //
  // (#689) Originally this filter accepted `type IN ('credit','loan')`,
  // which let Amex-installment / Pay-Over-Time / "Plan-It" LOAN
  // sub-accounts leak in alongside the actual credit-card debt. A
  // user with a $20,000 Amex personal loan was seeing that whole
  // loan balance reported as their Amex credit-card Ending Balance.
  // The Amex page (and the dashboard tile that mirrors it) is
  // specifically about the revolving credit-card liability; loan
  // sub-accounts belong on /debts, not in this sum. So we now require
  // `type = 'credit'` AND (when the liabilities product has run)
  // `liability_kind = 'credit'` — Plaid's liability kinds are
  // {'credit','student','mortgage'}, of which only 'credit' is a
  // credit card.
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
          sql`${plaidAccountsTable.type} = 'credit'`,
          sql`(${plaidAccountsTable.liabilityKind} is null or ${plaidAccountsTable.liabilityKind} = 'credit')`,
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
      return {
        amexEndingBalance: total,
        asOf: (latest ?? new Date()).toISOString(),
        source: "plaid" as const,
      };
    }
  }

  if (debt) {
    const debtAsOf = (debt.updatedAt ?? new Date()).toISOString();
    const anchorAsOf = anchor?.asOf ?? null;
    const asOf =
      anchorAsOf && anchorAsOf > debtAsOf ? anchorAsOf : debtAsOf;
    return {
      amexEndingBalance: Number(debt.balance),
      asOf,
      source: "debt" as const,
    };
  }

  // (#748) Skip the global `settings.amexAnchor` fallback for per-
  // card requests — that anchor is user-set across the combined Amex
  // tile and would otherwise leak the combined balance back into a
  // per-card request that has no debt + no Plaid liability.
  if (
    !scopedAccountId &&
    anchor &&
    anchor.balance !== undefined &&
    anchor.balance !== null
  ) {
    const n = Number(anchor.balance);
    if (Number.isFinite(n)) {
      return {
        amexEndingBalance: n,
        asOf: anchor.asOf ?? new Date().toISOString(),
        source: "anchor" as const,
      };
    }
  }

  // (WP8b) One card's balance is that card's own figure (Plaid's, or its debt
  // row's above), never a running sum of its rows from $0: its rows here start
  // where the bank's feed starts, not where the card opened. With neither, the
  // per-card answer is `missing`, and the page shows no running balance and no
  // chart, and says so. (It used to answer a per-card "Calculated" sum.)
  if (scopedAccountId) {
    return {
      amexEndingBalance: null,
      asOf: new Date().toISOString(),
      source: "missing" as const,
    };
  }
  // ⭐ (Q3) Summed PER SOURCE, then put on the owed sign (`normalizeCardAmount`,
  // the one card-sign rule `refreshAmexAnchor` already uses): the workbook
  // (`amex`) stores a purchase positive, Plaid (`plaid:amex`) negative. The raw
  // column summed across both netted a Plaid purchase against a workbook one,
  // and gave a Plaid-only household a negative balance. Cents, so the sum is exact.
  const bySource = await db
    .select({
      source: transactionsTable.source,
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
    )
    .groupBy(transactionsTable.source);
  const agg = {
    cnt: bySource.reduce((n, r) => n + Number(r.cnt ?? 0), 0),
    owedCents: bySource.reduce(
      (c, r) => c + Math.round(normalizeCardAmount(r.source, r.net) * 100),
      0,
    ),
    latest: bySource.reduce<string | null>(
      (l, r) => (r.latest && (!l || r.latest > l) ? r.latest : l),
      null,
    ),
  };

  if (agg.cnt > 0) {
    // ⭐ (F6 round 5, finding 1) An expired hold counts nowhere, this sum
    // included: the page subtracts only the rows that count (`isCounted`) when
    // it walks back from this balance, so a sum holding an expired hold read
    // every month before high by it. Only a pending Plaid row can be one: no
    // read when none is. Kill switch off: the sum of every row, as before.
    // (F6 ⇄ Q3 merge) Taken off on the owed sign (`normalizeCardAmount`, per
    // row's source), the same sign the sum above is on.
    const pendingRows = expiredHoldsRuleOn()
      ? await db
          .select({
            id: transactionsTable.id,
            source: transactionsTable.source,
            pending: transactionsTable.pending,
            plaidAccountId: transactionsTable.plaidAccountId,
            occurredOn: transactionsTable.occurredOn,
            amount: transactionsTable.amount,
          })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
              eq(transactionsTable.pending, true),
              isNotNull(transactionsTable.plaidAccountId),
            ),
          )
      : [];
    const expired = await findExpiredHoldsAmong(householdId, pendingRows);
    const expiredOwedCents = pendingRows.reduce(
      (sum, r) => sum + (expired.has(r.id) ? Math.round(normalizeCardAmount(r.source, r.amount) * 100) : 0),
      0,
    );
    return {
      // `+ 0`: never a negative zero.
      amexEndingBalance: (agg.owedCents - expiredOwedCents) / 100 + 0,
      // A bare household day (YYYY-MM-DD), never an instant: this balance already
      // holds every Amex row dated through its latest day. Sent as UTC midnight it
      // read as 7pm the evening before in Chicago, and the browser added that
      // day's rows a second time on top of the balance.
      asOf: agg.latest ?? householdTodayISO(),
      source: "computed" as const,
    };
  }

  return {
    amexEndingBalance: null,
    asOf: new Date().toISOString(),
    source: "missing" as const,
  };
}
