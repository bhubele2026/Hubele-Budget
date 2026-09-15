// ⭐ (PR-H, owner decisions 7 and 12) THE SERVER LOADER for the household
// money model (`@workspace/avalanche-core`'s `classifyMovement`/
// `everydayPlan`). Reads, ONCE per request and bounded to the caller's range,
// everything a `classifyMovement`-based figure needs — and the context it
// returns IS a `MovementContext`, so `classifyMovement(row, ctx)` takes it as is:
//
//   - the owner's settings row, once: the allowance amounts and
//     `weeklyAllowanceOverrides` — read server-side here for the FIRST time
//     (today only the web's `allowances.tsx` and `command-center.tsx` read
//     overrides, straight off `useSettings()`) — and the Amex per-card
//     preferences, handed to `discoverAmexCards` so it does not read the same
//     row a second time;
//   - the household's categories, once: `classifyOutflow`'s `categoriesById`/
//     `debtCategoryIds` and `effectiveFiling`'s uncategorized ids;
//   - confirmed bill matches for the range (a `forecast_resolutions` row with
//     status `matched`/`partial` whose matched transaction — in THIS household
//     — is dated in it), carried from a pending row to the posted row that
//     replaced it;
//   - superseded-pending pairs for the range, filing included
//     (`findSupersededPendingForRange` — never reimplemented here), or the
//     caller's own already-read pairs;
//   - the tracked checking account's external Plaid id
//     (`resolveLedgerAccounts` — never reimplemented here either);
//   - the Amex per-card billing-cadence map (`amexCardCadence.ts`'s
//     `discoverAmexCards`, shared with `computeWeeklyPayoff` so the two can
//     never disagree on a card's cadence).
//
// (PR8r) `buildForecastLedger` calls it through `everydayHooks.ts` for the
// everyday payoff hooks and the `everyday` block — the first production figure
// on it — handing in what the ledger has already read: the checking account,
// the settings row and the tier-2 pairs (`LoadMoneyContextOptions`). PR10 wires
// Spending and the Budget page. See docs/reviews/2026-09-14-household-money-core.md
// and docs/reviews/2026-09-15-everyday-reserve-hooks.md.
//
// Read here since PR8r: `preferences.everydayHooks` (as stored — the ledger
// checks each id is an active item of this household) and
// `preferences.amexExcludedTxnIds`. NOT read here: `preferences.paycheckItemIds`
// (PR9, with its OpenAPI schema and server validation).

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { SUPERSEDE_MAX_DAYS, type MovementContext } from "@workspace/avalanche-core";
import {
  budgetCategoriesTable,
  db,
  forecastResolutionsTable,
  householdsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { resolveLedgerAccounts } from "./bankLedger";
import { findSupersededPendingForRange, type SupersededPending } from "./supersededPending";
import { uncategorizedCategoryIds, type FilingContext } from "./pendingFiling";
import { discoverAmexCards, type AmexCardCadence } from "./amexCardCadence";
import { addDaysISO } from "./householdClock";

export interface MoneyContextRange {
  /** ISO date, inclusive. */
  start: string;
  /** ISO date, inclusive. */
  end: string;
}

export interface MoneyContextSettings {
  weeklyAllowanceAmount: string;
  monthlyAllowanceAmount: string;
  unplannedAllowanceAmount: string;
  /** `preferences.weeklyAllowanceOverrides`, as stored: Sunday ISO -> dollar amount. `everydayPlan` validates it. */
  weeklyAllowanceOverrides: Record<string, string | number>;
  /**
   * (PR8r) `preferences.everydayHooks`: the recurring items linked as the weekly
   * and monthly Amex payoff hooks, as stored (`readEverydayHooks`). NOT checked
   * here — the ledger reads a linked id only when it is an active item of this
   * household.
   */
  everydayHooks: EverydayHookLinks;
  /** (PR8r) `preferences.amexExcludedTxnIds`: the charges the owner marked "not mine", out of the Amex owed figure. */
  amexExcludedTxnIds: ReadonlySet<string>;
}

/** (PR8r) Which recurring items are the everyday payoff hooks. */
export interface EverydayHookLinks {
  weeklyItemId: string | null;
  monthlyItemId: string | null;
}

/** (PR8r) `preferences.everydayHooks`, read as stored: anything that is not a non-empty string id reads as null. */
export function readEverydayHooks(preferences: unknown): EverydayHookLinks {
  const prefs = (preferences && typeof preferences === "object" ? preferences : {}) as Record<string, unknown>;
  const hooks = (prefs.everydayHooks && typeof prefs.everydayHooks === "object" ? prefs.everydayHooks : {}) as Record<string, unknown>;
  const id = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return { weeklyItemId: id(hooks.weeklyItemId), monthlyItemId: id(hooks.monthlyItemId) };
}

/** The owner's settings row, as the money context reads it. */
export interface MoneyContextSettingsRow {
  weekly: string;
  monthly: string;
  unplanned: string;
  preferences: unknown;
}

/**
 * The owner's settings row, read ONCE.
 *
 * ⚠️ (PR-H review L1) A Drizzle query builder is a thenable that runs its query
 * on EVERY `.then`. Awaiting it in one place and attaching a `.then` in another
 * ran the same select twice. `.then((rows) => rows)` here runs it once and hands
 * back a real Promise every consumer can share.
 */
export function readSettingsRow(ownerUserId: string): Promise<MoneyContextSettingsRow | null> {
  return db
    .select({
      weekly: settingsTable.weeklyAllowanceAmount,
      monthly: settingsTable.monthlyAllowanceAmount,
      unplanned: settingsTable.unplannedAllowanceAmount,
      preferences: settingsTable.preferences,
    })
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId))
    .then((rows) => rows[0] ?? null);
}

/** The superseded-pending answer the context carries: which rows were replaced, and by what. */
export type MoneyContextSupersede = Pick<SupersededPending, "replacedIds" | "replacedBy">;

export interface MoneyContext extends MovementContext {
  range: MoneyContextRange;
  settings: MoneyContextSettings;
  /**
   * Transaction ids with a CONFIRMED bill match: a `forecast_resolutions` row
   * with status `matched` or `partial` whose `matched_txn_id` is a transaction
   * of this household dated in `range` — plus every posted row the supersede
   * answer pairs with a matched pending row (`confirmedMatchIds`).
   */
  matchedTxnIds: ReadonlySet<string>;
  /** Tier-2 pairs: the caller's (`LoadMoneyContextOptions.tier2PairedTxnIds`); empty by default. */
  tier2PairedTxnIds: ReadonlySet<string>;
  /** Superseded-pending pairs for `range`, filing included. */
  supersede: MoneyContextSupersede;
  /** `effectiveFiling`'s uncategorized-category lookup. */
  filingCtx: FilingContext;
  /** The household's tracked checking account, or null with none resolved. */
  checkingAccountExternalId: string | null;
  /** External Amex account id -> billing cadence. */
  amexCardCadence: ReadonlyMap<string, "weekly" | "monthly">;
}

export interface LoadMoneyContextOptions {
  /**
   * (review L1) The pending pairs, when the caller already has them — the spine
   * reads them once for both of its windows. They must be the whole-ledger
   * answer for every row in `range`: a `findSupersededPendingForRange` result
   * whose range covers it, or `findSupersededPending`. Omitted, they are read
   * here for `range`.
   */
  supersede?: MoneyContextSupersede;
  /**
   * (PR8r) The tracked checking account's external id, when the caller has
   * already resolved it — the ledger hands in the one its cash rule ran on, so
   * a row this context calls "checking" is a row the curve counts. PRESENT, even
   * as null, means "use it". Omitted, it is resolved here.
   */
  checkingAccountExternalId?: string | null;
  /**
   * (PR8r) The tier-2 pairs (`classifyMovement` step 2's second half): the
   * transactions a tier-1/2 bill pair covers, from the ledger's match tiers.
   * Omitted = none.
   */
  tier2PairedTxnIds?: ReadonlySet<string>;
  /**
   * (PR8r) The owner's settings row, when the caller has already read it
   * (`readSettingsRow`). PRESENT, even as null, means "use it; do not read
   * settings again". Omitted, it is read here, once.
   */
  settingsRow?: MoneyContextSettingsRow | null;
}

/** One confirmed match: the matched transaction and its own date. */
export interface ConfirmedMatchRow {
  txnId: string;
  occurredOn: string;
}

/**
 * Confirmed bill matches whose matched transaction belongs to this household
 * and is dated from `SUPERSEDE_MAX_DAYS` before `range.start` through
 * `range.end`, by the MATCHED TRANSACTION's own date — not the bill's
 * `occurrence_date`, so a resolution survives a reschedule without the row
 * silently falling outside the window `classifyMovement` is asked about it in.
 *
 * The extra days before the range are the pending rows a posted row in the
 * range can have replaced (it is dated 0-7 days after them) — see
 * `confirmedMatchIds`.
 *
 * ⚠️ TODO(PR-I, `feat/bank-removed-review-carry`): a confirmed match on a
 * BANK-REMOVED row must not count as coverage — except a removed pending row a
 * live posted row replaced. PR8r reads coverage through here (the everyday
 * hooks), so apply PR-I's `notBankRemovedSql` to this read at whichever of the
 * two merges lands second.
 */
export async function loadConfirmedMatchRows(
  householdId: string,
  range: MoneyContextRange,
): Promise<ConfirmedMatchRow[]> {
  const reachStart = addDaysISO(range.start, -SUPERSEDE_MAX_DAYS);
  return db
    .select({ txnId: transactionsTable.id, occurredOn: transactionsTable.occurredOn })
    .from(forecastResolutionsTable)
    .innerJoin(
      transactionsTable,
      eq(transactionsTable.id, forecastResolutionsTable.matchedTxnId),
    )
    .where(
      and(
        eq(forecastResolutionsTable.householdId, householdId),
        // (review L2) The matched transaction must be this household's too: a
        // resolution can never make another household's row read as matched.
        eq(transactionsTable.householdId, householdId),
        inArray(forecastResolutionsTable.status, ["matched", "partial"]),
        gte(transactionsTable.occurredOn, reachStart),
        lte(transactionsTable.occurredOn, range.end),
      ),
    );
}

/**
 * ⭐ (review M2) The confirmed-match ids for `range`: every matched
 * transaction dated in it, PLUS each posted row whose replaced pending row
 * carries a confirmed match. A match confirmed while the charge was pending
 * belongs to the charge, and the posted row is what counts once it posts
 * (the pending row counts nowhere) — without the carry, a pending $40 matched
 * to a bill posts at $48 and the posted row reads as unmatched.
 *
 * `rows` must reach `SUPERSEDE_MAX_DAYS` before `range.start`
 * (`loadConfirmedMatchRows`), which covers every pending row a posted row in
 * the range can have replaced. A pre-read supersede answer covering a wider
 * span may also carry a match onto a posted row outside `range`; that row is
 * never classified for this range, so it changes nothing.
 */
export function confirmedMatchIds(
  rows: readonly ConfirmedMatchRow[],
  range: MoneyContextRange,
  supersede: Pick<SupersededPending, "replacedBy">,
): Set<string> {
  const matchedAnywhere = new Set(rows.map((r) => r.txnId));
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.occurredOn >= range.start && r.occurredOn <= range.end) ids.add(r.txnId);
  }
  for (const [postedId, pending] of supersede.replacedBy) {
    if (matchedAnywhere.has(pending.id)) ids.add(postedId);
  }
  return ids;
}

/** `confirmedMatchIds` over a fresh read — for a caller that has the pairs but not the rest of the context. */
export async function loadConfirmedBillMatches(
  householdId: string,
  range: MoneyContextRange,
  supersede: Pick<SupersededPending, "replacedBy">,
): Promise<Set<string>> {
  return confirmedMatchIds(await loadConfirmedMatchRows(householdId, range), range, supersede);
}

function cadenceMapFrom(cards: AmexCardCadence): Map<string, "weekly" | "monthly"> {
  const out = new Map<string, "weekly" | "monthly">();
  for (const c of cards.cardRows) {
    if (c.accountId) out.set(c.accountId, cards.cadenceFor(c.accountId));
  }
  return out;
}

/**
 * ⭐ THE ONE MONEY-CONTEXT READ. Every query here is bounded to `range` except
 * the household's standing settings, categories and Amex card roster, which
 * are not date-scoped data. Each table is read once.
 */
export async function loadMoneyContext(
  householdId: string,
  range: MoneyContextRange,
  opts: LoadMoneyContextOptions = {},
): Promise<MoneyContext> {
  const [household] = await db
    .select({ ownerUserId: householdsTable.ownerUserId })
    .from(householdsTable)
    .where(eq(householdsTable.id, householdId));
  const ownerUserId = household?.ownerUserId ?? null;

  // (review L1) The owner's settings row, read ONCE — a real Promise
  // (`readSettingsRow`), never a Drizzle builder, which would run its select on
  // each `.then` below: its amounts and overrides for the context, its Amex
  // preferences for `discoverAmexCards`. `.then` attaches that consumer inside
  // the Promise.all, so a failed read rejects it instead of surfacing as an
  // unhandled rejection. A caller that already read the row hands it in.
  const settingsRead: Promise<MoneyContextSettingsRow | null> =
    "settingsRow" in opts
      ? Promise.resolve(opts.settingsRow ?? null)
      : ownerUserId
        ? readSettingsRow(ownerUserId)
        : Promise.resolve(null);

  const [s, matchRows, supersede, checkingAccountExternalId, cardCadence, cats] =
    await Promise.all([
      settingsRead,
      loadConfirmedMatchRows(householdId, range),
      opts.supersede
        ? Promise.resolve(opts.supersede)
        : findSupersededPendingForRange(householdId, range.start, range.end),
      "checkingAccountExternalId" in opts
        ? Promise.resolve(opts.checkingAccountExternalId ?? null)
        : ownerUserId
          ? resolveLedgerAccounts(householdId, ownerUserId, undefined).then((a) => a.accountExternalId)
          : Promise.resolve(null),
      settingsRead.then((row) =>
        discoverAmexCards(householdId, ownerUserId ?? undefined, {
          preferences: row?.preferences ?? null,
        }),
      ),
      // (review L1) Everything the context needs from categories, in one read.
      db
        .select({
          id: budgetCategoriesTable.id,
          name: budgetCategoriesTable.name,
          debtId: budgetCategoriesTable.debtId,
          kind: budgetCategoriesTable.kind,
        })
        .from(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.householdId, householdId)),
    ]);

  const prefs = (s?.preferences as Record<string, unknown> | null | undefined) ?? {};
  const weeklyAllowanceOverrides =
    (prefs.weeklyAllowanceOverrides as Record<string, string | number>) ?? {};
  const excluded = Array.isArray(prefs.amexExcludedTxnIds)
    ? prefs.amexExcludedTxnIds.filter((v): v is string => typeof v === "string")
    : [];

  // The same shape `buildSpendingFacts` builds for `classifyOutflow`.
  const categoriesById = new Map<string, { name: string; debtId: string | null; kind: string }>();
  const debtCategoryIds = new Set<string>();
  for (const c of cats) {
    categoriesById.set(c.id, { name: c.name, debtId: c.debtId, kind: c.kind });
    if (c.debtId) debtCategoryIds.add(c.id);
  }

  return {
    range,
    settings: {
      weeklyAllowanceAmount: s?.weekly ?? "0",
      monthlyAllowanceAmount: s?.monthly ?? "0",
      unplannedAllowanceAmount: s?.unplanned ?? "0",
      weeklyAllowanceOverrides,
      everydayHooks: readEverydayHooks(prefs),
      amexExcludedTxnIds: new Set(excluded),
    },
    categoriesById,
    debtCategoryIds,
    matchedTxnIds: confirmedMatchIds(matchRows, range, supersede),
    tier2PairedTxnIds: opts.tier2PairedTxnIds ?? new Set<string>(),
    supersede,
    filingCtx: { uncategorizedIds: uncategorizedCategoryIds(cats) },
    checkingAccountExternalId,
    amexCardCadence: cadenceMapFrom(cardCadence),
  };
}
