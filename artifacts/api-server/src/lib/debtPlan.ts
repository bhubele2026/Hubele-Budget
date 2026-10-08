import { and, eq, gte, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import {
  avalancheSettingsTable,
  db,
  debtLedgerEventsTable,
  debtMilestonesTable,
  debtsTable,
  forecastResolutionsTable,
  transactionsTable,
} from "@workspace/db";
import {
  addDaysISO,
  CENTS,
  compareStrategies,
  debtFreeRange,
  effectiveDebtBalance,
  milestonesFor,
  monthBounds,
  pairTransfers,
  planAssumptions,
  round2,
  simulate,
  type DebtFreeRange,
  type Milestone,
  type PlanAssumption,
  type PlanDebt,
  type Strategy,
  type StrategyComparison,
  type TransferCandidate,
} from "@workspace/avalanche-core";
import type { CashSignal } from "./cashSignal";
import { AVALANCHE_EXTRA_EVENT_ITEM_ID } from "./debtMinSchedule";
import { withPendingPayments } from "./debtPending";
import { depositoryAccountIds } from "./debtPaymentConfirm";
import { householdTodayISO } from "./householdClock";

/**
 * (PR-D) ⭐ THE DEBT PLAN — strategies, a debt-free range, milestones, and
 * planned vs confirmed payments. `GET /debt-plan` returns `computeDebtPlan`;
 * the spine's `debt.nextMilestone` / `debt.paidDownMtd` are
 * `computeDebtHeadline`, which `computeDebtPlan` itself calls — one function,
 * so the two can never disagree (spineParity asserts it to the cent).
 *
 * Inputs, all read-only:
 *   - debts, NETTED (`withPendingPayments` → `effectiveDebtBalance`): Brad's
 *     "net the pending payments everywhere";
 *   - the plan the forecast already runs: `avalanche_settings.strategy` and
 *     `manual_extra` (the same extra `expandAvalancheExtra` puts on the curve);
 *   - the cash signal both callers already hold (90-day horizon), for the
 *     planned payments on the curve and the overdue ones a bank row paid.
 * No Plaid call, no write.
 */

/** Months are the household's (America/Chicago). */
function currentMonthKey(todayISO: string): string {
  return todayISO.slice(0, 7);
}

/** The household's debts as the plan reads them (netted), plus the simulator's participants. */
export async function loadPlanDebts(householdId: string): Promise<{ all: PlanDebt[]; sim: PlanDebt[] }> {
  const rows = await db.select().from(debtsTable).where(eq(debtsTable.householdId, householdId));
  const netted = await withPendingPayments(householdId, rows);
  const all: PlanDebt[] = netted
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: Number(d.apr) || 0,
      balance: effectiveDebtBalance(d),
      minPayment: Number(d.minPayment) || 0,
      status: d.status,
      minPaymentSource: d.minPaymentSource,
      aprSource: d.aprSource,
      balanceSource: d.balanceSource,
      originalBalance: d.originalBalance == null ? null : Number(d.originalBalance),
      type: d.type,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  // `computeAvalanchePayoffFacts`' participation rule: active, a live balance
  // and a positive minimum — so the plan and the Avalanche facts drive payoff
  // from the same debts.
  const sim = all.filter((d) => (d.status ?? "active") === "active" && d.balance > CENTS && d.minPayment > 0);
  return { all, sim };
}

export async function loadPlanSettings(ownerUserId: string): Promise<{ strategy: Strategy; extraMonthly: number }> {
  const [row] = await db
    .select({ strategy: avalancheSettingsTable.strategy, manualExtra: avalancheSettingsTable.manualExtra })
    .from(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, ownerUserId));
  return {
    strategy: row?.strategy === "snowball" ? "snowball" : "avalanche",
    extraMonthly: round2(Math.max(0, Number(row?.manualExtra ?? 0) || 0)),
  };
}

export type ConfirmedPayment = {
  txnId: string;
  debtId: string | null;
  occurredOn: string;
  /** Paid amount (≥ 0). */
  amount: number;
  via: "resolution" | "assumed_paid" | "debt_tag" | "claim";
};

/**
 * ⭐ CONFIRMED = A BANK ROW SAYS SO. Each bank row once, from any of:
 *   - a `matched` / `partial` forecast resolution on a debt plan item
 *     (`debt:<id>`) or the Avalanche extra;
 *   - an overdue debt plan the forecast took as paid on `debt_tag` or
 *     `card_payment` evidence (`overdueAssumedPaid`);
 *   - a Plaid row on a depository account tagged to a debt;
 *   - the bank row that confirmed a claim (`confirmed_by_txn_id`).
 * Dated in [from, to]. Money out only.
 */
export async function loadConfirmedPayments(
  householdId: string,
  signal: Pick<CashSignal, "overdueAssumedPaid">,
  fromISO: string,
  toISO: string,
): Promise<ConfirmedPayment[]> {
  const debtOfItem = (itemId: string): string | null =>
    itemId.startsWith("debt:") ? itemId.slice("debt:".length) : null;
  const isDebtPlanItem = (itemId: string | null) =>
    !!itemId && (itemId.startsWith("debt:") || itemId === AVALANCHE_EXTRA_EVENT_ITEM_ID);

  const via = new Map<string, { debtId: string | null; via: ConfirmedPayment["via"] }>();
  const note = (txnId: string | null, debtId: string | null, v: ConfirmedPayment["via"]) => {
    if (!txnId) return;
    const cur = via.get(txnId);
    if (!cur || (!cur.debtId && debtId)) via.set(txnId, { debtId: debtId ?? cur?.debtId ?? null, via: cur?.via ?? v });
  };

  const resolutions = await db
    .select({ itemId: forecastResolutionsTable.recurringItemId, txnId: forecastResolutionsTable.matchedTxnId })
    .from(forecastResolutionsTable)
    .where(
      and(
        eq(forecastResolutionsTable.householdId, householdId),
        inArray(forecastResolutionsTable.status, ["matched", "partial"]),
        isNotNull(forecastResolutionsTable.matchedTxnId),
        or(
          sql`${forecastResolutionsTable.recurringItemId} LIKE 'debt:%'`,
          eq(forecastResolutionsTable.recurringItemId, AVALANCHE_EXTRA_EVENT_ITEM_ID),
        ),
      ),
    );
  for (const r of resolutions) note(r.txnId, debtOfItem(r.itemId ?? ""), "resolution");

  for (const p of signal.overdueAssumedPaid ?? []) {
    if (!isDebtPlanItem(p.itemId)) continue;
    if (p.confidence !== "debt_tag" && p.confidence !== "card_payment") continue;
    note(p.txnId, debtOfItem(p.itemId), "assumed_paid");
  }

  const t = transactionsTable;
  const accounts = await depositoryAccountIds(householdId);
  const [tagged, claims] = await Promise.all([
    accounts.length === 0
      ? Promise.resolve([] as Array<{ id: string; debtId: string | null }>)
      : db
          .select({ id: t.id, debtId: t.debtId })
          .from(t)
          .where(
            and(
              eq(t.householdId, householdId),
              inArray(t.plaidAccountId, accounts),
              isNotNull(t.debtId),
              lt(t.amount, "0"),
              gte(t.occurredOn, fromISO),
              lte(t.occurredOn, toISO),
            ),
          ),
    db
      .select({ bankTxnId: t.confirmedByTxnId, debtId: t.debtId })
      .from(t)
      .where(and(eq(t.householdId, householdId), eq(t.paymentState, "confirmed"), isNotNull(t.confirmedByTxnId))),
  ]);
  for (const r of tagged) note(r.id, r.debtId, "debt_tag");
  for (const c of claims) note(c.bankTxnId, c.debtId, "claim");

  const ids = [...via.keys()];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: t.id, occurredOn: t.occurredOn, amount: t.amount })
    .from(t)
    .where(
      and(
        eq(t.householdId, householdId),
        inArray(t.id, ids),
        lt(t.amount, "0"),
        gte(t.occurredOn, fromISO),
        lte(t.occurredOn, toISO),
      ),
    );
  return rows
    .map((r) => ({
      txnId: r.id,
      debtId: via.get(r.id)!.debtId,
      occurredOn: r.occurredOn,
      amount: Math.abs(Number(r.amount) || 0),
      via: via.get(r.id)!.via,
    }))
    .sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.txnId.localeCompare(b.txnId));
}

/**
 * Confirmed payments, less those that were half of a transfer pair against a
 * charge or draw on ANOTHER of the household's debts (±5 days, ±1%): moving a
 * debt is not paying it down. A paid amount, never a balance.
 */
export async function genuinePaidDown(
  householdId: string,
  payments: readonly ConfirmedPayment[],
  fromISO: string,
  toISO: string,
): Promise<{ confirmed: number; genuine: number; transferTxnIds: string[] }> {
  const confirmedCents = payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);
  const charges = await db
    .select({
      id: debtLedgerEventsTable.id,
      debtId: debtLedgerEventsTable.debtId,
      amount: debtLedgerEventsTable.amount,
      occurredOn: debtLedgerEventsTable.occurredOn,
    })
    .from(debtLedgerEventsTable)
    .where(
      and(
        eq(debtLedgerEventsTable.householdId, householdId),
        eq(debtLedgerEventsTable.kind, "charge"),
        gte(debtLedgerEventsTable.occurredOn, addDaysISO(fromISO, -5)),
        lte(debtLedgerEventsTable.occurredOn, addDaysISO(toISO, 5)),
      ),
    );
  const paymentCands: TransferCandidate[] = payments
    .filter((p) => p.debtId)
    .map((p) => ({ id: p.txnId, debtId: p.debtId!, amount: p.amount, occurredOn: p.occurredOn }));
  const chargeCands: TransferCandidate[] = charges.map((c) => ({
    id: c.id,
    debtId: c.debtId,
    amount: Number(c.amount) || 0,
    occurredOn: c.occurredOn,
  }));
  const paired = pairTransfers(paymentCands, chargeCands);
  let transferCents = 0;
  for (const p of payments) if (paired.has(p.txnId)) transferCents += Math.round(p.amount * 100);
  return {
    confirmed: confirmedCents / 100,
    genuine: (confirmedCents - transferCents) / 100,
    transferTxnIds: [...paired.keys()].sort(),
  };
}

export type NextMilestone = { key: string; label: string; estimatedMonth: string };

export type DebtHeadline = {
  nextMilestone: { label: string; estimatedMonth: string } | null;
  /** Genuine confirmed payments this household month. A paid amount — never a balance. */
  paidDownMtd: number;
};

type HeadlineInternals = DebtHeadline & {
  next: NextMilestone | null;
  upcoming: Milestone[];
  achieved: Array<{ key: string; label: string; debtId: string | null; achievedOn: string }>;
  confirmedMtd: number;
  plan: { strategy: Strategy; extraMonthly: number };
  debts: { all: PlanDebt[]; sim: PlanDebt[] };
  monthKey: string;
};

async function computeHeadlineInternals(
  householdId: string,
  ownerUserId: string,
  signal: Pick<CashSignal, "overdueAssumedPaid">,
): Promise<HeadlineInternals> {
  const todayISO = householdTodayISO();
  const monthKey = currentMonthKey(todayISO);
  const { start: monthStart } = monthBounds(todayISO);
  const [debts, plan, achievedRows] = await Promise.all([
    loadPlanDebts(householdId),
    loadPlanSettings(ownerUserId),
    db
      .select({
        key: debtMilestonesTable.key,
        label: debtMilestonesTable.label,
        debtId: debtMilestonesTable.debtId,
        achievedOn: debtMilestonesTable.achievedOn,
      })
      .from(debtMilestonesTable)
      .where(eq(debtMilestonesTable.householdId, householdId)),
  ]);
  const achieved = achievedRows.sort(
    (a, b) => a.achievedOn.localeCompare(b.achievedOn) || a.key.localeCompare(b.key),
  );
  const achievedKeys = new Set(achieved.map((a) => a.key));
  const sim = simulate({
    debts: debts.sim,
    extraPerMonth: plan.extraMonthly,
    strategy: plan.strategy,
    startDate: new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 1),
  });
  const upcoming = milestonesFor(sim, debts.all).filter((m) => !achievedKeys.has(m.key));
  const first = upcoming[0];
  const next = first ? { key: first.key, label: first.label, estimatedMonth: first.estimatedMonth } : null;

  const payments = await loadConfirmedPayments(householdId, signal, monthStart, todayISO);
  const paid = await genuinePaidDown(householdId, payments, monthStart, todayISO);
  return {
    nextMilestone: next ? { label: next.label, estimatedMonth: next.estimatedMonth } : null,
    paidDownMtd: paid.genuine,
    next,
    upcoming,
    achieved,
    confirmedMtd: paid.confirmed,
    plan,
    debts,
    monthKey,
  };
}

/** The spine's two debt fields. `computeDebtPlan` returns the same values. */
export async function computeDebtHeadline(
  householdId: string,
  ownerUserId: string,
  signal: Pick<CashSignal, "overdueAssumedPaid">,
): Promise<DebtHeadline> {
  const h = await computeHeadlineInternals(householdId, ownerUserId, signal);
  return { nextMilestone: h.nextMilestone, paidDownMtd: h.paidDownMtd };
}

export type PlannedPayment = {
  date: string;
  itemId: string;
  debtId: string | null;
  label: string;
  /** Planned paid amount (≥ 0). */
  amount: number;
};

export type DebtPlan = {
  asOf: string;
  strategy: Strategy;
  extraMonthly: number;
  /**
   * ⚠️ `comparison.detail` IS THE ONE PLACE IN THIS PAYLOAD THAT CARRIES A
   * BALANCE — per debt, for the Plan › Debt page, which is not a landing
   * surface. The no-balance law test walks every other key of this payload.
   */
  comparison: StrategyComparison & {
    detail: {
      debts: Array<{
        debtId: string;
        name: string;
        apr: number;
        balance: number;
        minPayment: number;
        minPaymentSource: string | null;
      }>;
    };
  };
  range: Omit<DebtFreeRange, "runs"> & {
    runs: DebtFreeRange["runs"];
    newChargesPerMonth: number;
  };
  milestones: {
    achieved: Array<{ key: string; label: string; debtId: string | null; achievedOn: string }>;
    next: NextMilestone | null;
    upcoming: Milestone[];
  };
  planned60d: PlannedPayment[];
  confirmedMtd: number;
  paidDownGenuineMtd: number;
  assumptions: PlanAssumption[];
};

/** The window measured for "new charges as measured": the 90 days before today. */
export const NEW_CHARGES_WINDOW_DAYS = 90;

/**
 * New charges a month, as measured: charges on the plan's debts' own feeds
 * (`debt_ledger_events`, kind `charge`, transfer halves excluded) over the 90
 * days before today, ÷ 3. Zero when no debt has a feed.
 */
export async function measuredNewChargesPerMonth(
  householdId: string,
  debtIds: readonly string[],
  todayISO: string,
): Promise<number> {
  if (debtIds.length === 0) return 0;
  const from = addDaysISO(todayISO, -NEW_CHARGES_WINDOW_DAYS);
  const to = addDaysISO(todayISO, -1);
  const events = await db
    .select({
      id: debtLedgerEventsTable.id,
      debtId: debtLedgerEventsTable.debtId,
      kind: debtLedgerEventsTable.kind,
      amount: debtLedgerEventsTable.amount,
      occurredOn: debtLedgerEventsTable.occurredOn,
    })
    .from(debtLedgerEventsTable)
    .where(
      and(
        eq(debtLedgerEventsTable.householdId, householdId),
        inArray(debtLedgerEventsTable.kind, ["charge", "payment"]),
        gte(debtLedgerEventsTable.occurredOn, addDaysISO(from, -5)),
        lte(debtLedgerEventsTable.occurredOn, addDaysISO(to, 5)),
      ),
    );
  const cand = (e: (typeof events)[number]): TransferCandidate => ({
    id: e.id,
    debtId: e.debtId,
    amount: Number(e.amount) || 0,
    occurredOn: e.occurredOn,
  });
  const paired = pairTransfers(
    events.filter((e) => e.kind === "payment").map(cand),
    events.filter((e) => e.kind === "charge").map(cand),
  );
  const transferCharges = new Set(paired.values());
  const wanted = new Set(debtIds);
  let cents = 0;
  for (const e of events) {
    if (e.kind !== "charge" || !wanted.has(e.debtId) || transferCharges.has(e.id)) continue;
    if (e.occurredOn < from || e.occurredOn > to) continue;
    cents += Math.round((Number(e.amount) || 0) * 100);
  }
  return round2(cents / 100 / (NEW_CHARGES_WINDOW_DAYS / 30));
}

export async function computeDebtPlan(
  householdId: string,
  ownerUserId: string,
  signal: Pick<CashSignal, "overdueAssumedPaid" | "events">,
): Promise<DebtPlan> {
  const h = await computeHeadlineInternals(householdId, ownerUserId, signal);
  const todayISO = householdTodayISO();
  const { strategy, extraMonthly } = h.plan;
  const startISO = h.monthKey;
  const comparison = compareStrategies(h.debts.sim, extraMonthly, startISO);
  const newChargesPerMonth = await measuredNewChargesPerMonth(
    householdId,
    h.debts.sim.map((d) => d.id),
    todayISO,
  );
  const range = debtFreeRange(h.debts.sim, extraMonthly, newChargesPerMonth, { strategy, startISO });

  const horizon = addDaysISO(todayISO, 60);
  const planned60d: PlannedPayment[] = (signal.events ?? [])
    .filter(
      (e) =>
        (e.itemId.startsWith("debt:") || e.itemId === AVALANCHE_EXTRA_EVENT_ITEM_ID) &&
        e.date >= todayISO &&
        e.date <= horizon &&
        Number(e.amount) < 0,
    )
    .map((e) => ({
      date: e.date,
      itemId: e.itemId,
      debtId: e.itemId.startsWith("debt:") ? e.itemId.slice("debt:".length) : null,
      label: e.label,
      amount: round2(Math.abs(Number(e.amount) || 0)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.itemId.localeCompare(b.itemId));

  return {
    asOf: new Date().toISOString(),
    strategy,
    extraMonthly,
    comparison: {
      ...comparison,
      detail: {
        debts: h.debts.sim.map((d) => ({
          debtId: d.id,
          name: d.name,
          apr: d.apr,
          balance: round2(d.balance),
          minPayment: round2(d.minPayment),
          minPaymentSource: d.minPaymentSource ?? null,
        })),
      },
    },
    range: { ...range, newChargesPerMonth },
    milestones: { achieved: h.achieved, next: h.next, upcoming: h.upcoming },
    planned60d,
    confirmedMtd: h.confirmedMtd,
    paidDownGenuineMtd: h.paidDownMtd,
    assumptions: planAssumptions(h.debts.sim, newChargesPerMonth),
  };
}
