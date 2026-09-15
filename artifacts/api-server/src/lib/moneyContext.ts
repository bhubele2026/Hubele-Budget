// ⭐ (PR-H, owner decisions 7 and 12) THE SERVER LOADER for the household
// money model (`@workspace/avalanche-core`'s `classifyMovement`/
// `everydayPlan`). Reads, ONCE per request and bounded to the caller's range,
// everything a `classifyMovement`-based figure needs:
//
//   - the allowance amounts and `weeklyAllowanceOverrides` — read server-side
//     here for the FIRST time (today only the web's `allowances.tsx` and
//     `command-center.tsx` read overrides, straight off `useSettings()`);
//   - confirmed bill matches for the range (a `forecast_resolutions` row with
//     status `matched`/`partial` whose matched transaction is dated in it);
//   - superseded-pending pairs for the range, filing included
//     (`findSupersededPendingForRange` — never reimplemented here);
//   - the tracked checking account's external Plaid id
//     (`resolveLedgerAccounts` — never reimplemented here either);
//   - the Amex per-card billing-cadence map (`amexCardCadence.ts`'s
//     `discoverAmexCards`, shared with `computeWeeklyPayoff` so the two can
//     never disagree on a card's cadence).
//
// ⚠️ NOTHING DISPLAYED READS FROM THIS YET. `loadMoneyContext` is the shared
// foundation PR8r/PR10 switch a figure onto; see
// docs/reviews/2026-09-14-household-money-core.md.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  budgetCategoriesTable,
  db,
  forecastResolutionsTable,
  householdsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { resolveLedgerAccounts } from "./bankLedger";
import {
  findSupersededPendingForRange,
  type SupersededPendingInRange,
} from "./supersededPending";
import { uncategorizedCategoryIds, type FilingContext } from "./pendingFiling";
import { discoverAmexCards, type AmexCardCadence } from "./amexCardCadence";

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
  /** `preferences.weeklyAllowanceOverrides`: Sunday ISO -> dollar amount. */
  weeklyAllowanceOverrides: Record<string, string | number>;
}

export interface MoneyContext {
  range: MoneyContextRange;
  settings: MoneyContextSettings;
  /**
   * Transaction ids with a CONFIRMED bill match dated in `range`: a
   * `forecast_resolutions` row with status `matched` or `partial` whose
   * `matched_txn_id` is that transaction.
   */
  matchedTxnIds: ReadonlySet<string>;
  /** Superseded-pending pairs for `range`, filing included. */
  supersede: SupersededPendingInRange;
  /** `effectiveFiling`'s uncategorized-category lookup. */
  filingCtx: FilingContext;
  /** The household's tracked checking account, or null with none resolved. */
  checkingAccountExternalId: string | null;
  /** External Amex account id -> billing cadence. */
  amexCardCadence: ReadonlyMap<string, "weekly" | "monthly">;
}

/**
 * Confirmed bill matches dated in `[start, end]`, by the MATCHED
 * TRANSACTION's own date — not the bill's `occurrence_date` — so a resolution
 * survives a reschedule without the row silently falling outside the window
 * `classifyMovement` is being asked about it in.
 */
export async function loadConfirmedBillMatches(
  householdId: string,
  range: MoneyContextRange,
): Promise<Set<string>> {
  const rows = await db
    .select({ matchedTxnId: forecastResolutionsTable.matchedTxnId })
    .from(forecastResolutionsTable)
    .innerJoin(
      transactionsTable,
      eq(transactionsTable.id, forecastResolutionsTable.matchedTxnId),
    )
    .where(
      and(
        eq(forecastResolutionsTable.householdId, householdId),
        inArray(forecastResolutionsTable.status, ["matched", "partial"]),
        gte(transactionsTable.occurredOn, range.start),
        lte(transactionsTable.occurredOn, range.end),
      ),
    );
  return new Set(rows.map((r) => r.matchedTxnId).filter((id): id is string => !!id));
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
 * the household's standing settings and its Amex card roster, which are not
 * date-scoped data (the same way `budgetCategoriesTable` isn't).
 */
export async function loadMoneyContext(
  householdId: string,
  range: MoneyContextRange,
): Promise<MoneyContext> {
  const [household] = await db
    .select({ ownerUserId: householdsTable.ownerUserId })
    .from(householdsTable)
    .where(eq(householdsTable.id, householdId));
  const ownerUserId = household?.ownerUserId ?? null;

  const [settingsRow, matchedTxnIds, supersede, ledgerAccounts, cardCadence, cats] =
    await Promise.all([
      ownerUserId
        ? db
            .select({
              weekly: settingsTable.weeklyAllowanceAmount,
              monthly: settingsTable.monthlyAllowanceAmount,
              unplanned: settingsTable.unplannedAllowanceAmount,
              preferences: settingsTable.preferences,
            })
            .from(settingsTable)
            .where(eq(settingsTable.userId, ownerUserId))
        : Promise.resolve([]),
      loadConfirmedBillMatches(householdId, range),
      findSupersededPendingForRange(householdId, range.start, range.end),
      ownerUserId
        ? resolveLedgerAccounts(householdId, ownerUserId, undefined)
        : Promise.resolve(null),
      discoverAmexCards(householdId, ownerUserId ?? undefined),
      db
        .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
        .from(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.householdId, householdId)),
    ]);

  const s = settingsRow[0];
  const prefs = (s?.preferences as Record<string, unknown> | null | undefined) ?? {};
  const weeklyAllowanceOverrides =
    (prefs.weeklyAllowanceOverrides as Record<string, string | number>) ?? {};

  const uncategorizedIds = uncategorizedCategoryIds(cats);

  return {
    range,
    settings: {
      weeklyAllowanceAmount: s?.weekly ?? "0",
      monthlyAllowanceAmount: s?.monthly ?? "0",
      unplannedAllowanceAmount: s?.unplanned ?? "0",
      weeklyAllowanceOverrides,
    },
    matchedTxnIds,
    supersede,
    filingCtx: { uncategorizedIds },
    checkingAccountExternalId: ledgerAccounts?.accountExternalId ?? null,
    amexCardCadence: cadenceMapFrom(cardCadence),
  };
}
