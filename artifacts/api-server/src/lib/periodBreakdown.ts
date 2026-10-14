// ⭐ (S3) "WHY ARE WE OVER?" — THE SERVER SIDE of `GET /money/period-breakdown`
// and the spine's `monthAllowance`. The owner: "Why are we over weekly and
// monthly?" Every sum is avalanche-core's (`periodBreakdown`); this file only
// reads, and it reads through the functions the figures already come from:
//
//   the current week   `loadPositionInputs` — the money position's own read.
//                      Its `weekMovement` IS the set of rows `computePosition`
//                      counted, so `actual` = `spentWeekDiscretionary` and
//                      `remaining` = `remainingWeek` by construction. No second
//                      query for the week's rows.
//   a past week        the same building blocks: `loadAllowanceWindow`
//                      (loadMoneyContext + loadMovementRows + classifyMovement)
//                      with the forecast ledger's tier-2 pairs, the cap from
//                      `everydayPlanFromRows(start)` (`weeklyCapCents`), the
//                      week's carry-over (`readWeekAdjustments`).
//   a month            the monthly allowance: `everydayPlanFromRows(monthStart)`
//                      (`monthlyCapCents`) against `allowanceSpentCents(…,
//                      "monthly")` over the calendar month — the window and the
//                      helper the Monthly Spend hook (`loadHookPayoffs`) sizes
//                      its reserve with, so the two never drift.
//   one account        that account's rows only: exact, because every figure
//                      nets per account. The plan stays the household's.
//
// Enrichment (display name, account identity, split parts) is keyed by the
// SAME row ids — never a re-filter of the period.
//
// ⚠️ READ-ONLY. No write, no Plaid call.

import { and, eq } from "drizzle-orm";
import { db, merchantAliasesTable, plaidAccountsTable, plaidItemsTable, type AllowancePlan } from "@workspace/db";
import {
  HOUSEHOLD_TZ,
  addDaysISO,
  allowancePeriodFigures,
  allowancePlanInEffect,
  allowanceRowOf,
  allowanceSpentCents,
  breakdownBasisOf,
  breakdownCountedCoverages,
  everydayPlanFromRows,
  isPeriodStart,
  monthBounds,
  monthlyCapCents,
  netAccountOf,
  periodBoundsOf,
  periodBreakdown,
  priorPeriodStarts,
  weekBounds,
  weeklyCapCents,
  type BreakdownEntry,
  type BreakdownPeriod,
  type BreakdownRowInput,
  type MovementClassification,
} from "@workspace/avalanche-core";
import { computeCashSignalDetailed, type DetailedCashSignal } from "./cashSignal";
import { loadAllowanceWindow, type ClassifiedMovement, type MoneyContext, type MovementRowRead } from "./moneyContext";
import { POSITION_HORIZON_DAYS, loadPositionInputs, readWeekAdjustments, tier2PairedTxnIdsOf } from "./moneyPosition";
import { loadAllowancePlans, planRowsOf } from "./allowancePlans";
import { TRACKING_START, buildSpendingFacts } from "./spendingFacts";
import { householdTodayISO } from "./householdClock";
import { expandSplits, loadSplitsForTxns } from "./categorizer/splits";
import { cleanMerchant, merchantSignature } from "./merchantNameExtract";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refused request: the route answers `status` with `{ error: code }`. */
export class PeriodBreakdownError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface PeriodBreakdownQuery {
  period: BreakdownPeriod;
  start: string;
  /** `plaid_accounts.id`, or undefined for the household. */
  account?: string;
  rowsPerGroup: number;
}

export interface ReadPeriodOptions {
  /** A cash-signal read already made for this request (the spine's), so one request builds one ledger. */
  cash?: Promise<DetailedCashSignal> | DetailedCashSignal;
}

interface PlanView {
  status: "set" | "not_set";
  amount: string | null;
  source: "override" | "plan" | "none";
  planId: string | null;
  effectiveFrom: string | null;
}

/** What one period's read holds before it is grouped. */
interface PeriodRead {
  period: BreakdownPeriod;
  start: string;
  end: string;
  isCurrent: boolean;
  /** The period's classified rows (household-wide, clamped to the tracking start). */
  movement: ClassifiedMovement[];
  money: MoneyContext;
  tier2PairedTxnIds: ReadonlySet<string>;
  planCents: number | null;
  plan: PlanView;
  carryOverCents: number | null;
  /** The household's today, as the read saw it. */
  todayISO: string;
}

const money = (cents: number): string => (cents / 100).toFixed(2);
const moneyOrNull = (cents: number | null): string | null => (cents == null ? null : money(cents));
const centsOf = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** The plan as the response states it: where the cap came from, and the row behind it. */
function planViewOf(
  period: BreakdownPeriod,
  start: string,
  plans: readonly AllowancePlan[],
  overrides: Readonly<Record<string, string | number>> | null,
  capCents: number | null,
): PlanView {
  const plan = everydayPlanFromRows(start, planRowsOf(plans), overrides);
  const source: PlanView["source"] = period === "week" ? plan.weeklySource : plan.monthlySource;
  const row = source === "plan" ? allowancePlanInEffect(start, plans, period === "week" ? "weekly" : "monthly") : null;
  return {
    status: capCents == null ? "not_set" : "set",
    amount: moneyOrNull(capCents),
    source,
    planId: row?.id ?? null,
    effectiveFrom: row?.effectiveFrom ?? null,
  };
}

/** Validates the period; returns its bounds and whether it is the household's current one. */
function checkPeriod(period: BreakdownPeriod, start: string, todayISO: string): { end: string; isCurrent: boolean } {
  if (!isPeriodStart(period, start)) {
    throw new PeriodBreakdownError(400, period === "week" ? "start_not_a_sunday" : "start_not_first_of_month");
  }
  const current = periodBoundsOf(period, todayISO).start;
  if (start > current) throw new PeriodBreakdownError(400, "start_in_future");
  const { end } = periodBoundsOf(period, start);
  if (end < TRACKING_START) throw new PeriodBreakdownError(400, "before_tracking_start");
  return { end, isCurrent: start === current };
}

/**
 * ⭐ ONE PERIOD'S READ — plan, carry-over and classified rows. The endpoint and
 * the spine's `monthAllowance` both start here, so the two can never quote a
 * different plan or a different set of rows.
 */
async function readPeriod(
  householdId: string,
  ownerUserId: string,
  period: BreakdownPeriod,
  start: string,
  opts: ReadPeriodOptions,
): Promise<PeriodRead> {
  const todayISO = householdTodayISO();
  const { end, isCurrent } = checkPeriod(period, start, todayISO);

  // The current week: the money position's own read and nothing else.
  if (period === "week" && isCurrent) {
    const read = await loadPositionInputs(householdId, ownerUserId, opts.cash ? { cash: opts.cash } : {});
    const readWeek = weekBounds(read.inputs.todayISO);
    // (Midnight Saturday between the two clocks) the read is a week on; the
    // asked-for week is a past week now — read it as one.
    if (readWeek.start === start) {
      const capCents = centsOf(read.inputs.weekCap);
      return {
        period,
        start,
        end,
        isCurrent: true,
        movement: read.weekMovement,
        money: read.money,
        tier2PairedTxnIds: read.money.tier2PairedTxnIds,
        planCents: capCents,
        plan: planViewOf(period, start, read.allowancePlans, read.money.settings.weeklyAllowanceOverrides, capCents),
        carryOverCents: read.inputs.weekAdjustmentCents ?? null,
        todayISO: read.inputs.todayISO,
      };
    }
  }

  // A past week, or a month: the same building blocks over the period.
  const cash = await Promise.resolve(
    opts.cash ?? computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS }),
  );
  const tier2PairedTxnIds = tier2PairedTxnIdsOf(cash.ledger);
  const from = start < TRACKING_START ? TRACKING_START : start;
  const [window, plans, adjustments] = await Promise.all([
    loadAllowanceWindow(householdId, { start: from, end }, { tier2PairedTxnIds }),
    loadAllowancePlans(householdId),
    period === "week" ? readWeekAdjustments(householdId, [start]) : Promise.resolve(null),
  ]);
  const overrides = window.money.settings.weeklyAllowanceOverrides;
  const plan = everydayPlanFromRows(start, planRowsOf(plans), overrides);
  const capCents = period === "week" ? weeklyCapCents(plan) : monthlyCapCents(plan);
  return {
    period,
    start,
    end,
    isCurrent: period === "week" ? false : isCurrent,
    movement: window.movement,
    money: window.money,
    tier2PairedTxnIds,
    planCents: capCents,
    plan: planViewOf(period, start, plans, overrides, capCents),
    carryOverCents: adjustments?.get(start)?.amountCents ?? null,
    todayISO: cash.ledger.todayISO,
  };
}

/**
 * ⭐ (S3) THE SPINE'S `monthAllowance` — this month's monthly allowance: the
 * same read (`readPeriod`) and the same helper (`allowanceSpentCents`) the
 * endpoint's `plan.amount` / `actual` come from. Never a debt balance.
 * (S6) `remaining` / `over` are the endpoint's too (`allowancePeriodFigures`,
 * the call `periodBreakdown` makes), so the dashboard tile never subtracts
 * plan − actual in the browser. Null when no plan is set (never "0.00").
 */
export async function readMonthAllowance(
  householdId: string,
  ownerUserId: string,
  opts: ReadPeriodOptions = {},
): Promise<{
  plan: string | null;
  actual: string;
  status: "not_set" | "within" | "over";
  remaining: string | null;
  over: string | null;
}> {
  const start = monthBounds(householdTodayISO()).start;
  const read = await readPeriod(householdId, ownerUserId, "month", start, opts);
  const actualCents = allowanceSpentCents(
    read.movement.map(({ row, m }) => allowanceRowOf(row, m)),
    "monthly",
  );
  const figures = allowancePeriodFigures(read.planCents, read.carryOverCents, actualCents);
  return {
    plan: moneyOrNull(read.planCents),
    actual: money(actualCents),
    // (S6) From the same figures: identical to `actual > plan` while a month carries no carry-over.
    status: figures.withinPlan == null ? "not_set" : figures.withinPlan ? "within" : "over",
    remaining: moneyOrNull(figures.remainingCents),
    over: moneyOrNull(figures.overCents),
  };
}

// ── The endpoint ────────────────────────────────────────────────────────────

interface AccountIdentity {
  id: string | null;
  institution: string | null;
  name: string | null;
  mask: string | null;
}

const NO_ACCOUNT: AccountIdentity = { id: null, institution: null, name: null, mask: null };

/** The household's linked accounts, by their external Plaid id. */
async function loadAccountIdentities(householdId: string): Promise<Map<string, AccountIdentity>> {
  const rows = await db
    .select({
      id: plaidAccountsTable.id,
      accountId: plaidAccountsTable.accountId,
      name: plaidAccountsTable.name,
      mask: plaidAccountsTable.mask,
      institution: plaidItemsTable.institutionName,
    })
    .from(plaidAccountsTable)
    .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
    .where(eq(plaidAccountsTable.householdId, householdId));
  return new Map(
    rows.map((r) => [r.accountId, { id: r.id, institution: r.institution ?? null, name: r.name ?? null, mask: r.mask ?? null }]),
  );
}

/** A row's place in the response, carried through the pure grouping untouched. */
interface RowItem {
  row: MovementRowRead;
  m: MovementClassification;
}

/** The period's (or a prior period's) rows, in scope, as the pure breakdown reads them — split parts attached. */
async function breakdownRowsOf(
  householdId: string,
  period: BreakdownPeriod,
  movement: readonly ClassifiedMovement[],
  inScope: (row: MovementRowRead) => boolean,
): Promise<BreakdownRowInput<RowItem>[]> {
  const counted = new Set<string>(breakdownCountedCoverages(period));
  const scoped = movement
    .filter(({ row }) => inScope(row))
    .map(({ row, m }) => ({ row, m, allowance: allowanceRowOf(row, m) }));
  // Split parts only for the rows that count (one query, valid parents only;
  // `expandSplits` drops any whose parts do not add up to the row).
  const counting = scoped.filter((r) => counted.has(r.allowance.coverage)).map((r) => ({ id: r.row.id, amount: String(r.row.amount) }));
  const parts = expandSplits(counting, await loadSplitsForTxns(householdId, counting.map((r) => r.id)));
  return scoped.map(({ row, m, allowance }) => ({
    id: row.id,
    date: row.occurredOn,
    allowance,
    categoryId: row.categoryId ?? null,
    splitParts: parts.get(row.id) ?? null,
    item: { row, m },
  }));
}

/**
 * A row's name on screen: the household's merchant alias, else the cleaned bank
 * description. (S5) Exported so the Amex summary's rows read the same name.
 */
export function displayNameOf(description: string, aliases: ReadonlyMap<string, string>): string {
  const sig = merchantSignature(description);
  const alias = sig ? aliases.get(sig) : undefined;
  return alias ?? cleanMerchant(description);
}

/** The household's merchant aliases, by signature. */
export async function loadMerchantAliases(householdId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ signature: merchantAliasesTable.signature, alias: merchantAliasesTable.alias })
    .from(merchantAliasesTable)
    .where(eq(merchantAliasesTable.householdId, householdId));
  return new Map(rows.map((a) => [a.signature, a.alias]));
}

/** The view of one grouped row. */
function rowView(
  e: BreakdownEntry<RowItem>,
  ctx: { categoryNames: ReadonlyMap<string, string>; accounts: ReadonlyMap<string, AccountIdentity>; aliases: ReadonlyMap<string, string> },
) {
  const { row, m } = e.item;
  return {
    id: row.id,
    date: row.occurredOn,
    displayName: displayNameOf(row.description, ctx.aliases),
    amount: money(e.cents),
    account: (row.plaidAccountId ? ctx.accounts.get(row.plaidAccountId) : undefined) ?? NO_ACCOUNT,
    pending: row.pending,
    category: e.categoryId ? { id: e.categoryId, name: ctx.categoryNames.get(e.categoryId) ?? "" } : null,
    // `loadAllowanceWindow` always classifies with `explain`, so `rule` is always said.
    reason: { coverage: m.coverage, nets: m.nets ?? null, rule: m.rule! },
    splitPart: e.splitPart ? { index: e.splitPart.index, count: e.splitPart.count, parentAmount: money(e.splitPart.parentCents) } : null,
  };
}

/**
 * ⭐ `GET /money/period-breakdown`. See the file header and the PeriodBreakdown
 * schema. Every figure is `periodBreakdown`'s (avalanche-core).
 */
export async function buildPeriodBreakdown(householdId: string, ownerUserId: string, q: PeriodBreakdownQuery) {
  // The account first: a bad or foreign one is refused before anything is read.
  let scopeAccount: (AccountIdentity & { externalId: string }) | null = null;
  if (q.account !== undefined) {
    if (!UUID_RE.test(q.account)) throw new PeriodBreakdownError(400, "invalid_account");
    const [acct] = await db
      .select({
        id: plaidAccountsTable.id,
        accountId: plaidAccountsTable.accountId,
        name: plaidAccountsTable.name,
        mask: plaidAccountsTable.mask,
        institution: plaidItemsTable.institutionName,
      })
      .from(plaidAccountsTable)
      .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
      .where(and(eq(plaidAccountsTable.id, q.account), eq(plaidAccountsTable.householdId, householdId)));
    if (!acct) throw new PeriodBreakdownError(404, "account_not_found");
    scopeAccount = { id: acct.id, externalId: acct.accountId, institution: acct.institution ?? null, name: acct.name ?? null, mask: acct.mask ?? null };
  }
  // A row is in scope when it nets on the account (`netAccountOf`) — the key every figure nets by.
  const inScope = scopeAccount
    ? (row: MovementRowRead) => netAccountOf(row) === scopeAccount!.externalId
    : () => true;

  const read = await readPeriod(householdId, ownerUserId, q.period, q.start, {});
  const { period, start, end } = read;

  // ── The prior periods `usual` reads: the same window read, the same ledger's pairs.
  const historyStarts = priorPeriodStarts(period, start, TRACKING_START);
  const historyRead =
    historyStarts.length > 0
      ? loadAllowanceWindow(
          householdId,
          { start: historyStarts[0]!, end: addDaysISO(start, -1) },
          { tier2PairedTxnIds: read.tier2PairedTxnIds },
        )
      : null;

  const [rows, history, accounts, aliasRows, facts] = await Promise.all([
    breakdownRowsOf(householdId, period, read.movement, inScope),
    historyRead
      ? historyRead.then((h) => breakdownRowsOf(householdId, period, h.movement, inScope))
      : Promise.resolve([] as BreakdownRowInput<RowItem>[]),
    loadAccountIdentities(householdId),
    loadMerchantAliases(householdId),
    // Household spending over the same days — the spine's own call for its week.
    scopeAccount ? Promise.resolve(null) : buildSpendingFacts(householdId, start, end),
  ]);

  const categoryNames = new Map<string, string>();
  for (const [id, c] of read.money.categoriesById) categoryNames.set(id, c.name);

  const core = periodBreakdown<RowItem>({
    period,
    rows,
    planCents: read.planCents,
    carryOverCents: read.carryOverCents,
    history: {
      starts: historyStarts,
      rows: history.map((r) => ({ ...r, periodStart: periodBoundsOf(period, r.date).start })),
    },
    categoryNames,
    rowsPerGroup: q.rowsPerGroup,
  });

  const view = {
    categoryNames,
    accounts,
    aliases: aliasRows,
  };

  // ── What the answer cannot see.
  const limitations: string[] = [];
  // The forecast ledger pairs bank rows to bills from the first of last month on.
  const tier2Since = monthBounds(addDaysISO(monthBounds(read.todayISO).start, -1)).start;
  if (start < tier2Since) limitations.push(`tier2_pairs_only_since:${tier2Since}`);
  if (start < TRACKING_START) limitations.push(`tracking_start:${TRACKING_START}`);
  const fullHistory = period === "week" ? 8 : 3;
  if (historyStarts.length < fullHistory) limitations.push(`usual_periods:${historyStarts.length}`);

  return {
    period,
    basis: breakdownBasisOf(period),
    start,
    end,
    isCurrent: read.isCurrent,
    timezone: HOUSEHOLD_TZ,
    scope: scopeAccount
      ? { kind: "account" as const, id: scopeAccount.id, institution: scopeAccount.institution, name: scopeAccount.name, mask: scopeAccount.mask }
      : { kind: "household" as const, id: null, institution: null, name: null, mask: null },
    planScope: "household" as const,
    plan: read.plan,
    carryOver: moneyOrNull(read.carryOverCents),
    actual: money(core.actualCents),
    remaining: moneyOrNull(core.remainingCents),
    over: moneyOrNull(core.overCents),
    withinPlan: core.withinPlan,
    categories: core.categories.map((c) => ({
      categoryId: c.categoryId,
      name: c.name,
      amount: money(c.cents),
      shareBp: c.shareBp,
      count: c.count,
      usual: moneyOrNull(c.usualCents),
      aboveUsual: moneyOrNull(c.aboveUsualCents),
      rows: c.rows.map((e) => rowView(e, view)),
      truncated: c.truncated,
    })),
    needsClassification: {
      amount: money(core.needsClassification.cents),
      count: core.needsClassification.count,
      rows: core.needsClassification.rows.map((e) => rowView(e, view)),
      truncated: core.needsClassification.truncated,
      countsAgainstPlan: core.needsClassification.countsAgainstPlan,
    },
    refundFloorAdjustment: money(core.refundFloorAdjustmentCents),
    beside: {
      unplanned: money(core.beside.unplannedCents),
      weekly: moneyOrNull(core.beside.weeklyCents),
      monthly: moneyOrNull(core.beside.monthlyCents),
      billMatched: money(core.beside.billMatchedCents),
      reimbursable: money(core.beside.reimbursableCents),
      householdSpend: facts ? facts.householdSpend.total.toFixed(2) : null,
    },
    limitations,
  };
}

export type PeriodBreakdownView = Awaited<ReturnType<typeof buildPeriodBreakdown>>;
