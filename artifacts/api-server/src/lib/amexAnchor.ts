import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  transactionsTable,
  settingsTable,
  budgetCategoriesTable,
} from "@workspace/db";
import {
  isRealSpend,
  spendAmount,
  type SpendContext,
} from "./spendingFilter";
import { findSupersededPendingForRange, notCountedIdsOf } from "./supersededPending";
import { cleanMerchant } from "./merchantNameExtract";
import { parseISO, fmtISO, addDays, weekStartFor, weekEndFor } from "./cashSignal";
import { householdTodayDate } from "./householdClock";
import { classifyCardCredit, creditAmount, normalizeCardAmount } from "@workspace/avalanche-core";
import {
  classifyAmexBrand,
  discoverAmexCards,
  type AmexBrand,
  type AmexCardCadence,
} from "./amexCardCadence";

// Re-exported for backward compatibility: both used to be defined here.
export { classifyAmexBrand, type AmexBrand };

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
 * ⭐ (WP2) WHICH DEBT — exactly one, or none (`pickAnchorDebt`). This used to
 * compare the debts' INTERNAL `plaid_account_id` (a uuid) with the EXTERNAL
 * Plaid account ids the Amex rows carry, which can never match, so it always
 * fell through to "the first debt named like amex" — an arbitrary row (a manual
 * decoy, the other card) whose balance it then overwrote. Now:
 *   - the rows' external ids resolve to `plaid_accounts.id` first; a debt
 *     linked to one of those accounts is a candidate, and only a SOLE linked
 *     candidate is written (two linked cards share one combined anchor, which
 *     is neither card's balance);
 *   - a debt whose balance Plaid owns (`balanceSource = 'plaid'`) is never
 *     overwritten unless `adopt`;
 *   - the name match runs only when no debt is linked to those accounts, only
 *     among debts linked to NO account, and only when it names one debt.
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

  // (PR-D) Summed PER SOURCE, then put on one sign (`normalizeCardAmount`):
  // the workbook stores a charge positive, Plaid negative. Summing the raw
  // column across both netted a charge in one against a charge in the other,
  // and gave a Plaid-only household a negative "balance".
  const bySource = await exec
    .select({
      source: transactionsTable.source,
      net: sql<string>`coalesce(sum(${transactionsTable.amount})::text, '0')`,
      cnt: sql<number>`count(*)::int`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        inArray(transactionsTable.source, [...AMEX_TXN_SOURCES]),
      ),
    )
    .groupBy(transactionsTable.source);
  const txnCount = bySource.reduce((n, r) => n + Number(r.cnt ?? 0), 0);
  if (txnCount === 0) {
    return { changed: false, updatedDebt: false, balance: null, asOf, txnCount: 0 };
  }
  const balanceCents = bySource.reduce(
    (c, r) => c + Math.round(normalizeCardAmount(r.source, r.net) * 100),
    0,
  );
  const balance = balanceCents / 100;
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

  // (WP2) External → internal: `transactions.plaid_account_id` holds Plaid's
  // account_id; `debts.plaid_account_id` holds the `plaid_accounts.id` uuid.
  // (B5) `inArray` binds the list (a raw `= ANY(${ids})` was refused).
  const internalIds =
    amexPlaidAccountIds.length > 0
      ? (
          await exec
            .select({ id: plaidAccountsTable.id })
            .from(plaidAccountsTable)
            .where(inArray(plaidAccountsTable.accountId, amexPlaidAccountIds))
        ).map((r) => r.id)
      : [];
  const userDebts = await exec
    .select({
      id: debtsTable.id,
      name: debtsTable.name,
      balance: debtsTable.balance,
      plaidAccountId: debtsTable.plaidAccountId,
      balanceSource: debtsTable.balanceSource,
    })
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId));
  const picked = pickAnchorDebt(userDebts, internalIds, adopt);
  const debt = picked.debt;

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

/** (WP2) A debt row, as `pickAnchorDebt` reads it. */
export type AnchorDebtCandidate = {
  id: string;
  name: string;
  balance: string;
  plaidAccountId: string | null;
  balanceSource: string;
};

const AMEX_NAME = /(amex|american\s*express)/i;

/**
 * (WP2) The ONE debt the Amex anchor may write, or none — see
 * `refreshAmexAnchor`. `internalAccountIds` are the `plaid_accounts.id`s of
 * the accounts the Amex rows came from. Pure.
 */
export function pickAnchorDebt(
  debts: readonly AnchorDebtCandidate[],
  internalAccountIds: readonly string[],
  adopt: boolean,
): { debt: AnchorDebtCandidate | null; reason: "linked" | "name" | "ambiguous_linked" | "plaid_owned" | "ambiguous_name" | "none" } {
  const accounts = new Set(internalAccountIds);
  const linked = debts.filter((d) => !!d.plaidAccountId && accounts.has(d.plaidAccountId));
  if (linked.length > 1) return { debt: null, reason: "ambiguous_linked" };
  if (linked.length === 1) {
    const d = linked[0]!;
    if (d.balanceSource === "plaid" && !adopt) return { debt: null, reason: "plaid_owned" };
    return { debt: d, reason: "linked" };
  }
  const byName = debts.filter((d) => !d.plaidAccountId && AMEX_NAME.test(d.name));
  if (byName.length > 1) return { debt: null, reason: "ambiguous_name" };
  if (byName.length === 0) return { debt: null, reason: "none" };
  const d = byName[0]!;
  if (d.balanceSource === "plaid" && !adopt) return { debt: null, reason: "plaid_owned" };
  return { debt: d, reason: "name" };
}

// ---------------------------------------------------------------------------
// (#weekly-payoff) Per-card weekly payoff engine — what to pay, per physical
// Amex card (Blue / Silver / Gold), for one Sun–Sat week.
// ---------------------------------------------------------------------------

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

/**
 * (S5) An Amex card tracked as a debt: left out of `cards` (it is paid through
 * the payoff plan, not the weekly band), listed here so the Amex page can still
 * offer it. Identity only — no figure.
 */
export interface AmexDebtLinkedCard {
  accountId: string; // external Plaid account_id
  name: string;
  mask: string | null;
  debtId: string;
  brand: AmexBrand;
  cadence: "weekly" | "monthly";
  displayName: string | null;
}

export interface AmexWeeklyPayoff {
  weekStart: string;
  weekEnd: string;
  cards: AmexWeeklyPayoffCard[];
  combinedWeekCharges: number;
  combinedStatementBalance: number;
  /** (S5) Additive: the debt-linked cards `cards` leaves out. `cards` and the combined totals are unchanged. */
  debtLinkedCards: AmexDebtLinkedCard[];
}

/** (S5) What the card's payoff and summary ask of the one spending rule: a reimbursable charge is still owed to the card. */
export const CARD_OWED = { reimbursableIsSpend: true } as const;

/** A row on a card, as the payoff rule reads it. */
type CardRuleRow = Parameters<typeof classifyCardCredit>[0] & { id: string };

/**
 * ⭐ WHAT ONE CARD ROW DOES TO WHAT THE CARD IS OWED — the payoff's per-row
 * rule, moved verbatim out of `computeWeeklyPayoff` (F1) so the everyday hooks'
 * obligations (`readCardPeriods`) read every row exactly as the Amex page does:
 *   - a "not mine" row (`amexExcludedTxnIds`) and a pending row its posted row
 *     replaced (PR7b: counted once, on the posted row) → nothing; (F6 round 3)
 *     so is an expired hold or its reversal — `replacedPendingIds` is the
 *     read's `notCountedIdsOf` (replaced ∪ expired);
 *   - (PR7) the one spending rule, with one exception: a reimbursable charge is
 *     still owed to Amex. (S5) Through `classifyCardCredit`, the card summary's
 *     own rule: "purchase" is `classifyOutflow(…).kind === "spend"` and "refund"
 *     is `classifyRefund` — so GET /amex/summary's purchases − refunds for a
 *     card's billing window IS its `weekCharges` (before the floor);
 *   - `allCoverages` (the hooks, and the card page since WP8): every purchase,
 *     filed or not; otherwise categorized real spend only (`isRealSpend`);
 *   - (B6) a refund, filed or not, is money back on the card.
 */
export function cardRowOwed(
  t: CardRuleRow,
  o: { ctx: SpendContext; excludedTxnIds: ReadonlySet<string>; replacedPendingIds: ReadonlySet<string>; allCoverages: boolean },
): { kind: "charge" | "refund"; amount: number } | null {
  if (o.excludedTxnIds.has(t.id)) return null;
  if (o.replacedPendingIds.has(t.id)) return null;
  const kind = classifyCardCredit(t, o.ctx, CARD_OWED);
  const owed = o.allCoverages ? kind === "purchase" : isRealSpend(t, o.ctx, CARD_OWED);
  if (owed) return { kind: "charge", amount: spendAmount(t) };
  if (kind === "refund") return { kind: "refund", amount: creditAmount(t) };
  return null;
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
 *
 * ⭐ (B6) Refunds net: a credit on the card that `classifyRefund` calls a
 * refund (with `reimbursableIsSpend`, as the charges) takes its amount off that
 * card's charges for the window it is DATED in, filed or not — the card owes
 * that much less — and never below zero. A refund dated after a week closed is
 * in the next week's window, so it nets that week, never the closed one.
 * `chargeCount` and `topMerchant` stay the charges themselves.
 */
export async function computeWeeklyPayoff(
  householdId: string,
  weekStartArg?: string,
  ownerUserId?: string,
  opts: {
    /**
     * ⭐ (PR-B2, decision 7) Every purchase on the card, filed or not — what the
     * forecast's everyday hooks owe the card. An unfiled charge is still owed,
     * and the hooks' remaining allowance already counts it as spent, so leaving
     * it out of the charges would read HIGH by exactly that charge.
     * (WP8, owner's decision 2026-10-10) `GET /amex/weekly-payoff` — the card
     * page — passes it too, so the page's "this week's charges" and the
     * Saturday payoff are one figure. `false` (categorized real spend only) is
     * kept for a caller that asks for it; none does today.
     */
    allCoverages?: boolean;
  } = {},
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

  // Card discovery + cadence (`amexCardCadence.ts`) — moved verbatim, and
  // shared with `moneyContext.ts`'s cadence map so the two can never disagree
  // on which cards exist or how they bill.
  const { cardRows, nameMap, excludedTxnIds, cadenceFor } = await discoverAmexCards(
    householdId,
    ownerUserId,
  );
  const windowFor = (accountId: string) =>
    cadenceFor(accountId) === "monthly"
      ? { start: monthStart, end: monthEnd }
      : { start: weekStart, end: weekEnd };

  if (cardRows.length === 0) {
    return {
      weekStart,
      weekEnd,
      cards: [],
      combinedWeekCharges: 0,
      combinedStatementBalance: 0,
      debtLinkedCards: [],
    };
  }

  const externalIds = cardRows.map((c) => c.accountId).filter((v): v is string => !!v);
  const internalIds = cardRows.map((c) => c.internalId);

  // ⭐ (P2) The four reads below depend only on the cards found above, never
  // on each other: they run at once (they used to run one after the other).
  // Each result is used exactly where its read used to be.
  const [cats, debtRows, txns, replacedPendingIds] = await Promise.all([
    // --- SpendContext (categories + debt linkage), same shape as the reports
    //     pipeline so isRealSpend behaves identically. ---------------------
    db
      .select({
        id: budgetCategoriesTable.id,
        name: budgetCategoriesTable.name,
        debtId: budgetCategoriesTable.debtId,
        kind: budgetCategoriesTable.kind,
      })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, householdId)),
    // --- Per-card debt rows (for statement fallback + debtId) ---------------
    internalIds.length > 0
      ? db
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
      : Promise.resolve([]),
    // --- This week's transactions on these cards -----------------------------
    // `transactions.plaid_account_id` stores the EXTERNAL Plaid account_id
    // string (see routes/amex.ts #748), so we key on the external ids.
    externalIds.length > 0
      ? db
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
      : Promise.resolve([]),
    // (PR7b) A pending charge its posted row replaced is owed once, not twice.
    // ⭐ (P2) The whole-ledger answer for the rows read above — every one is
    // dated in [queryStart, queryEnd] — without reading the whole ledger
    // (`findSupersededPendingForRange`, exact for every row in its range; it
    // replaces `loadSupersededPendingIds`, the full-history pairing, which this
    // ran once per hook period on every forecast build).
    externalIds.length > 0
      ? findSupersededPendingForRange(householdId, queryStart, queryEnd).then(notCountedIdsOf)
      : Promise.resolve(new Set<string>()),
  ]);
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

  // (P2) `debtRows` is read above.
  const debtByInternalId = new Map<string, { id: string; balance: string }>();
  for (const d of debtRows) {
    if (d.plaidAccountId) debtByInternalId.set(d.plaidAccountId, { id: d.id, balance: d.balance });
  }

  // (P2) `txns` and `replacedPendingIds` are read above.
  type Agg = { charges: number; refunds: number; count: number; top: { name: string; amount: number } | null };
  const byCard = new Map<string, Agg>();
  for (const ext of externalIds) byCard.set(ext, { charges: 0, refunds: 0, count: 0, top: null });
  for (const t of txns) {
    if (!t.plaidAccountId) continue;
    const agg = byCard.get(t.plaidAccountId);
    if (!agg) continue;
    // Only count charges inside THIS card's billing window (week or month).
    const win = windowFor(t.plaidAccountId);
    if (t.occurredOn < win.start || t.occurredOn > win.end) continue;
    // (F1) The per-row rule is `cardRowOwed`, shared with `readCardPeriods`
    // (the hooks' obligations) so the two can never disagree on a row.
    const owed = cardRowOwed(t, { ctx, excludedTxnIds, replacedPendingIds, allCoverages: opts.allCoverages === true });
    if (!owed) continue;
    if (owed.kind === "refund") {
      // (B6) Money back on the card, filed or not, on the page and the payoff alike.
      agg.refunds += owed.amount;
      continue;
    }
    const amt = owed.amount;
    agg.charges += amt;
    agg.count += 1;
    if (!agg.top || amt > agg.top.amount) {
      agg.top = { name: cleanMerchant(t.description), amount: amt };
    }
  }

  // --- Assemble per-card payoff rows ---------------------------------------
  const cards: AmexWeeklyPayoffCard[] = cardRows.map((c) => {
    const raw = byCard.get(c.accountId) ?? { charges: 0, refunds: 0, count: 0, top: null };
    // (B6) Charges less refunds, in whole cents, never below zero. A card with
    // no refund keeps its charges exactly as before.
    const agg =
      raw.refunds > 0
        ? { ...raw, charges: Math.max(0, Math.round(raw.charges * 100) - Math.round(raw.refunds * 100)) / 100 }
        : raw;
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

  // (S5) The cards `bandCards` dropped, by identity only, so the Amex page can
  // still list them. Nothing above reads this; `cards` and the totals are as before.
  const maskOf = new Map(cardRows.map((c) => [c.accountId, c.mask ?? null]));
  const debtLinkedCards: AmexDebtLinkedCard[] = cards
    .filter((c): c is AmexWeeklyPayoffCard & { debtId: string } => c.debtId != null)
    .map((c) => ({
      accountId: c.accountId,
      name: c.name,
      mask: maskOf.get(c.accountId) ?? null,
      debtId: c.debtId,
      brand: c.brand,
      cadence: c.cadence,
      displayName: c.displayName,
    }));

  return {
    weekStart,
    weekEnd,
    cards: bandCards,
    combinedWeekCharges,
    combinedStatementBalance,
    debtLinkedCards,
  };
}

// ---------------------------------------------------------------------------
// ⭐ (F1) THE CARDS' OBLIGATIONS FOR THE EVERYDAY HOOKS — every Amex card, every
// hook period, in ONE read. `computeWeeklyPayoff` answers one week (and it
// leaves out every debt-linked card); the hooks need each card's own figure for
// several periods and choose the cards themselves, by payoff mode
// (`cardPayoffMode.ts`). The per-row rule is `cardRowOwed` — the payoff's own —
// so for any card and any of its billing windows, `charges` here IS that card's
// `weekCharges` in cents (proven on the rich fixture, every week).
// ---------------------------------------------------------------------------

/** A period a hook bills: the cards of `cadence` over [start, end]. */
export interface CardPeriod {
  cadence: "weekly" | "monthly";
  start: string;
  end: string;
}

/** A payment credit on a card's own ledger ("ONLINE PAYMENT - THANK YOU"). */
export interface CardPaymentCredit {
  txnId: string;
  /** External account id. */
  accountId: string;
  occurredOn: string;
  cents: number;
  /**
   * (F5 round 3) Still pending, and when H2 stored it: the card balance cap
   * reads a credit outside the balance by the same rule as a purchase (core
   * `outsideCardBalanceRead`).
   */
  pending?: boolean;
  createdAt?: string | null;
}

/** (F5 round 3) One purchase (+) or refund (−) on a card, as the obligations and the balance cap read it. */
export interface CardRowEffect {
  txnId: string;
  on: string;
  cents: number;
  pending: boolean;
  /** When H2 stored the row (ISO instant). */
  createdAt: string | null;
}

export interface CardPeriodsRead {
  /** `${cadence}|${start}` → external account id → purchases − refunds in cents (≥ 0), for every card of that cadence. */
  charges: Map<string, Map<string, number>>;
  /** Payment credits on any card dated in [creditsFrom, creditsTo] (pending → posted once, "not mine" out). */
  paymentCredits: CardPaymentCredit[];
  /**
   * (F5 round 2) Every purchase (+) and refund (−) on each card in the read, by
   * `cardRowOwed` — the very rows `charges` sums — with its day and whether it
   * is still pending; (round 3) its id and when H2 stored it. External account
   * id → rows, oldest first.
   */
  rows?: Map<string, CardRowEffect[]>;
  /** (F5 round 2) The first day the read covers (null: nothing was read). */
  readFrom?: string | null;
}

/**
 * ⭐ Each card's purchases − refunds (per card, never below zero — B6) in each
 * period of its own cadence, and the payment credits on the cards' own ledgers.
 * Read-only: one row read, one pending-pair read, one category read.
 */
export async function readCardPeriods(
  householdId: string,
  roster: Pick<AmexCardCadence, "cardRows" | "excludedTxnIds" | "cadenceFor">,
  periods: readonly CardPeriod[],
  credits: { from: string; to: string } | null,
): Promise<CardPeriodsRead> {
  const charges = new Map<string, Map<string, number>>();
  const externalIds = roster.cardRows.map((c) => c.accountId).filter((v): v is string => !!v);
  if (externalIds.length === 0 || (periods.length === 0 && !credits)) return { charges, paymentCredits: [], rows: new Map(), readFrom: null };
  const bounds = [...periods.flatMap((p) => [p.start, p.end]), ...(credits ? [credits.from, credits.to] : [])].sort();
  const from = bounds[0]!;
  const to = bounds[bounds.length - 1]!;
  const [cats, txns, replacedPendingIds] = await Promise.all([
    db
      .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name, debtId: budgetCategoriesTable.debtId, kind: budgetCategoriesTable.kind })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, householdId)),
    db
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
        pending: transactionsTable.pending,
        createdAt: transactionsTable.createdAt,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          inArray(transactionsTable.plaidAccountId, externalIds),
          gte(transactionsTable.occurredOn, from),
          lte(transactionsTable.occurredOn, to),
        ),
      ),
    // ⭐ (F6 round 3) Replaced pending rows AND expired holds with their
    // reversals (`notCountedIdsOf`): out of the charges, the payment credits and
    // the rows the card cap reads — neither added to nor taken off owed-now.
    findSupersededPendingForRange(householdId, from, to).then(notCountedIdsOf),
  ]);
  const categoriesById = new Map<string, { name: string; debtId: string | null; kind: string }>();
  const debtCategoryIds = new Set<string>();
  for (const c of cats) {
    categoriesById.set(c.id, { name: c.name, debtId: c.debtId, kind: c.kind });
    if (c.debtId) debtCategoryIds.add(c.id);
  }
  const rule = { ctx: { categoriesById, debtCategoryIds } as SpendContext, excludedTxnIds: roster.excludedTxnIds, replacedPendingIds, allCoverages: true };

  // Each row's effect once, by card.
  type Effect = { txnId: string; on: string; kind: "charge" | "refund"; cents: number; pending: boolean; createdAt: string | null };
  const byCard = new Map<string, Effect[]>(externalIds.map((id) => [id, []]));
  const paymentCredits: CardPaymentCredit[] = [];
  const createdIso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
  for (const t of txns) {
    if (!t.plaidAccountId || !byCard.has(t.plaidAccountId)) continue;
    const owed = cardRowOwed(t, rule);
    if (owed) {
      byCard.get(t.plaidAccountId)!.push({
        txnId: t.id,
        on: t.occurredOn,
        kind: owed.kind,
        cents: Math.round(owed.amount * 100),
        pending: t.pending === true,
        createdAt: createdIso(t.createdAt),
      });
      continue;
    }
    if (!credits || t.occurredOn < credits.from || t.occurredOn > credits.to) continue;
    if (roster.excludedTxnIds.has(t.id) || replacedPendingIds.has(t.id)) continue;
    if (classifyCardCredit(t, rule.ctx, CARD_OWED) !== "payment") continue;
    const cents = Math.round(creditAmount(t) * 100);
    if (cents > 0) {
      paymentCredits.push({
        txnId: t.id,
        accountId: t.plaidAccountId,
        occurredOn: t.occurredOn,
        cents,
        pending: t.pending === true,
        createdAt: createdIso(t.createdAt),
      });
    }
  }
  for (const p of periods) {
    const perCard = new Map<string, number>();
    for (const accountId of externalIds) {
      if (roster.cadenceFor(accountId) !== p.cadence) continue;
      let charge = 0;
      let refund = 0;
      for (const e of byCard.get(accountId)!) {
        if (e.on < p.start || e.on > p.end) continue;
        if (e.kind === "charge") charge += e.cents;
        else refund += e.cents;
      }
      perCard.set(accountId, Math.max(0, charge - refund));
    }
    charges.set(`${p.cadence}|${p.start}`, perCard);
  }
  paymentCredits.sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.txnId < b.txnId ? -1 : 1));
  const rows = new Map<string, CardRowEffect[]>();
  for (const [accountId, effects] of byCard) {
    rows.set(
      accountId,
      effects
        .map((e) => ({
          txnId: e.txnId,
          on: e.on,
          cents: e.kind === "charge" ? e.cents : -e.cents,
          pending: e.pending,
          createdAt: e.createdAt,
        }))
        .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0)),
    );
  }
  return { charges, paymentCredits, rows, readFrom: from };
}
