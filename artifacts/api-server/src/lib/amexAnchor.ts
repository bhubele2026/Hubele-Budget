import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  settingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  budgetCategoriesTable,
} from "@workspace/db";
import {
  isRealSpend,
  spendAmount,
  type SpendContext,
} from "./spendingFilter";
import { cleanMerchant } from "./merchantNameExtract";
import { weekStartFor, weekEndFor } from "./weeklyDebrief";
import { parseISO, fmtISO, addDays } from "./cashSignal";

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
  changed: boolean;
  updatedDebt: boolean;
  balance: number | null;
  asOf: string;
  txnCount: number;
};

/**
 * Recompute the Amex ending-balance anchor from the current set of
 * `source='amex'` transactions and persist it.
 *
 * Always writes `settings.preferences.amexAnchor` (so `GET /amex/anchor`
 * advances even if the linked debts row was manually edited).
 *
 * Updates the linked Amex debts row's `balance` only when:
 *   - `adopt: true` is passed (workbook re-import flow — the debts table was
 *     just wiped and rebuilt from the workbook, so we always re-anchor), OR
 *   - the debt's current balance still matches the previous auto-anchor
 *     value (i.e. the user has NOT manually changed it since our last
 *     auto-update).
 *
 * Otherwise the debt row is left alone — manual UI edits win.
 *
 * Returns `{ changed: false, balance: null }` when there are no
 * `source='amex'` transactions yet.
 */
export async function refreshAmexAnchor(
  userId: string,
  exec: Exec = db,
  opts: { adopt?: boolean } = {},
): Promise<AmexAnchorRefreshResult> {
  const adopt = opts.adopt === true;
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
    return { changed: false, updatedDebt: false, balance: null, asOf, txnCount: 0 };
  }
  const balance = Number(agg!.net);
  const balanceStr = balance.toFixed(2);

  // Find the Amex debt — prefer one linked to a Plaid account that has
  // produced source='amex' transactions, fall back to a name match.
  const acctRows = await exec
    .selectDistinct({ plaidAccountId: transactionsTable.plaidAccountId })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
        sql`${transactionsTable.plaidAccountId} is not null`,
      ),
    );
  const amexPlaidAccountIds = acctRows
    .map((r) => r.plaidAccountId)
    .filter((v): v is string => !!v);

  let debt: { id: string; balance: string } | undefined;
  if (amexPlaidAccountIds.length > 0) {
    const [byAcct] = await exec
      .select({ id: debtsTable.id, balance: debtsTable.balance })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, userId),
          sql`${debtsTable.plaidAccountId}::text = ANY(${amexPlaidAccountIds})`,
        ),
      )
      .limit(1);
    debt = byAcct;
  }
  if (!debt) {
    const [byName] = await exec
      .select({ id: debtsTable.id, balance: debtsTable.balance })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, userId),
          sql`${debtsTable.name} ~* '(amex|american\\s*express)'`,
        ),
      )
      .limit(1);
    debt = byName;
  }

  // Read prior anchor so we can detect manual UI overrides since the last
  // auto-update.
  const [s] = await exec
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId));
  const prefs =
    (s?.preferences as Record<string, unknown> | null | undefined) ?? {};
  const priorAnchor = (prefs as {
    amexAnchor?: { balance?: number | string; lastAutoBalance?: number | string };
  }).amexAnchor;
  const priorAuto =
    priorAnchor && priorAnchor.lastAutoBalance !== undefined
      ? Number(priorAnchor.lastAutoBalance)
      : undefined;

  let updatedDebt = false;
  if (debt) {
    const debtNum = Number(debt.balance);
    const matchesAuto =
      priorAuto === undefined || !Number.isFinite(priorAuto)
        ? true
        : Math.abs(debtNum - priorAuto) < 0.005;
    const wantsUpdate = Math.abs(debtNum - balance) >= 0.005;
    if (wantsUpdate && (adopt || matchesAuto)) {
      await exec
        .update(debtsTable)
        .set({
          balance: balanceStr,
          lastBalanceUpdate: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(debtsTable.id, debt.id));
      updatedDebt = true;
    }
  }

  const nextPrefs = {
    ...prefs,
    amexAnchor: { balance, asOf, lastAutoBalance: balance },
  };
  if (s) {
    await exec
      .update(settingsTable)
      .set({ preferences: nextPrefs, updatedAt: new Date() })
      .where(eq(settingsTable.userId, userId));
  } else {
    await exec
      .insert(settingsTable)
      .values({ userId, preferences: nextPrefs })
      .onConflictDoUpdate({
        target: settingsTable.userId,
        set: { preferences: nextPrefs, updatedAt: new Date() },
      });
  }

  return { changed: true, updatedDebt, balance, asOf, txnCount };
}

// ---------------------------------------------------------------------------
// (#weekly-payoff) Per-card weekly payoff engine — what to pay, per physical
// Amex card (Blue / Silver / Gold), for one Sun–Sat week.
// ---------------------------------------------------------------------------

export type AmexBrand = "blue" | "silver" | "gold";

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
  if (/platinum/i.test(s)) return "silver";
  if (/gold/i.test(s)) return "gold";
  // NOTE: unmatched Amex cards default to silver (neutral Platinum-style)
  // rather than dropping out of the stack entirely.
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
export function lastCompletedWeekStart(today: Date = new Date()): string {
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
  const cadenceFor = (accountId: string): "weekly" | "monthly" =>
    cadenceMap[accountId] === "monthly" ? "monthly" : "weekly";
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
    if (!isRealSpend(
      {
        amount: t.amount,
        source: t.source,
        isTransfer: t.isTransfer,
        categoryId: t.categoryId,
        description: t.description,
      },
      ctx,
    )) {
      continue;
    }
    const amt = spendAmount({
      amount: t.amount,
      source: t.source,
      isTransfer: t.isTransfer,
      categoryId: t.categoryId,
      description: t.description,
    });
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

  // Stable, friendly order: Blue, Silver, Gold.
  const order: Record<AmexBrand, number> = { blue: 0, silver: 1, gold: 2 };
  cards.sort((a, b) => order[a.brand] - order[b.brand]);

  // The combined "to pay this week" total is the WEEKLY cards only; monthly
  // cards are surfaced separately (their charges sit until month-end).
  const combinedWeekCharges =
    Math.round(
      cards
        .filter((c) => c.cadence === "weekly")
        .reduce((s, c) => s + c.weekCharges, 0) * 100,
    ) / 100;
  const combinedStatementBalance =
    Math.round(cards.reduce((s, c) => s + c.statementBalance, 0) * 100) / 100;

  return { weekStart, weekEnd, cards, combinedWeekCharges, combinedStatementBalance };
}
