import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  settingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  budgetCategoriesTable,
  householdsTable,
} from "@workspace/db";
import {
  isRealSpend,
  spendAmount,
  type SpendContext,
} from "./spendingFilter";
import { loadSupersededPendingIds } from "./supersededPending";
import { cleanMerchant } from "./merchantNameExtract";
import { parseISO, fmtISO, addDays, weekStartFor, weekEndFor } from "./cashSignal";
import { householdTodayDate } from "./householdClock";

/**
 * Source values that count as Amex when computing the anchor. The legacy
 * workbook importer writes "amex"; Plaid items for American Express (slug
 * "amex" — see lib/plaid.ts SLUG_OVERRIDES) write "plaid:amex". Both must
 * contribute to the ending-balance math.
 */
export const AMEX_TXN_SOURCES = ["amex", "plaid:amex"] as const;

/**
 * Drizzle's transaction callback parameter type. Both `db` and a `tx`
 * accepted here so callers can run the refresh inside an existing
 * transaction (workbook re-import) or stand-alone (post-Plaid sync).
 */
type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AmexAnchorRefreshResult = {
  /** The estimate was written to `settings.preferences.amexAnchor`. */
  changed: boolean;
  /** The estimate: every Amex row summed. Null when there are none. */
  balance: number | null;
  asOf: string;
  txnCount: number;
  /** Plaid `account_id`s behind the Amex rows that resolve to a `plaid_accounts` row. */
  accountIds: string[];
  /** Debts linked to those accounts. Reported, never written. */
  linkedDebtIds: string[];
  /** The stored anchor was entered by hand, so its balance and asOf were kept. */
  keptEnteredAnchor: boolean;
};

type StoredAnchor = Record<string, unknown> & {
  balance?: unknown;
  lastAutoBalance?: unknown;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Whether the stored anchor's `balance` is this refresh's own last write, so
 * the refresh may move it. Only the refresh writes `lastAutoBalance`, and always
 * equal to `balance`; POST /amex/anchor and scripts/src/restoreAmexAnchor.ts
 * replace the whole object without it. So:
 *   - no anchor, or no balance in it  → owned (nothing to preserve);
 *   - `lastAutoBalance` equal to `balance` → owned (the refresh wrote it);
 *   - anything else (typed in, or origin unknown) → NOT owned, kept as it is.
 */
export function anchorBalanceIsRefreshOwned(stored: unknown): boolean {
  if (!isPlainObject(stored)) return true;
  const a = stored as StoredAnchor;
  if (a.balance === undefined || a.balance === null) return true;
  if (a.lastAutoBalance === undefined || a.lastAutoBalance === null) return false;
  const b = Number(a.balance);
  const l = Number(a.lastAutoBalance);
  return Number.isFinite(b) && Number.isFinite(l) && Math.abs(b - l) < 0.005;
}

/**
 * Recompute the Amex estimate (every `source in ('amex','plaid:amex')` row
 * summed) and keep it in `settings.preferences.amexAnchor`.
 *
 * ⚠️ IT NEVER WRITES A DEBT BALANCE (PR-E, owner decision 2). It used to move a
 * debt matched by name — the first debt called "Amex"/"American Express", with
 * no ORDER BY — to the all-card sum. A debt's bank balance comes only from
 * Plaid liabilities (`applyLiabilityToDebt`), and a balance someone entered
 * changes only when they say so (PATCH, or POST /debts/:id/use-bank-balance).
 *
 * What it writes, under a row lock, merged into the one key:
 *   - always `computedBalance` / `computedAsOf` / `computedTxnCount` (the
 *     estimate), and it clears a recorded `refreshError` / `refreshFailedAt`;
 *   - `balance` / `asOf` / `lastAutoBalance` only when the stored balance is its
 *     own last write (`anchorBalanceIsRefreshOwned`). A balance typed in through
 *     POST /amex/anchor is kept.
 *
 * Returns `{ changed: false, balance: null }` when there are no Amex rows yet.
 */
export async function refreshAmexAnchor(
  userId: string,
  exec: Exec = db,
): Promise<AmexAnchorRefreshResult> {
  const asOf = new Date().toISOString();

  const [agg] = await exec
    .select({
      net: sql<string>`coalesce(sum(${transactionsTable.amount})::text, '0')`,
      cnt: sql<number>`count(*)::int`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
      ),
    );
  const txnCount = Number(agg?.cnt ?? 0);
  if (txnCount === 0) {
    return {
      changed: false,
      balance: null,
      asOf,
      txnCount: 0,
      accountIds: [],
      linkedDebtIds: [],
      keptEnteredAnchor: false,
    };
  }
  const balance = Number(agg!.net);

  // Which accounts, and which debts, sit behind these rows. Reported only.
  // ⚠️ `transactions.plaid_account_id` holds Plaid's text `account_id`, while
  // `debts.plaid_account_id` is the `plaid_accounts.id` uuid, so the two only
  // meet through `plaid_accounts.account_id`. (The old lookup compared them
  // directly, inside `ANY(${array})`, which Postgres rejected outright.)
  // Scoped to the owner's household: a debt a member linked counts, and no
  // other household's account or debt can.
  const [household] = await exec
    .select({ id: householdsTable.id })
    .from(householdsTable)
    .where(eq(householdsTable.ownerUserId, userId));
  const linkRows = household
    ? await exec
        .selectDistinct({
          accountId: plaidAccountsTable.accountId,
          debtId: debtsTable.id,
        })
        .from(transactionsTable)
        .innerJoin(
          plaidAccountsTable,
          and(
            eq(plaidAccountsTable.accountId, transactionsTable.plaidAccountId),
            eq(plaidAccountsTable.householdId, household.id),
          ),
        )
        .leftJoin(
          debtsTable,
          and(
            eq(debtsTable.plaidAccountId, plaidAccountsTable.id),
            eq(debtsTable.householdId, household.id),
          ),
        )
        .where(
          and(
            eq(transactionsTable.userId, userId),
            inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
          ),
        )
    : [];
  const accountIds = [...new Set(linkRows.map((r) => r.accountId))].sort();
  const linkedDebtIds = [
    ...new Set(linkRows.map((r) => r.debtId).filter((v): v is string => !!v)),
  ].sort();

  const estimate = {
    computedBalance: balance,
    computedAsOf: asOf,
    computedTxnCount: txnCount,
  };
  let keptEnteredAnchor = false;
  // A transaction on `db`, a savepoint inside a caller's transaction. The lock
  // means a POST /amex/anchor or PUT /settings landing between the read and the
  // write is read here, never written over.
  await exec.transaction(async (t) => {
    await t
      .insert(settingsTable)
      .values({ userId, preferences: {} })
      .onConflictDoNothing({ target: settingsTable.userId });
    const [row] = await t
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, userId))
      .for("update");
    const storedPrefs: unknown = row?.preferences;
    const stored = isPlainObject(storedPrefs) ? storedPrefs.amexAnchor : undefined;
    let next: Record<string, unknown>;
    if (anchorBalanceIsRefreshOwned(stored)) {
      next = { balance, asOf, lastAutoBalance: balance, ...estimate };
    } else {
      keptEnteredAnchor = true;
      const kept = { ...(stored as Record<string, unknown>) };
      delete kept.refreshError;
      delete kept.refreshFailedAt;
      next = { ...kept, ...estimate };
    }
    await t
      .update(settingsTable)
      .set({
        preferences: sql`jsonb_set(coalesce(${settingsTable.preferences}, '{}'::jsonb), '{amexAnchor}', ${JSON.stringify(next)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(settingsTable.userId, userId));
  });

  return {
    changed: true,
    balance,
    asOf,
    txnCount,
    accountIds,
    linkedDebtIds,
    keptEnteredAnchor,
  };
}

/**
 * Record a failed estimate refresh on `settings.preferences.amexAnchor` as
 * `refreshError` + `refreshFailedAt`, merged into whatever the key holds, in
 * one statement. The next successful refresh clears both. Never touches a debt.
 */
export async function recordAmexAnchorRefreshFailure(
  userId: string,
  message: string,
  exec: Exec = db,
): Promise<void> {
  const failure = {
    refreshError: message.slice(0, 500),
    refreshFailedAt: new Date().toISOString(),
  };
  const payload = JSON.stringify(failure);
  await exec
    .insert(settingsTable)
    .values({ userId, preferences: { amexAnchor: failure } })
    .onConflictDoUpdate({
      target: settingsTable.userId,
      set: {
        preferences: sql`jsonb_set(
          coalesce(${settingsTable.preferences}, '{}'::jsonb),
          '{amexAnchor}',
          (case when jsonb_typeof(${settingsTable.preferences} -> 'amexAnchor') = 'object'
                then ${settingsTable.preferences} -> 'amexAnchor'
                else '{}'::jsonb end) || ${payload}::jsonb
        )`,
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// (#weekly-payoff) Per-card weekly payoff engine — what to pay, per physical
// Amex card (Blue / Silver / Gold), for one Sun–Sat week.
// ---------------------------------------------------------------------------

export type AmexBrand = "blue" | "silver";

/**
 * Classify a physical Amex card into its brand identity from its display name
 * (and mask, defensively). Mirrors the name-regex matching style used by the
 * anchor resolution above (#748).
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

export interface AmexWeeklyPayoffCard {
  accountId: string; // external Plaid account_id
  plaidAccountId: string | null; // internal plaid_accounts.id UUID
  debtId: string | null;
  name: string;
  brand: AmexBrand;
  cadence: "weekly" | "monthly";
  periodLabel: string;
  displayName: string | null;
  weekCharges: number;
  chargeCount: number;
  statementBalance: number;
  pctOfStatementThisWeek: number;
  topMerchant: { name: string; amount: number } | null;
}

export interface AmexWeeklyPayoff {
  weekStart: string;
  weekEnd: string;
  cards: AmexWeeklyPayoffCard[];
  combinedWeekCharges: number;
  combinedStatementBalance: number;
}

/** Default `weekStart` = the Sunday of the last fully-completed Sun–Sat week. */
export function lastCompletedWeekStart(today: Date = householdTodayDate()): string {
  const thisWeekSunday = weekStartFor(today);
  return fmtISO(addDays(parseISO(thisWeekSunday), -7));
}

/**
 * Compute, for each physical Amex card, the real charges that landed in the
 * given week + statement context. Read-only. `weekCharges` reuses the exact
 * `isRealSpend` / `spendAmount` definition the Spending report uses — card
 * payments, transfers, and debt-category rows are excluded, never recomputed
 * here.
 */
export async function computeWeeklyPayoff(
  householdId: string,
  weekStartArg?: string,
  ownerUserId?: string,
): Promise<AmexWeeklyPayoff> {
  const weekStart =
    weekStartArg && /^\d{4}-\d{2}-\d{2}$/.test(weekStartArg)
      ? weekStartFor(weekStartArg)
      : lastCompletedWeekStart();
  const weekEnd = weekEndFor(weekStart);

  // Monthly-cadence cards bill over the calendar month of the selected week.
  const ws = parseISO(weekStart);
  const monthStart = fmtISO(new Date(ws.getFullYear(), ws.getMonth(), 1));
  const monthEnd = fmtISO(new Date(ws.getFullYear(), ws.getMonth() + 1, 0));
  // One query window covering both the week and the month (a week can straddle
  // a month boundary) feeds weekly and monthly cards alike.
  const queryStart = monthStart < weekStart ? monthStart : weekStart;
  const queryEnd = monthEnd > weekEnd ? monthEnd : weekEnd;

  // Per-card config (cadence + display name) from the owner's settings.
  // Grouping/display metadata only — never changes a charge amount.
  let cadenceMap: Record<string, string> = {};
  let nameMap: Record<string, string> = {};
  // Charges the user marked "not mine" (reimbursements) — excluded from the
  // payoff sum so the per-card "to pay" reflects only household-owed money.
  let excludedTxnIds = new Set<string>();
  if (ownerUserId) {
    const [s] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerUserId));
    const prefs = (s?.preferences as Record<string, unknown> | null | undefined) ?? {};
    cadenceMap = (prefs.amexCardCadence as Record<string, string>) ?? {};
    nameMap = (prefs.amexCardNames as Record<string, string>) ?? {};
    excludedTxnIds = new Set((prefs.amexExcludedTxnIds as string[]) ?? []);
  }
  // Brand per external account_id (filled once cardRows is discovered below).
  // Drives the DEFAULT cadence when the owner hasn't set one explicitly:
  // Blue Cash bills monthly, Platinum (silver) bills weekly.
  const brandByAccountId = new Map<string, AmexBrand>();
  const cadenceFor = (accountId: string): "weekly" | "monthly" => {
    const explicit = cadenceMap[accountId];
    if (explicit === "monthly") return "monthly";
    if (explicit === "weekly") return "weekly";
    return brandByAccountId.get(accountId) === "blue" ? "monthly" : "weekly";
  };
  const windowFor = (accountId: string) =>
    cadenceFor(accountId) === "monthly"
      ? { start: monthStart, end: monthEnd }
      : { start: weekStart, end: weekEnd };

  // --- Discover the physical Amex credit cards -----------------------------
  // One Amex Plaid item = up to three physical cards (#748). Restrict to
  // credit-card sub-accounts so Membership Rewards / savings / loan
  // sub-accounts on the same login never enter the stack (mirrors the
  // anchor route's #651/#689 filter).
  const cardRows = await db
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

  if (cardRows.length === 0) {
    return {
      weekStart,
      weekEnd,
      cards: [],
      combinedWeekCharges: 0,
      combinedStatementBalance: 0,
    };
  }

  const externalIds = cardRows.map((c) => c.accountId).filter((v): v is string => !!v);
  const internalIds = cardRows.map((c) => c.internalId);

  // Populate the brand map so cadenceFor()/windowFor() can default Blue→monthly,
  // Platinum→weekly without the owner having to configure amexCardCadence.
  for (const c of cardRows) {
    if (c.accountId) brandByAccountId.set(c.accountId, classifyAmexBrand(c.name, c.mask));
  }

  // --- SpendContext (categories + debt linkage), same shape as the reports
  //     pipeline so isRealSpend behaves identically. ---------------------
  const cats = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      debtId: budgetCategoriesTable.debtId,
      kind: budgetCategoriesTable.kind,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));
  const categoriesById = new Map<
    string,
    { name: string; debtId: string | null; kind: string }
  >();
  const debtCategoryIds = new Set<string>();
  for (const c of cats) {
    categoriesById.set(c.id, { name: c.name, debtId: c.debtId, kind: c.kind });
    if (c.debtId) debtCategoryIds.add(c.id);
  }
  const ctx: SpendContext = { categoriesById, debtCategoryIds };

  // --- Per-card debt rows (for statement fallback + debtId) -----------------
  const debtRows =
    internalIds.length > 0
      ? await db
          .select({
            id: debtsTable.id,
            balance: debtsTable.balance,
            plaidAccountId: debtsTable.plaidAccountId,
          })
          .from(debtsTable)
          .where(
            and(
              eq(debtsTable.householdId, householdId),
              inArray(debtsTable.plaidAccountId, internalIds),
            ),
          )
      : [];
  const debtByInternalId = new Map<string, { id: string; balance: string }>();
  for (const d of debtRows) {
    if (d.plaidAccountId) debtByInternalId.set(d.plaidAccountId, { id: d.id, balance: d.balance });
  }

  // --- This week's transactions on these cards -----------------------------
  // `transactions.plaid_account_id` stores the EXTERNAL Plaid account_id
  // string (see routes/amex.ts #748), so we key on the external ids.
  const txns =
    externalIds.length > 0
      ? await db
          .select({
            id: transactionsTable.id,
            plaidAccountId: transactionsTable.plaidAccountId,
            occurredOn: transactionsTable.occurredOn,
            amount: transactionsTable.amount,
            source: transactionsTable.source,
            isTransfer: transactionsTable.isTransfer,
            categoryId: transactionsTable.categoryId,
            description: transactionsTable.description,
            debtId: transactionsTable.debtId,
            isExternalCardPayment: transactionsTable.isExternalCardPayment,
            reimbursable: transactionsTable.reimbursable,
            pfcDetailed: transactionsTable.pfcDetailed,
          })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              inArray(transactionsTable.plaidAccountId, externalIds),
              gte(transactionsTable.occurredOn, queryStart),
              lte(transactionsTable.occurredOn, queryEnd),
            ),
          )
      : [];

  // (PR7b) A pending charge its posted row replaced is owed once, not twice.
  const replacedPendingIds =
    externalIds.length > 0 ? await loadSupersededPendingIds(householdId) : new Set<string>();

  type Agg = { charges: number; count: number; top: { name: string; amount: number } | null };
  const byCard = new Map<string, Agg>();
  for (const ext of externalIds) byCard.set(ext, { charges: 0, count: 0, top: null });
  for (const t of txns) {
    if (!t.plaidAccountId) continue;
    const agg = byCard.get(t.plaidAccountId);
    if (!agg) continue;
    // Only count charges inside THIS card's billing window (week or month).
    const win = windowFor(t.plaidAccountId);
    if (t.occurredOn < win.start || t.occurredOn > win.end) continue;
    // Skip "not mine" charges (reimbursements) — user-excluded from payoff.
    if (excludedTxnIds.has(t.id)) continue;
    if (replacedPendingIds.has(t.id)) continue;
    // (PR7) The one spending rule, with one exception: a reimbursable charge
    // is still owed to Amex, so it stays in what to pay this card.
    if (!isRealSpend(t, ctx, { reimbursableIsSpend: true })) {
      continue;
    }
    const amt = spendAmount(t);
    agg.charges += amt;
    agg.count += 1;
    if (!agg.top || amt > agg.top.amount) {
      agg.top = { name: cleanMerchant(t.description), amount: amt };
    }
  }

  // --- Assemble per-card payoff rows ---------------------------------------
  const cards: AmexWeeklyPayoffCard[] = cardRows.map((c) => {
    const agg = byCard.get(c.accountId) ?? { charges: 0, count: 0, top: null };
    const debt = debtByInternalId.get(c.internalId) ?? null;
    const liability = c.liabilityBalance != null ? Number(c.liabilityBalance) : NaN;
    const statementBalance = Number.isFinite(liability)
      ? liability
      : debt
        ? Number(debt.balance) || 0
        : 0;
    const pct =
      statementBalance > 0
        ? Math.max(0, Math.min(1, agg.charges / statementBalance))
        : 0;
    const cadence = cadenceFor(c.accountId);
    return {
      accountId: c.accountId,
      plaidAccountId: c.internalId,
      debtId: debt?.id ?? null,
      name: c.name ?? "American Express",
      brand: classifyAmexBrand(c.name, c.mask),
      cadence,
      periodLabel: cadence === "monthly" ? "this month" : "this week",
      displayName: nameMap[c.accountId] ?? null,
      // weekCharges = real charges in this card's billing window (week or month).
      weekCharges: Math.round(agg.charges * 100) / 100,
      chargeCount: agg.count,
      statementBalance: Math.round(statementBalance * 100) / 100,
      pctOfStatementThisWeek: pct,
      topMerchant: agg.top
        ? { name: agg.top.name, amount: Math.round(agg.top.amount * 100) / 100 }
        : null,
    };
  });

  // Stable, friendly order: Blue, then Platinum.
  const order: Record<AmexBrand, number> = { blue: 0, silver: 1 };
  cards.sort((a, b) => order[a.brand] - order[b.brand]);

  // A card tracked as a debt (has a linked debt row, e.g. the Sky Card — a
  // revolving balance with interest charges) is managed in Avalanche, not the
  // weekly/monthly Amex spend band. Drop it here so it doesn't double-appear.
  const bandCards = cards.filter((c) => c.debtId == null);

  // The combined "to pay this week" total is the WEEKLY cards only; monthly
  // cards are surfaced separately (their charges sit until month-end).
  const combinedWeekCharges =
    Math.round(
      bandCards
        .filter((c) => c.cadence === "weekly")
        .reduce((s, c) => s + c.weekCharges, 0) * 100,
    ) / 100;
  const combinedStatementBalance =
    Math.round(bandCards.reduce((s, c) => s + c.statementBalance, 0) * 100) / 100;

  return {
    weekStart,
    weekEnd,
    cards: bandCards,
    combinedWeekCharges,
    combinedStatementBalance,
  };
}
