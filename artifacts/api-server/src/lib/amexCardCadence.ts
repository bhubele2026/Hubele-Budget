// (PR-H) The Amex card discovery + billing-cadence logic, extracted verbatim
// from `computeWeeklyPayoff` (`lib/amexAnchor.ts`, ~:273-345 before this
// move) so `moneyContext.ts`'s cadence map and the weekly payoff engine read
// the SAME per-card cadence — never two copies quietly drifting apart the way
// the rest of this codebase's "one implementation" rule exists to prevent.
//
// ⚠️ THIS IS A MOVE, NOT A NEW CALCULATION. `discoverAmexCards` is
// `computeWeeklyPayoff`'s own card-discovery block; its callers' outputs
// (`computeWeeklyPayoff`'s cards/combinedWeekCharges/combinedStatementBalance,
// and `classifyAmexBrand`) stay byte-identical — pinned by the existing Amex
// integration tests, which exercise the real `/api/amex/weekly-payoff` route
// end to end, and by `amexCardCadence.integration.test.ts`, which pins the
// discovery filters, the brand defaults and the owner's overrides directly.
// The one addition (round 2, review L1): a caller that has already read the
// owner's settings row passes its `preferences` in, so the row is read once.

import { and, eq, sql } from "drizzle-orm";
import { db, plaidAccountsTable, plaidItemsTable, settingsTable } from "@workspace/db";

export type AmexBrand = "blue" | "silver";

/**
 * Classify a physical Amex card into its brand identity from its display name
 * (and mask, defensively). Mirrors the name-regex matching style used by the
 * anchor resolution in `amexAnchor.ts` (#748).
 */
export function classifyAmexBrand(
  name: string | null | undefined,
  mask: string | null | undefined,
): AmexBrand {
  const s = `${name ?? ""} ${mask ?? ""}`;
  if (/blue/i.test(s)) return "blue";
  // Platinum, Gold (retired tier), and unmatched cards all resolve to silver
  // (Platinum-style) rather than dropping out of the stack entirely.
  return "silver";
}

export interface AmexCardRow {
  /** External Plaid account_id (`plaid_accounts.account_id`, NOT NULL). */
  accountId: string;
  /** Internal `plaid_accounts.id` uuid. */
  internalId: string;
  name: string | null;
  mask: string | null;
  liabilityBalance: string | null;
}

export interface AmexCardCadence {
  /** The physical Amex credit-card rows discovered for the household. */
  cardRows: AmexCardRow[];
  /** External account id -> brand, for every discovered card. */
  brandByAccountId: Map<string, AmexBrand>;
  /** The owner's saved per-card display names (`preferences.amexCardNames`). */
  nameMap: Record<string, string>;
  /** Transaction ids the owner marked "not mine" (`preferences.amexExcludedTxnIds`). */
  excludedTxnIds: Set<string>;
  /**
   * Effective billing cadence for an external account id: the owner's
   * explicit override (`preferences.amexCardCadence`) when set, else the
   * brand default (Blue Cash bills monthly, Platinum/Silver bills weekly).
   */
  cadenceFor: (accountId: string) => "weekly" | "monthly";
}

export interface DiscoverAmexCardsOptions {
  /**
   * (PR-H round 2, review L1) The owner's `settings.preferences`, when the
   * caller has already read that row — `loadMoneyContext` reads it for the
   * allowance amounts. PRESENT, even as `null` or `undefined`, means "use
   * these; do not read settings again". Omitted, they are read here for
   * `ownerUserId` (what `computeWeeklyPayoff` does).
   */
  preferences?: unknown;
}

/**
 * ⭐ Amex card discovery + cadence, read once. `computeWeeklyPayoff` and
 * `moneyContext.ts`'s `loadMoneyContext` both call this instead of each
 * running their own query, so the household's Amex cards and their billing
 * cadence can never disagree between the payoff plan and the money model.
 */
export async function discoverAmexCards(
  householdId: string,
  ownerUserId?: string,
  opts: DiscoverAmexCardsOptions = {},
): Promise<AmexCardCadence> {
  // Per-card config (cadence + display name) from the owner's settings.
  // Grouping/display metadata only — never changes a charge amount. With no
  // owner and nothing handed in, there is no config: every map is empty.
  let preferences: unknown = opts.preferences;
  if (!("preferences" in opts) && ownerUserId) {
    const [s] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerUserId));
    preferences = s?.preferences;
  }
  const prefs = (preferences as Record<string, unknown> | null | undefined) ?? {};
  const cadenceMap = (prefs.amexCardCadence as Record<string, string>) ?? {};
  const nameMap = (prefs.amexCardNames as Record<string, string>) ?? {};
  // Charges the user marked "not mine" (reimbursements) — excluded from the
  // payoff sum so the per-card "to pay" reflects only household-owed money.
  const excludedTxnIds = new Set((prefs.amexExcludedTxnIds as string[]) ?? []);

  // --- Discover the physical Amex credit cards -----------------------------
  // One Amex Plaid item = up to three physical cards (#748). Restrict to
  // credit-card sub-accounts so Membership Rewards / savings / loan
  // sub-accounts on the same login never enter the stack (mirrors the
  // anchor route's #651/#689 filter).
  const cardRows: AmexCardRow[] = await db
    .select({
      accountId: plaidAccountsTable.accountId,
      internalId: plaidAccountsTable.id,
      name: plaidAccountsTable.name,
      mask: plaidAccountsTable.mask,
      liabilityBalance: plaidAccountsTable.liabilityBalance,
    })
    .from(plaidAccountsTable)
    .innerJoin(plaidItemsTable, eq(plaidAccountsTable.itemId, plaidItemsTable.id))
    .where(
      and(
        eq(plaidAccountsTable.householdId, householdId),
        sql`${plaidItemsTable.institutionSlug} ~* '(amex|american[-_\\s]*express)'`,
        sql`${plaidAccountsTable.type} = 'credit'`,
        sql`(${plaidAccountsTable.liabilityKind} is null or ${plaidAccountsTable.liabilityKind} = 'credit')`,
      ),
    );

  // Brand per external account_id. Drives the DEFAULT cadence when the owner
  // hasn't set one explicitly: Blue Cash bills monthly, Platinum (silver)
  // bills weekly.
  const brandByAccountId = new Map<string, AmexBrand>();
  for (const c of cardRows) {
    if (c.accountId) brandByAccountId.set(c.accountId, classifyAmexBrand(c.name, c.mask));
  }
  const cadenceFor = (accountId: string): "weekly" | "monthly" => {
    const explicit = cadenceMap[accountId];
    if (explicit === "monthly") return "monthly";
    if (explicit === "weekly") return "weekly";
    return brandByAccountId.get(accountId) === "blue" ? "monthly" : "weekly";
  };

  return { cardRows, brandByAccountId, nameMap, excludedTxnIds, cadenceFor };
}
