// ⭐ (S5) "SAME WITH AMEX" — THE SERVER SIDE of `GET /amex/summary`.
//
// The owner: "I want to review banking and immediately see what wasn't in the
// plan. Same with Amex." One card (or every Amex card), one period. Nothing is
// computed here that another function already computes; this module reads and
// hands over:
//
//   owed           `resolveAmexAnchor` — GET /amex/anchor's own answer (per
//                  card with `?accountId=`, the combined anchor for "all"), and
//                  a debt-linked card's latest statement (`loadLatestStatements`).
//                  Unknown is null, never 0. ⭐ (Task 6, matrix) Beside it,
//                  `tracked`: the linked debt's balance as the DEBT PLAN counts
//                  it (`debts.balance` net of pending tagged payments —
//                  `withPendingPayments` + `effectiveDebtBalance`, GET /debts's
//                  own figure) and where it came from. Two measures: the card's
//                  own figure, and the debt row a typed (`manual`) balance
//                  keeps, which no Sync overwrites.
//   purchases …    every row on the card(s) dated in the period, once
//                  (a pending row its posted row replaced is out —
//                  `findSupersededPendingForRange` over the period, the
//                  payoff's own read, P2), each put
//                  in ONE bucket by `classifyCardCredit` with `CARD_OWED` — the
//                  very rule `computeWeeklyPayoff` bills with. So for a card's
//                  billing window, purchases − refunds IS its `weekCharges`
//                  (before the payoff's zero floor). "Not mine" rows
//                  (`preferences.amexExcludedTxnIds`) are their own bucket, as
//                  the payoff leaves them out.
//   household…     `loadAllowanceWindow` over the period with the forecast
//                  ledger's tier-2 pairs, the card's rows only (`netAccountOf`),
//                  through `allowanceRowOf` + `allowanceSpentCents` /
//                  `allowanceTotals` — the read and helpers GET
//                  /money/period-breakdown's `account=` scope uses, so for a week
//                  `weeklyPlan` IS that breakdown's `actual`. (hh-split) Each
//                  plan figure is split known / unresolved by the F2 evidence
//                  rule (`rowEvidenceOf`, the same ledger's suggestions) and
//                  `evidenceSplitCents` — the breakdown's own `known` /
//                  `unresolved` — so the line can say how much is unconfirmed.
//   planLink       a debt-linked card: its debt (minimum, place in the avalanche
//                  order). A card the everyday hook pays: the hook's payoff for
//                  the period that holds `to`, straight from the ledger's
//                  `hookPayoffs` (what `hookReserves` serves). Else none. A
//                  household allowance is never one card's plan.
//   needsAttention the period's purchases the household has not resolved, each
//                  in one group (first wins): marked unplanned (UN) · not filed
//                  to an allowance · filed but with no category. Placed by the
//                  allowance window's `classifyMovement` (effective filing: a
//                  posted row carries its pending row's filing).
//   reconciliation (Task 5) the period's purchases — the very rows
//                  `purchases` counts — each in ONE group by the same window's
//                  placement and the F2 evidence class
//                  (`reconcileAmexPurchases`, ./amexReconciliation.ts): weekly
//                  plan known / unresolved · monthly allowance known /
//                  unresolved · bills · unplanned · reimbursable · not counted
//                  · not placed. Σ groups = purchases; refunds beside.
//
// ⚠️ READ-ONLY. No write, no Plaid call, no AI.

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db, debtsTable, plaidAccountsTable, plaidItemsTable, settingsTable, transactionsTable } from "@workspace/db";
import { withPendingPayments } from "./debtPending";
import {
  HOUSEHOLD_TZ,
  addDaysISO,
  allowanceRowOf,
  allowanceTotals,
  amexCardLabel,
  classifyCardCredit,
  creditAmount,
  effectiveDebtBalance,
  evidenceSplitCents,
  netAccountOf,
  readEverydayHooks,
  spendAmount,
  type HookCadence,
  type MovementClassification,
} from "@workspace/avalanche-core";
import { CARD_OWED } from "./amexAnchor";
import { resolveAmexAnchor, type AmexAnchorAnswer } from "./amexAnchorRead";
import { discoverAmexCards, type AmexBrand, type AmexCardRow } from "./amexCardCadence";
import { reconcileAmexPurchases } from "./amexReconciliation";
import { avalancheRankOf } from "./avalancheSim";
import { loadCardPayoffModes, type CardPayoffMode, type PaidAs, type DefaultMode, type PayDown, type PayoffModeReason, type PayoffModeSource } from "./cardPayoffMode";
import { isCalendarDay } from "./bankLedger";
import { computeCashSignalDetailed } from "./cashSignal";
import { loadLatestStatements } from "./debtLedger";
import { householdTodayISO } from "./householdClock";
import { loadAllowanceWindow, type MovementRowRead } from "./moneyContext";
import { POSITION_HORIZON_DAYS, tier2PairedTxnIdsOf } from "./moneyPosition";
import { displayNameOf, loadMerchantAliases } from "./periodBreakdown";
import { billSuggestionsOf, evidenceContextOf, rowEvidenceOf } from "./rowEvidence";
import { TRACKING_START } from "./spendingFacts";
import { findSupersededPendingForRange, notCountedIdsOf } from "./supersededPending";

/** A row on a card, as this summary reads it: the spending rule's fields, identity and `pending`. */
interface CardTxn {
  id: string;
  plaidAccountId: string | null;
  occurredOn: string;
  amount: string;
  source: string;
  isTransfer: boolean;
  categoryId: string | null;
  description: string;
  debtId: string | null;
  isExternalCardPayment: boolean;
  reimbursable: boolean;
  pfcDetailed: string | null;
  pending: boolean;
}

/** A refused request: the route answers `status` with `{ error: code }`. */
export class AmexSummaryError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface AmexSummaryQuery {
  /** External Plaid `account_id` of one Amex card, or "all". */
  accountId: string;
  from: string;
  to: string;
  rowsPerGroup: number;
}

/** The longest period one request may read (as GET /banking/review). */
export const AMEX_SUMMARY_MAX_DAYS = 366;

const money = (cents: number): string => (cents / 100).toFixed(2);
const toCents = (dollars: number): number => Math.round(dollars * 100);
const centsOf = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

interface Tally {
  cents: number;
  count: number;
}
const tally = (): Tally => ({ cents: 0, count: 0 });
const add = (t: Tally, cents: number): void => {
  t.cents += cents;
  t.count += 1;
};
const amountCount = (t: Tally) => ({ amount: money(t.cents), count: t.count });

/** One card in scope, as the response names it. */
interface CardView {
  accountId: string;
  name: string;
  mask: string | null;
  institution: string | null;
  brand: AmexBrand;
  cadence: "weekly" | "monthly";
  debtLinked: boolean;
  debtId: string | null;
  /** That card's own current balance (`resolveAmexAnchor` per card); null = unknown. */
  owed: string | null;
  /**
   * (F1) How the card is paid (`cardPayoffMode.ts`): `mode` null = not chosen
   * yet (billed by the hook like in_full meanwhile); `source` says whether the
   * owner chose it or it is the default from the card's debt row.
   */
  payoffMode: { mode: CardPayoffMode | null; source: PayoffModeSource; reason: PayoffModeReason };
  /** (Q1) The one definition every screen words (`paidAsOf`); null only for a card the payoff roster does not know. */
  paidAs: PaidAs | null;
  /** (Q6b) Whether "Paying down" can take effect (the server's own rule) and why not. */
  payDown: PayDown;
  /** (Q6b r3) What "Use the default" would resolve to (mode null = it cannot tell either). */
  defaultMode: DefaultMode;
}

export type AmexAttentionFlag =
  | "reimbursable"
  | "unplanned"
  | "unfiled"
  | "uncategorized"
  | "weekly"
  | "monthly"
  | "bill_matched";

/** What a purchase was filed to, as the flags say it. */
const COVERAGE_FLAG: Partial<Record<MovementClassification["coverage"], AmexAttentionFlag>> = {
  unplanned: "unplanned",
  needs_classification: "unfiled",
  allowance_weekly: "weekly",
  allowance_monthly: "monthly",
  bill_matched: "bill_matched",
};

/** Coverages a purchase can be placed in (`classifyMovement` steps 2-7). */
const PURCHASE_COVERAGES: ReadonlySet<string> = new Set([
  "bill_matched",
  "unplanned",
  "allowance_monthly",
  "allowance_weekly",
  "reimbursable",
  "needs_classification",
]);

type AttentionGroup = "unplanned" | "unfiled" | "uncategorized";

/**
 * The plan a card answers to, flat (one shape, `kind` says which fields mean
 * something): the everyday hook that pays it (`payoff`, `payoffDate`,
 * `basis`), its debt on the payoff plan (`debtId`, `name`, `minimum`,
 * `avalancheRank`, `status`), or none.
 */
interface PlanLinkView {
  kind: "weekly_hook" | "monthly_hook" | "debt" | "none";
  payoff: string | null;
  payoffDate: string | null;
  basis: "plan" | "stored_amount" | null;
  debtId: string | null;
  name: string | null;
  minimum: string | null;
  avalancheRank: number | null;
  status: string | null;
}

const NO_PLAN_LINK: PlanLinkView = {
  kind: "none",
  payoff: null,
  payoffDate: null,
  basis: null,
  debtId: null,
  name: null,
  minimum: null,
  avalancheRank: null,
  status: null,
};

interface AttentionRow {
  id: string;
  date: string;
  displayName: string;
  cents: number;
  pending: boolean;
  category: { id: string; name: string } | null;
  flags: AmexAttentionFlag[];
  card: { accountId: string; name: string; mask: string | null };
}

/** Largest first, then newest, then id: a stable order that never depends on the read. */
const byAmount = (a: AttentionRow, b: AttentionRow): number =>
  b.cents - a.cents || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || a.id.localeCompare(b.id);

function checkPeriod(from: string, to: string, todayISO: string): { from: string; limitations: string[] } {
  if (!isCalendarDay(from) || !isCalendarDay(to)) throw new AmexSummaryError(400, "invalid_date");
  if (from > to) throw new AmexSummaryError(400, "from_after_to");
  if (from > todayISO) throw new AmexSummaryError(400, "from_in_future");
  if (to < TRACKING_START) throw new AmexSummaryError(400, "before_tracking_start");
  if (to > addDaysISO(from, AMEX_SUMMARY_MAX_DAYS - 1)) throw new AmexSummaryError(400, "range_too_long");
  // Tracking began on TRACKING_START: the period is clamped there, and says so.
  if (from < TRACKING_START) return { from: TRACKING_START, limitations: [`tracking_start:${TRACKING_START}`] };
  return { from, limitations: [] };
}

/**
 * ⭐ `GET /amex/summary`. See the file header and the AmexSummary schema.
 */
export async function buildAmexSummary(householdId: string, ownerUserId: string, q: AmexSummaryQuery) {
  const todayISO = householdTodayISO();
  const period = checkPeriod(q.from, q.to, todayISO);
  const from = period.from;
  const to = q.to;

  // ── The cards. The owner's settings row once: names, tiers, cadence, "not mine", the hooks.
  const [settingsRow] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId));
  const prefs = (settingsRow?.preferences as Record<string, unknown> | null | undefined) ?? {};
  const roster = await discoverAmexCards(householdId, ownerUserId, { preferences: prefs });
  let scopeRows: AmexCardRow[];
  if (q.accountId === "all") {
    // The payoff's order (Blue, then Platinum), then the account id: stable whatever the read.
    const rank = (c: AmexCardRow) => (roster.brandByAccountId.get(c.accountId) === "blue" ? 0 : 1);
    scopeRows = [...roster.cardRows].sort((a, b) => rank(a) - rank(b) || a.accountId.localeCompare(b.accountId));
  } else {
    const one = roster.cardRows.find((c) => c.accountId === q.accountId);
    if (!one) throw new AmexSummaryError(404, "card_not_found");
    scopeRows = [one];
  }
  const scopeIds = scopeRows.map((c) => c.accountId);
  const inScope = new Set(scopeIds);
  // (F1) How each card is paid — the hooks' own answer.
  const modeById = new Map((await loadCardPayoffModes(householdId, ownerUserId, { preferences: prefs, roster })).map((m) => [m.accountId, m] as const));

  // ── Reads that do not depend on each other.
  const cashRead = computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS });
  const [institutions, debts, txns, replacedPendingIds, aliases, cash] = await Promise.all([
    scopeRows.length > 0
      ? db
          .select({ id: plaidAccountsTable.id, institution: plaidItemsTable.institutionName })
          .from(plaidAccountsTable)
          .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
          .where(
            and(
              eq(plaidAccountsTable.householdId, householdId),
              inArray(
                plaidAccountsTable.id,
                scopeRows.map((c) => c.internalId),
              ),
            ),
          )
      : Promise.resolve([] as Array<{ id: string; institution: string | null }>),
    db
      .select({
        id: debtsTable.id,
        name: debtsTable.name,
        status: debtsTable.status,
        balance: debtsTable.balance,
        apr: debtsTable.apr,
        minPayment: debtsTable.minPayment,
        plaidAccountId: debtsTable.plaidAccountId,
      })
      .from(debtsTable)
      .where(eq(debtsTable.householdId, householdId)),
    // The period's rows on the card(s) — keyed on the external account id, as the payoff reads them.
    scopeIds.length > 0
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
            pending: transactionsTable.pending,
          })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              inArray(transactionsTable.plaidAccountId, scopeIds),
              gte(transactionsTable.occurredOn, from),
              lte(transactionsTable.occurredOn, to),
            ),
          )
      : Promise.resolve([] as CardTxn[]),
    // ⭐ (P2) The whole-ledger answer for the period's rows — every row read
    // above is dated in [from, to] — without reading the whole ledger
    // (`findSupersededPendingForRange`, exact for every row in its range).
    scopeIds.length > 0
      ? findSupersededPendingForRange(householdId, from, to).then(notCountedIdsOf)
      : Promise.resolve(new Set<string>()),
    loadMerchantAliases(householdId),
    cashRead,
  ]);
  // The allowance window: the read GET /money/period-breakdown classifies with,
  // with the same ledger's tier-2 pairs (this request's one cash signal).
  const window = await loadAllowanceWindow(householdId, { start: from, end: to }, { tier2PairedTxnIds: tier2PairedTxnIdsOf(cash.ledger) });
  const ctx = window.money;

  // ── Card identity (and each card's own balance).
  const institutionOf = new Map(institutions.map((r) => [r.id, r.institution ?? null]));
  // A card is debt-linked when a debt row points at its account — `computeWeeklyPayoff`'s own test.
  const debtByInternal = new Map(debts.filter((d) => d.plaidAccountId).map((d) => [d.plaidAccountId!, d]));
  const brands = (prefs.amexCardBrands as Record<string, string> | undefined) ?? null;
  const anchors = new Map<string, AmexAnchorAnswer>();
  const cards: CardView[] = await Promise.all(
    scopeRows.map(async (c) => {
      const debt = debtByInternal.get(c.internalId) ?? null;
      const brand = roster.brandByAccountId.get(c.accountId) ?? "silver";
      const own = await resolveAmexAnchor(householdId, ownerUserId, c.accountId);
      anchors.set(c.accountId, own);
      return {
        accountId: c.accountId,
        name: amexCardLabel({ accountId: c.accountId, serverBrand: brand, plaidName: c.name, names: roster.nameMap, brands }),
        mask: c.mask ?? null,
        institution: institutionOf.get(c.internalId) ?? null,
        brand,
        cadence: roster.cadenceFor(c.accountId),
        debtLinked: debt != null,
        debtId: debt?.id ?? null,
        owed: own.amexEndingBalance == null ? null : money(toCents(own.amexEndingBalance)),
        payoffMode: (() => {
          const m = modeById.get(c.accountId);
          return m ? { mode: m.mode, source: m.source, reason: m.reason } : { mode: null, source: "default" as const, reason: "debt_terms_missing" as const };
        })(),
        paidAs: modeById.get(c.accountId)?.paidAs ?? null,
        payDown: modeById.get(c.accountId)?.payDown ?? { available: false, reason: debt ? ("debt_terms_missing" as const) : ("no_debt" as const) },
        defaultMode: modeById.get(c.accountId)?.defaultMode ?? { mode: null, reason: "debt_terms_missing" as const },
      };
    }),
  );
  const cardById = new Map(cards.map((c) => [c.accountId, c]));

  // ── Owed: the anchor's own answer. A card's is its own; "all" is the combined anchor.
  const one = q.accountId === "all" ? null : cards[0]!;
  const anchor = one ? anchors.get(one.accountId)! : await resolveAmexAnchor(householdId, ownerUserId, null);
  const statements = one?.debtId ? await loadLatestStatements(householdId, [one.debtId]) : null;
  // ⭐ (Task 6, matrix) The debt plan's own figure for this card, beside the card's (see the header).
  let tracked: { debtId: string; name: string; balance: string; source: "plaid" | "manual"; asOf: string | null } | null = null;
  if (one?.debtId) {
    const [row] = await db.select().from(debtsTable).where(and(eq(debtsTable.id, one.debtId), eq(debtsTable.householdId, householdId)));
    if (row && row.status === "active") {
      const [netted] = await withPendingPayments(householdId, [row]);
      tracked = {
        debtId: row.id,
        name: row.name,
        balance: money(toCents(effectiveDebtBalance(netted!))),
        source: row.balanceSource === "plaid" ? "plaid" : "manual",
        asOf: (row.balanceSource === "plaid" ? row.plaidLastSyncedAt : row.lastBalanceUpdate)?.toISOString() ?? null,
      };
    }
  }
  const owed = {
    current: anchor.amexEndingBalance == null ? null : money(toCents(anchor.amexEndingBalance)),
    statement: one?.debtId ? (statements?.get(one.debtId)?.balance ?? null) : null,
    asOf: anchor.source === "missing" ? null : anchor.asOf,
    source: anchor.source,
    tracked,
  };

  // ── Every row on the card(s), once, in one bucket.
  const purchases = tally();
  const reimbursable = tally();
  const refunds = tally();
  const payments = tally();
  const otherCredits = tally();
  const otherCharges = tally();
  const notMine = tally();
  const purchaseRows: CardTxn[] = [];
  // (P3) Each card's own purchases, from the same rows and rule: a card's entry
  // IS the top-level `purchases` of that card's own summary (?accountId=<card>).
  const purchasesByCard = new Map<string, Tally>(scopeIds.map((id) => [id, tally()]));
  for (const t of txns) {
    if (!t.plaidAccountId || !inScope.has(t.plaidAccountId)) continue;
    // (PR7b) A pending charge its posted row replaced is the same charge: counted once, on the posted row.
    // ⭐ (F6 round 3) An expired hold (or its reversal) counts in no bucket (`notCountedIdsOf`).
    if (replacedPendingIds.has(t.id)) continue;
    // Marked "not mine": the payoff leaves it out, so its own bucket here (charges less credits).
    if (roster.excludedTxnIds.has(t.id)) {
      add(notMine, toCents(spendAmount(t)) - toCents(creditAmount(t)));
      continue;
    }
    const kind = classifyCardCredit(t, ctx, CARD_OWED);
    if (kind === "purchase") {
      add(purchases, toCents(spendAmount(t)));
      add(purchasesByCard.get(t.plaidAccountId)!, toCents(spendAmount(t)));
      if (t.reimbursable) add(reimbursable, toCents(spendAmount(t)));
      purchaseRows.push(t);
    } else if (kind === "other_charge") add(otherCharges, toCents(spendAmount(t)));
    else if (kind === "refund") add(refunds, toCents(creditAmount(t)));
    else if (kind === "payment") add(payments, toCents(creditAmount(t)));
    else if (kind === "other_credit") add(otherCredits, toCents(creditAmount(t)));
  }

  // ── What the card(s) added to the household's allowances: the breakdown's account scope.
  const windowRows = window.movement.filter(({ row }) => inScope.has(netAccountOf(row)));
  // (hh-split) Each row with the F2 evidence rule's class, read exactly as the
  // money position reads its week (`moneyPosition.ts`): this window's money
  // context and the bills THIS request's ledger only suggests
  // (`billSuggestionsOf` with the window's pending pairs; the ledger pairs
  // checking rows, so a card row has none today — read anyway, so the rule
  // stays the breakdown's). The pool is then
  // split by `evidenceSplitCents` — the call GET /money/period-breakdown's
  // actual / known / unresolved are — so each plan figure says how much of it
  // is unconfirmed. `actualCents` IS `allowanceSpentCents` (unchanged figures).
  const evidenceCtx = evidenceContextOf(ctx, billSuggestionsOf(cash.ledger, ctx.supersede));
  const splitRows = windowRows.map(({ row, m }) => ({
    allowance: allowanceRowOf(row, m),
    evidenceClass: rowEvidenceOf(row, m, evidenceCtx)?.class ?? null,
  }));
  const weekSplit = evidenceSplitCents(splitRows, "week");
  const monthSplit = evidenceSplitCents(splitRows, "month");
  const householdContribution = {
    weeklyPlan: money(weekSplit.actualCents),
    weeklyKnown: money(weekSplit.knownCents),
    weeklyUnresolved: money(weekSplit.unresolvedCents),
    monthlyPlan: money(monthSplit.actualCents),
    monthlyKnown: money(monthSplit.knownCents),
    monthlyUnresolved: money(monthSplit.unresolvedCents),
    unfiled: money(allowanceTotals(splitRows.map((r) => r.allowance)).unfiledCents),
    link: "/spending/week" as const,
  };

  // ── Needs attention: the period's purchases, by the window's own placement.
  const placed = new Map<string, { row: MovementRowRead; m: MovementClassification }>(windowRows.map((e) => [e.row.id, e]));
  const groups: Record<AttentionGroup, { tally: Tally; rows: AttentionRow[] }> = {
    unplanned: { tally: tally(), rows: [] },
    unfiled: { tally: tally(), rows: [] },
    uncategorized: { tally: tally(), rows: [] },
  };
  const uncategorizedIds = ctx.filingCtx.uncategorizedIds;
  for (const t of purchaseRows) {
    const w = placed.get(t.id);
    if (!w || !PURCHASE_COVERAGES.has(w.m.coverage)) continue;
    const catId = w.row.categoryId;
    const cat = catId && !uncategorizedIds.has(catId) ? ctx.categoriesById.get(catId) : undefined;
    const flags: AmexAttentionFlag[] = [];
    const coverageFlag = COVERAGE_FLAG[w.m.coverage];
    if (coverageFlag) flags.push(coverageFlag);
    if (w.row.reimbursable) flags.push("reimbursable");
    if (!cat) flags.push("uncategorized");
    const group: AttentionGroup | null =
      w.m.coverage === "unplanned" ? "unplanned" : w.m.coverage === "needs_classification" ? "unfiled" : !cat ? "uncategorized" : null;
    if (!group) continue;
    const card = cardById.get(t.plaidAccountId!)!;
    const cents = toCents(spendAmount(t));
    add(groups[group].tally, cents);
    groups[group].rows.push({
      id: t.id,
      date: t.occurredOn,
      displayName: displayNameOf(w.row.description, aliases),
      cents,
      pending: t.pending,
      category: cat && catId ? { id: catId, name: cat.name } : null,
      flags,
      card: { accountId: card.accountId, name: card.name, mask: card.mask },
    });
  }
  const rowsPerGroup = q.rowsPerGroup;
  const attention = (g: AttentionGroup) => {
    const rows = [...groups[g].rows].sort(byAmount);
    return {
      ...amountCount(groups[g].tally),
      rows: rows.slice(0, rowsPerGroup).map(({ cents, id, date, displayName, ...rest }) => ({ id, date, displayName, amount: money(cents), ...rest })),
      truncated: rows.length > rowsPerGroup,
    };
  };
  const needsAttention = {
    unplanned: attention("unplanned"),
    unfiled: attention("unfiled"),
    uncategorized: attention("uncategorized"),
    truncated: false,
  };
  needsAttention.truncated =
    needsAttention.unplanned.truncated || needsAttention.unfiled.truncated || needsAttention.uncategorized.truncated;

  // ── (Task 5) Every purchase in one group, by the window's own placement and
  // the evidence class `evidenceSplitCents` read above (no rule of its own).
  const splitById = new Map(windowRows.map(({ row }, i) => [row.id, splitRows[i]!] as const));
  const reconciliation = reconcileAmexPurchases(
    purchaseRows.map((t) => {
      const w = placed.get(t.id);
      const filed = w?.row ?? t;
      const catId = filed.categoryId;
      const card = cardById.get(t.plaidAccountId!)!;
      return {
        id: t.id,
        date: t.occurredOn,
        displayName: displayNameOf(filed.description, aliases),
        cents: toCents(spendAmount(t)),
        pending: t.pending,
        card: { accountId: card.accountId, name: card.name, mask: card.mask },
        hasCategory: !!(catId && !uncategorizedIds.has(catId) && ctx.categoriesById.get(catId)),
        placed: w ? (splitById.get(t.id) ?? null) : null,
      };
    }),
    { purchases, refunds },
    rowsPerGroup,
  );

  // ── The plan this card answers to.
  const hooks = readEverydayHooks(prefs);
  const hookLink = (cadence: HookCadence): PlanLinkView | null => {
    if (!(cadence === "weekly" ? hooks.weekly : hooks.monthly)) return null;
    // The occurrence whose period holds `to`, as the ledger sized it (`hookReserves`' own source).
    let best: { amountCents: number; occurrenceDate: string; fromStoredAmount: boolean } | null = null;
    for (const p of cash.ledger.hookPayoffs.values()) {
      if (p.cadence !== cadence || p.periodStart > to || p.periodEnd < to) continue;
      if (!best || p.occurrenceDate > best.occurrenceDate) best = p;
    }
    return {
      ...NO_PLAN_LINK,
      kind: cadence === "weekly" ? "weekly_hook" : "monthly_hook",
      payoff: best ? money(best.amountCents) : null,
      payoffDate: best?.occurrenceDate ?? null,
      basis: best ? (best.fromStoredAmount ? "stored_amount" : "plan") : null,
    };
  };
  let planLink: PlanLinkView = NO_PLAN_LINK;
  // ⭐ (F1) The plan a card answers to follows how it is paid: a card on the
  // DEBT PLAN answers to its debt; a card paid IN FULL (or not chosen yet)
  // answers to the hook of its cadence — an archived debt row no longer makes
  // a card "the debt's" (before F1 any linked row did).
  const paysInFull = (c: CardView) => c.payoffMode.mode !== "debt_plan";
  if (one) {
    const hooked = paysInFull(one) ? hookLink(one.cadence) : null;
    const debt = !hooked && one.debtId ? (debts.find((d) => d.id === (modeById.get(one.accountId)?.debtId ?? one.debtId)) ?? null) : null;
    if (hooked) {
      planLink = hooked;
    } else if (debt) {
      const min = centsOf(debt.minPayment);
      planLink = {
        ...NO_PLAN_LINK,
        kind: "debt",
        debtId: debt.id,
        name: debt.name,
        // The API's "0" minimum means "not reported": blank, never $0.
        minimum: min != null && min > 0 ? money(min) : null,
        avalancheRank: avalancheRankOf(debts, debt.id),
        status: debt.status,
      };
    } else {
      planLink = hookLink(one.cadence) ?? NO_PLAN_LINK;
    }
  } else {
    // Every card: the hook that pays the cards paid in full (F1: by mode, not by debt link), weekly first.
    const billed = cards.filter(paysInFull);
    planLink =
      (billed.some((c) => c.cadence === "weekly") ? hookLink("weekly") : null) ??
      (billed.some((c) => c.cadence === "monthly") ? hookLink("monthly") : null) ??
      NO_PLAN_LINK;
  }

  const limitations = [...period.limitations];
  const scopeCards = cards.map((c) => ({ ...c, purchases: amountCount(purchasesByCard.get(c.accountId)!) }));

  return {
    scope: one
      ? {
          kind: "card" as const,
          accountId: one.accountId,
          name: one.name,
          mask: one.mask,
          institution: one.institution,
          cards: scopeCards,
        }
      : { kind: "all" as const, accountId: null, name: null, mask: null, institution: null, cards: scopeCards },
    period: { from, to, timezone: HOUSEHOLD_TZ },
    owed,
    purchases: { ...amountCount(purchases), reimbursable: amountCount(reimbursable) },
    refunds: amountCount(refunds),
    payments: amountCount(payments),
    otherCredits: amountCount(otherCredits),
    otherCharges: amountCount(otherCharges),
    notMine: amountCount(notMine),
    householdContribution,
    planLink,
    needsAttention,
    reconciliation,
    limitations,
  };
}

export type AmexSummaryView = Awaited<ReturnType<typeof buildAmexSummary>>;
