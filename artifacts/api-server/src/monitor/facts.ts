import { and, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import {
  db,
  budgetLinesTable,
  forecastResolutionsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, monthBounds, weekBounds } from "@workspace/avalanche-core";
import { computeCashSignalDetailed } from "../lib/cashSignal";
import { computeBankFreshness } from "../lib/bankFreshness";
import { buildMoneyPosition, POSITION_HORIZON_DAYS } from "../lib/moneyPosition";
import { buildSpendingFacts, TRACKING_START } from "../lib/spendingFacts";
import { householdTodayISO } from "../lib/householdClock";
import { merchantSignature } from "../lib/merchantNameExtract";
import { loadGoalsWithCurrent } from "../lib/goals";
import type { BillFacts, BillPayment, CategoryFacts, MonitorFacts, RecentRow } from "./types";

// (AI-3) ONE READ of everything the detectors need, assembled once per run.
// Read-only and free: no Plaid call, no model call. The position, the cash
// signal and the freshness verdict are the spine's own (`buildMoneyPosition`
// is handed the same ledger and verdict), so a finding can never disagree with
// the Today screen about the same fact.

const TRAILING_MONTHS = 3;
const BILL_HISTORY_DAYS = 400;
const BILL_HISTORY_KEEP = 7;
const RECENT_ROW_DAYS = 3;
const RECENT_ROW_CAP = 600;
const HOUR_MS = 3600 * 1000;

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/** First day of the month `n` months before the month of `iso`. */
function monthStartBefore(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 - n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

export async function loadMonitorFacts(
  householdId: string,
  ownerUserId: string,
  todayISO: string = householdTodayISO(),
  now: Date = new Date(),
): Promise<MonitorFacts> {
  const cash = await computeCashSignalDetailed(householdId, ownerUserId, { horizonDays: POSITION_HORIZON_DAYS });
  const freshness = await computeBankFreshness(householdId, ownerUserId);
  const position = await buildMoneyPosition(householdId, ownerUserId, { cash, freshness });

  const month = monthBounds(todayISO);
  const daysInMonth = Number(month.end.slice(8, 10));
  const dayOfMonth = Number(todayISO.slice(8, 10));
  const prevEnd = addDaysISO(month.start, -1);
  const trailingStartRaw = monthStartBefore(month.start, TRAILING_MONTHS);
  const trailingStart = trailingStartRaw < TRACKING_START ? TRACKING_START : trailingStartRaw;

  const [mtd, trailing, lines, items, resolutions, recent, goals] = await Promise.all([
    buildSpendingFacts(householdId, month.start, todayISO),
    trailingStart <= prevEnd ? buildSpendingFacts(householdId, trailingStart, prevEnd) : Promise.resolve(null),
    db
      .select({ categoryId: budgetLinesTable.categoryId, planned: budgetLinesTable.plannedAmount })
      .from(budgetLinesTable)
      .where(and(eq(budgetLinesTable.householdId, householdId), eq(budgetLinesTable.monthStart, month.start))),
    db
      .select({
        id: recurringItemsTable.id,
        kind: recurringItemsTable.kind,
        active: recurringItemsTable.active,
        categoryId: recurringItemsTable.categoryId,
        debtId: recurringItemsTable.debtId,
      })
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.householdId, householdId)),
    db
      .select({
        itemId: forecastResolutionsTable.recurringItemId,
        txnId: transactionsTable.id,
        date: transactionsTable.occurredOn,
        amount: transactionsTable.amount,
      })
      .from(forecastResolutionsTable)
      .innerJoin(transactionsTable, eq(forecastResolutionsTable.matchedTxnId, transactionsTable.id))
      .where(
        and(
          eq(forecastResolutionsTable.householdId, householdId),
          eq(transactionsTable.householdId, householdId),
          eq(forecastResolutionsTable.status, "matched"),
          isNotNull(forecastResolutionsTable.recurringItemId),
          gte(transactionsTable.occurredOn, addDaysISO(todayISO, -BILL_HISTORY_DAYS)),
        ),
      )
      .orderBy(desc(transactionsTable.occurredOn))
      .limit(2000),
    db
      .select({
        id: transactionsTable.id,
        date: transactionsTable.occurredOn,
        occurredAt: transactionsTable.occurredAt,
        amount: transactionsTable.amount,
        description: transactionsTable.description,
        isTransfer: transactionsTable.isTransfer,
        isExternalCardPayment: transactionsTable.isExternalCardPayment,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          eq(transactionsTable.pending, false),
          gte(transactionsTable.occurredOn, addDaysISO(todayISO, -RECENT_ROW_DAYS)),
          lte(transactionsTable.occurredOn, todayISO),
        ),
      )
      .orderBy(desc(transactionsTable.occurredOn))
      .limit(RECENT_ROW_CAP),
    loadGoalsWithCurrent(householdId, ownerUserId),
  ]);

  // Categories: this month's spend against this month's line.
  const plannedByCat = new Map(lines.map((l) => [l.categoryId, num(l.planned)]));
  const trailingByCat = new Map<string, number>();
  if (trailing) {
    const months = Math.max(1, trailing.range.daysCovered / (365 / 12));
    for (const c of trailing.byCategory) trailingByCat.set(c.categoryId, c.total / months);
  }
  const billCategoryIds = new Set(
    items.filter((i) => i.kind === "bill" && i.active === "true" && i.categoryId).map((i) => i.categoryId as string),
  );
  const spentByCat = new Map(mtd.byCategory.map((c) => [c.categoryId, c.total]));
  const categories: CategoryFacts[] = [...plannedByCat.keys()].map((categoryId) => ({
    categoryId,
    spentMtd: spentByCat.get(categoryId) ?? 0,
    planned: plannedByCat.get(categoryId) ?? 0,
    trailingMonthlyAvg: trailingByCat.get(categoryId) ?? null,
    isBillCategory: billCategoryIds.has(categoryId),
  }));

  // Bills: confirmed matches, then the ledger's tier-2 pairs (estimates).
  const payments = new Map<string, BillPayment[]>();
  const seenTxn = new Set<string>();
  const addPayment = (itemId: string, p: BillPayment) => {
    if (seenTxn.has(p.txnId)) return;
    seenTxn.add(p.txnId);
    const list = payments.get(itemId);
    if (list) list.push(p);
    else payments.set(itemId, [p]);
  };
  for (const r of resolutions) {
    addPayment(r.itemId!, { date: r.date, amount: Math.abs(num(r.amount)), source: "matched", txnId: r.txnId });
  }
  for (const m of cash.ledger.matches) {
    if (m.tier !== 2) continue;
    addPayment(m.planItemId, {
      date: addDaysISO(m.planDate, m.dayDelta),
      amount: Math.abs(m.txnAmount),
      source: "paired",
      txnId: m.txnId,
    });
  }
  const bills: BillFacts[] = items
    .filter((i) => i.kind === "bill")
    .map((i) => ({
      itemId: i.id,
      active: i.active === "true",
      debtLinked: i.debtId !== null,
      payments: (payments.get(i.id) ?? [])
        .sort((a, b) => b.date.localeCompare(a.date) || Number(a.source !== "matched") - Number(b.source !== "matched"))
        .slice(0, BILL_HISTORY_KEEP),
    }));

  const recentRows: RecentRow[] = recent
    .filter((r) => !r.isTransfer && !r.isExternalCardPayment)
    .map((r) => {
      const at = r.occurredAt ? Date.parse(r.occurredAt) : Number.NaN;
      return {
        id: r.id,
        date: r.date,
        whenMs: Number.isFinite(at) ? at : Date.parse(`${r.date}T12:00:00Z`),
        amount: num(r.amount),
        signature: merchantSignature(r.description),
      };
    });

  const heard = [freshness.lastContactAt, cash.signal.snapshotAt]
    .filter((v): v is string => !!v)
    .map((v) => Date.parse(v))
    .filter((v) => Number.isFinite(v));
  const quietHours = heard.length ? Math.max(0, (now.getTime() - Math.max(...heard)) / HOUR_MS) : null;

  return {
    householdId,
    todayISO,
    nowMs: now.getTime(),
    position,
    freshness: { stale: freshness.stale, staleReason: freshness.staleReason, quietHours },
    month: { start: month.start, end: month.end, daysInMonth, dayOfMonth, daysLeft: daysInMonth - dayOfMonth },
    weekStart: weekBounds(todayISO).start,
    categories,
    bills,
    recentRows,
    goals,
  };
}
