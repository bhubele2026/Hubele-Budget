// ⭐ (PR8r, plan section A; owner decisions 7 and 12) THE EVERYDAY HOOKS ON THE
// SERVER — what `buildForecastLedger` reads to put the weekly and monthly Amex
// payoffs on the curve, and the facts `/forecast/cash-signal`'s `everyday` block
// answers with. The rules are `@workspace/avalanche-core`'s `everydayReserve.ts`
// (pinned without a database, `everydayReserve.test.ts`); this file only reads
// what they need, once per ledger:
//
//   - which recurring items are the hooks (`preferences.everydayHooks`), checked
//     against the household's own ACTIVE items (`resolveHookLinks`). An id that is
//     not one reads "invalid" and is no hook: its bill stays on the curve as a
//     bill, exactly as when nothing is linked;
//   - the owed charges per period: `computeWeeklyPayoff`'s own figure, called once
//     for each period that has begun, and its cards' cadence. ⚠️ Its rules are
//     NOT restated or changed here — PR-G1 unifies the Amex owed calculations;
//   - the Amex payments on checking: the cash rule (`classifyCashRows`, no
//     anchor) decides which rows are checking cash and which pending rows a
//     posted row replaced — so a payment the bank snapshot already holds still
//     settles its period, and the payoff is never taken a second time;
//   - this week's and this month's rows, classified by `everydayRowFacts`
//     through `loadMoneyContext`.
//
// Two phases, because the ledger's bill matching sits between them:
//   1. `prepareEverydayHooks`, before it: the periods, the owed figures, and which
//      payment settled which period. The ledger claims those rows, so a bill can
//      never be "paid" by an Amex payment as well;
//   2. `finishEverydayHooks`, after it: the tier-2 pairs are known, so the rows
//      are classified, the payoffs built and the facts read.

import { and, eq, gte, lt, lte } from "drizzle-orm";
import { db, transactionsTable, type recurringItemsTable } from "@workspace/db";
import {
  addDaysISO,
  buildPayoffs,
  classifyCashRows,
  everydayPeriodOf,
  everydayPeriodsPaidBetween,
  everydayPlan,
  everydayRowFacts,
  isAmexPayoffPayment,
  isRealSpend,
  PAYOFF_RESOLUTION_STATUSES,
  payoffResolutionKey,
  periodSpend,
  settlePayoffPayments,
  SUPERSEDE_MAX_DAYS,
  weekBounds,
  type EverydayCadence,
  type EverydayPeriod,
  type EverydaySpendRow,
  type MovementConflict,
  type MovementContext,
  type MovementRow,
  type PayoffOutcome,
  type PayoffPayment,
  type PayoffResolution,
} from "@workspace/avalanche-core";
import { computeWeeklyPayoff } from "./amexAnchor";
import { inForecastWhere } from "./forecastInclusion";
import { toCashRow } from "./ledgerCashRows";
import { loadMoneyContext, type EverydayHookLinks, type MoneyContextSettingsRow } from "./moneyContext";
import { effectiveFiling } from "./pendingFiling";

type RecurringRow = typeof recurringItemsTable.$inferSelect;

export type HookStatus = "linked" | "unlinked" | "invalid";

export interface HookLink {
  cadence: EverydayCadence;
  status: HookStatus;
  /**
   * Linked: the item. Unlinked: the household's one active bill named "Weekly
   * Spend" / "Monthly Spend" — the bill the discrepancy flag compares — when
   * there is exactly one. Invalid: the stored item, if it still exists.
   */
  item: RecurringRow | null;
  /** The id `preferences.everydayHooks` stores, if any. */
  storedId: string | null;
}

export type HookLinks = Record<EverydayCadence, HookLink>;

const CADENCES: readonly EverydayCadence[] = ["weekly", "monthly"];
const CANDIDATE_NAME: Record<EverydayCadence, string> = { weekly: "weekly spend", monthly: "monthly spend" };

/** Which stored hook ids are hooks: active recurring items of THIS household (`recurring` is its own). */
export function resolveHookLinks(stored: EverydayHookLinks, recurring: readonly RecurringRow[]): HookLinks {
  const link = (cadence: EverydayCadence, storedId: string | null): HookLink => {
    if (storedId) {
      const item = recurring.find((r) => r.id === storedId) ?? null;
      return { cadence, status: item && item.active === "true" ? "linked" : "invalid", item, storedId };
    }
    const named = recurring.filter(
      (r) => r.active === "true" && r.kind !== "income" && r.name.trim().toLowerCase() === CANDIDATE_NAME[cadence],
    );
    return { cadence, status: "unlinked", item: named.length === 1 ? named[0]! : null, storedId: null };
  };
  return { weekly: link("weekly", stored.weeklyItemId), monthly: link("monthly", stored.monthlyItemId) };
}

/** A `forecast_resolutions` row as the hooks read it. */
export interface ResolutionRead {
  recurringItemId: string | null;
  occurrenceDate: string | null;
  status: string;
  matchedTxnId: string | null;
  rescheduledTo: string | null;
}

const later = (a: string, b: string): string => (a > b ? a : b);
const earlier = (a: string, b: string): string => (a < b ? a : b);

// ── Phase 1 ──────────────────────────────────────────────────────────────────

export interface PrepareEverydayHooksInput {
  householdId: string;
  ownerUserId: string;
  todayISO: string;
  dragFloorISO: string;
  toISO: string;
  checkingAccountExternalId: string | null;
  links: HookLinks;
  resolutions: readonly ResolutionRead[];
  /** Signed amounts of the rows answers name — a `partial` answer's paid part. */
  resolvedTxnAmount: ReadonlyMap<string, number>;
  /** Rows an answer already holds: never a payment candidate. */
  claimedTxnIds: ReadonlySet<string>;
}

export interface PreparedEverydayHooks {
  linked: EverydayCadence[];
  /** Every linked period paid from the overdue floor through the horizon (and the current month's). */
  periods: EverydayPeriod[];
  /** `payoffResolutionKey` → owed charges in cents, for each period that has begun. */
  owedCents: Map<string, number>;
  /** External account id → cadence, for the Amex cards the hooks pay (`computeWeeklyPayoff`'s cards: no linked debt). */
  bandCadence: Map<string, "weekly" | "monthly">;
  payments: PayoffPayment[];
  resolutions: Map<string, PayoffResolution>;
  /** `payoffResolutionKey` → the payment that settled it. */
  settled: Map<string, PayoffPayment>;
}

/** Phase 1 — null when no hook is linked (then no query runs). */
export async function prepareEverydayHooks(input: PrepareEverydayHooksInput): Promise<PreparedEverydayHooks | null> {
  const linked = CADENCES.filter((c) => input.links[c].status === "linked");
  if (linked.length === 0) return null;
  const { todayISO } = input;
  const periods = linked.flatMap((c) =>
    everydayPeriodsPaidBetween(c, input.dragFloorISO, later(input.toISO, everydayPeriodOf(c, todayISO).payoffDate)),
  );

  // The owed figure: `computeWeeklyPayoff` per period that has begun. A weekly
  // period asks for its own week. A monthly period asks for a week whose Sunday
  // lies in the month (the function bills a monthly card over the month of the
  // Sunday it is given): the week of the 8th.
  const begun = periods.filter((p) => p.start <= todayISO);
  const sundayOf = (p: EverydayPeriod): string => (p.cadence === "weekly" ? p.start : weekBounds(addDaysISO(p.start, 7)).start);
  const sundays = [...new Set(begun.map(sundayOf))];
  const payoffs = new Map(
    await Promise.all(
      sundays.map(async (sunday) => [sunday, await computeWeeklyPayoff(input.householdId, sunday, input.ownerUserId)] as const),
    ),
  );
  const bandCadence = new Map<string, "weekly" | "monthly">();
  for (const payoff of payoffs.values()) for (const card of payoff.cards) bandCadence.set(card.accountId, card.cadence);
  const owedCents = new Map<string, number>();
  for (const p of begun) {
    const payoff = payoffs.get(sundayOf(p))!;
    const dollars =
      p.cadence === "weekly"
        ? payoff.combinedWeekCharges
        : payoff.cards.filter((c) => c.cadence === "monthly").reduce((s, c) => s + c.weekCharges, 0);
    owedCents.set(payoffResolutionKey(p), Math.round(dollars * 100));
  }

  // The Amex payments on checking, from the earliest period's first day to today.
  const earliest = periods.reduce((m, p) => earlier(m, p.start), todayISO);
  const rows = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, input.householdId),
        inForecastWhere(todayISO),
        lt(transactionsTable.amount, "0"),
        gte(transactionsTable.occurredOn, addDaysISO(earliest, -SUPERSEDE_MAX_DAYS)),
        lte(transactionsTable.occurredOn, addDaysISO(todayISO, SUPERSEDE_MAX_DAYS)),
      ),
    );
  // ⚠️ TODO(PR-I, `feat/bank-removed-review-carry`): a payment the bank removed
  // must not settle a payoff. Apply PR-I's bank-removed filter
  // (`loadBankRemovedIds` / `notBankRemovedSql`) to the read above at whichever
  // of the two merges lands second.
  const cash = classifyCashRows(rows.map(toCashRow), {
    anchor: null,
    accountExternalId: input.checkingAccountExternalId,
    todayISO,
  });
  const payments: PayoffPayment[] = [];
  cash.rows.forEach((o, i) => {
    const r = rows[i]!;
    if (!o.counts || r.occurredOn < earliest || r.occurredOn > todayISO) return;
    if (input.claimedTxnIds.has(r.id) || (o.replacedId !== null && input.claimedTxnIds.has(o.replacedId))) return;
    const eligible = isAmexPayoffPayment({
      amount: r.amount,
      description: r.description,
      isExternalCardPayment: r.isExternalCardPayment,
      pfcDetailed: r.pfcDetailed ?? null,
      debtId: r.debtId ?? null,
    });
    if (eligible) payments.push({ txnId: r.id, occurredOn: r.occurredOn, amountCents: Math.round(Math.abs(Number(r.amount)) * 100) });
  });

  // Explicit answers on a payoff: keyed on the hook item and the payoff date.
  const resolutions = new Map<string, PayoffResolution>();
  for (const cadence of linked) {
    const itemId = input.links[cadence].item!.id;
    for (const r of input.resolutions) {
      if (r.recurringItemId !== itemId || !r.occurrenceDate || !PAYOFF_RESOLUTION_STATUSES.has(r.status)) continue;
      const paid = r.status === "partial" && r.matchedTxnId ? input.resolvedTxnAmount.get(r.matchedTxnId) : undefined;
      resolutions.set(`${cadence}|${r.occurrenceDate}`, {
        status: r.status,
        rescheduledTo: r.rescheduledTo,
        paidCents: paid != null ? Math.round(Math.abs(paid) * 100) : null,
      });
    }
  }

  const settled = settlePayoffPayments({
    periods: periods.map((period) => ({ period, owedCents: owedCents.get(payoffResolutionKey(period)) ?? 0 })),
    payments,
    resolutions,
  });
  return { linked, periods, owedCents, bandCadence, payments, resolutions, settled };
}

// ── Phase 2 ──────────────────────────────────────────────────────────────────

/** One hook's facts, for the period containing today. Dollars. */
export interface EverydayHookFacts {
  status: HookStatus;
  itemId: string | null;
  /** The linked (or candidate) bill's own amount. */
  billAmount: number | null;
  /** The Allowances standing amount (`weeklyAllowanceAmount` / `monthlyAllowanceAmount`). */
  allowanceAmount: number;
  /** The bill's amount and the Allowances amount differ (PR8r-web's banner). */
  discrepancy: boolean;
  period: EverydayPeriod;
  /** This period's plan: the standing amount, or this week's override. */
  plan: number;
  /** Everyday spend against the plan, from any account. */
  spent: number;
  remaining: number;
  overage: number;
  unplanned: number;
  needsClassification: number;
  /** Linked only: the owed charges on the hook's cards in the period (`computeWeeklyPayoff`). */
  owed: number | null;
  /** Linked only: what is on the curve for the period, when anything is. */
  payoff: number | null;
  /** The Amex payment that settled the period's owed charges. Signed like the row. */
  payment: { txnId: string; occurredOn: string; amount: number } | null;
}

/** A spending row a confirmed bill match keeps out of every plan (decision 12), with its overage. */
export interface EverydayBillMatch {
  txnId: string;
  occurredOn: string;
  /** Signed like the row. */
  txnAmount: number;
  planKey: string | null;
  planLabel: string | null;
  /** Signed like the plan. */
  planAmount: number | null;
  /** How much more the row paid than the plan; 0 when not more. */
  overage: number | null;
  conflict: MovementConflict | null;
}

export interface LedgerEveryday {
  weekly: EverydayHookFacts;
  monthly: EverydayHookFacts;
  /** In this week's and this month's rows, by date. */
  billMatched: EverydayBillMatch[];
}

export interface EverydayPayoffPlan {
  cadence: EverydayCadence;
  item: RecurringRow;
  period: EverydayPeriod;
  curve: NonNullable<PayoffOutcome["curve"]>;
}

export interface FinishEverydayHooksInput {
  householdId: string;
  todayISO: string;
  dragCutoffISO: string;
  dragFloorISO: string;
  checkingAccountExternalId: string | null;
  settingsRow: MoneyContextSettingsRow | null;
  links: HookLinks;
  prepared: PreparedEverydayHooks | null;
  tier2PairedTxnIds: ReadonlySet<string>;
  resolutions: readonly ResolutionRead[];
  /** The label and signed amount of the occurrence an answer names. */
  planOf: (itemId: string, occurrenceDate: string) => { label: string; amount: number } | null;
}

/** Phase 2 — the payoffs on the curve (linked hooks only) and the facts. */
export async function finishEverydayHooks(
  input: FinishEverydayHooksInput,
): Promise<{ plans: EverydayPayoffPlan[]; facts: LedgerEveryday }> {
  const { todayISO, prepared } = input;
  const week = everydayPeriodOf("weekly", todayISO);
  const month = everydayPeriodOf("monthly", todayISO);
  const range = { start: earlier(week.start, month.start), end: later(week.end, month.end) };

  const money = await loadMoneyContext(input.householdId, range, {
    checkingAccountExternalId: input.checkingAccountExternalId,
    tier2PairedTxnIds: input.tier2PairedTxnIds,
    settingsRow: input.settingsRow,
  });
  // ⚠️ TODO(PR-I, `feat/bank-removed-review-carry`): a row the bank removed counts
  // nowhere — no everyday spend, no bill-matched overage. Apply PR-I's
  // bank-removed filter to this read at whichever of the two merges lands second.
  const rows = await db
    .select({
      id: transactionsTable.id,
      occurredOn: transactionsTable.occurredOn,
      amount: transactionsTable.amount,
      description: transactionsTable.description,
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
      isTransferUserOverridden: transactionsTable.isTransferUserOverridden,
      source: transactionsTable.source,
      reimbursable: transactionsTable.reimbursable,
      debtId: transactionsTable.debtId,
      isExternalCardPayment: transactionsTable.isExternalCardPayment,
      pfcDetailed: transactionsTable.pfcDetailed,
      plaidAccountId: transactionsTable.plaidAccountId,
      weeklyAllowance: transactionsTable.weeklyAllowance,
      monthlyAllowance: transactionsTable.monthlyAllowance,
      unplannedAllowance: transactionsTable.unplannedAllowance,
      weeklyBucket: transactionsTable.weeklyBucket,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, input.householdId),
        gte(transactionsTable.occurredOn, range.start),
        lte(transactionsTable.occurredOn, range.end),
      ),
    );

  const ctx: MovementContext = { ...money, amexPayoffCadence: prepared?.bandCadence };
  const linkedCadences = new Set(prepared?.linked ?? []);
  const spendCtx = { categoriesById: money.categoriesById, debtCategoryIds: money.debtCategoryIds };
  const confirmedByTxn = new Map<string, ResolutionRead>();
  for (const r of input.resolutions) {
    if ((r.status === "matched" || r.status === "partial") && r.matchedTxnId && r.recurringItemId && r.occurrenceDate) {
      confirmedByTxn.set(r.matchedTxnId, r);
    }
  }

  const spendRows: EverydaySpendRow[] = [];
  const billMatched: EverydayBillMatch[] = [];
  for (const raw of rows) {
    // A pending row its posted row replaced counts nowhere; the posted row counts
    // under the filing it inherits.
    if (money.supersede.replacedIds.has(raw.id)) continue;
    const replaced = money.supersede.replacedBy.get(raw.id);
    const filed = effectiveFiling(raw, replaced, money.filingCtx);
    const movementRow: MovementRow = { ...filed, plaidAccountId: raw.plaidAccountId ?? null, pfcDetailed: raw.pfcDetailed ?? null };
    const facts = everydayRowFacts(movementRow, ctx);
    const timing = facts.movement.timing;
    // Covered: the forecast already sees this money leave — a checking row, or a
    // card row inside a LINKED hook's owed figure. The owed figure is
    // `computeWeeklyPayoff`'s, which reads the row's own fields (not the inherited
    // filing), skips "not mine" charges and counts categorized spend with
    // reimbursable charges in; a card row it leaves out does not shrink a payoff.
    const covered =
      timing.kind === "checking" ||
      (timing.kind === "amex_payoff" &&
        linkedCadences.has(prepared!.bandCadence.get(timing.accountId)!) &&
        !money.settings.amexExcludedTxnIds.has(raw.id) &&
        isRealSpend(raw, spendCtx, { reimbursableIsSpend: true }));
    spendRows.push({
      occurredOn: raw.occurredOn,
      bucket: facts.bucket,
      viaNeedsClassification: facts.viaNeedsClassification,
      spendCents: facts.spendCents,
      covered,
    });
    if (facts.billMatched) {
      const answer = confirmedByTxn.get(raw.id) ?? (replaced ? confirmedByTxn.get(replaced.id) : undefined);
      const plan = answer ? input.planOf(answer.recurringItemId!, answer.occurrenceDate!) : null;
      billMatched.push({
        txnId: raw.id,
        occurredOn: raw.occurredOn,
        txnAmount: Number(raw.amount) || 0,
        planKey: answer ? `${answer.recurringItemId}|${answer.occurrenceDate}` : null,
        planLabel: plan?.label ?? null,
        planAmount: plan?.amount ?? null,
        overage: plan ? Math.max(0, facts.spendCents - Math.round(Math.abs(plan.amount) * 100)) / 100 : null,
        conflict: facts.billMatched.conflict,
      });
    }
  }
  billMatched.sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.txnId < b.txnId ? -1 : 1));

  const planCents = (period: EverydayPeriod): number => {
    const plan = everydayPlan(period.cadence === "weekly" ? period.start : week.start, money.settings, money.settings.weeklyAllowanceOverrides);
    return period.cadence === "weekly" ? plan.weeklyCents : plan.monthlyCents;
  };
  const containsToday = (p: EverydayPeriod) => p.start <= todayISO && p.end >= todayISO;
  const outcomes = prepared
    ? buildPayoffs({
        todayISO,
        dragCutoffISO: input.dragCutoffISO,
        dragFloorISO: input.dragFloorISO,
        periods: prepared.periods.map((period) => ({
          period,
          planCents: planCents(period),
          owedCents: prepared.owedCents.get(payoffResolutionKey(period)) ?? 0,
          coveredSpentCents: containsToday(period) ? periodSpend(period, spendRows).coveredSpentCents : 0,
        })),
        payments: prepared.payments,
        resolutions: prepared.resolutions,
      })
    : [];
  const plans: EverydayPayoffPlan[] = outcomes.flatMap((o) =>
    o.curve ? [{ cadence: o.period.cadence, item: input.links[o.period.cadence].item!, period: o.period, curve: o.curve }] : [],
  );

  const standing = everydayPlan(week.start, money.settings, null);
  const factsFor = (cadence: EverydayCadence): EverydayHookFacts => {
    const period = cadence === "weekly" ? week : month;
    const link = input.links[cadence];
    const plan = planCents(period);
    const standingCents = cadence === "weekly" ? standing.weeklyCents : standing.monthlyCents;
    const spend = periodSpend(period, spendRows);
    const key = payoffResolutionKey(period);
    const outcome = outcomes.find((o) => payoffResolutionKey(o.period) === key) ?? null;
    const billCents = link.item ? Math.round(Math.abs(Number(link.item.amount) || 0) * 100) : null;
    const linked = link.status === "linked";
    return {
      status: link.status,
      itemId: link.item?.id ?? link.storedId,
      billAmount: billCents === null ? null : billCents / 100,
      allowanceAmount: standingCents / 100,
      discrepancy: billCents !== null && billCents !== standingCents,
      period,
      plan: plan / 100,
      spent: spend.spentCents / 100,
      remaining: Math.max(0, plan - spend.spentCents) / 100,
      overage: Math.max(0, spend.spentCents - plan) / 100,
      unplanned: spend.unplannedCents / 100,
      needsClassification: spend.needsClassificationCents / 100,
      owed: linked ? (prepared?.owedCents.get(key) ?? 0) / 100 : null,
      payoff: linked && outcome?.curve ? outcome.curve.amountCents / 100 : null,
      payment: outcome?.payment
        ? { txnId: outcome.payment.txnId, occurredOn: outcome.payment.occurredOn, amount: -outcome.payment.amountCents / 100 }
        : null,
    };
  };

  return { plans, facts: { weekly: factsFor("weekly"), monthly: factsFor("monthly"), billMatched } };
}
