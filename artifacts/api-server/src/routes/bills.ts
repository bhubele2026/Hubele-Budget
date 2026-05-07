import { Router, type IRouter } from "express";
import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import {
  db,
  recurringItemsTable,
  debtsTable,
  forecastResolutionsTable,
  transactionsTable,
  avalancheSettingsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { expandItem, fmtISO } from "../lib/cashSignal";
import {
  buildDebtMinSchedule,
  buildAvalancheExtraRow,
} from "../lib/debtMinSchedule";

const router: IRouter = Router();

type RecurringRow = typeof recurringItemsTable.$inferSelect;

function todayDate(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

async function archiveExpiredOneTime(userId: string): Promise<void> {
  const todayISO = fmtISO(todayDate());
  await db
    .update(recurringItemsTable)
    .set({ active: "false" })
    .where(
      and(
        eq(recurringItemsTable.userId, userId),
        eq(recurringItemsTable.frequency, "onetime"),
        eq(recurringItemsTable.active, "true"),
        lt(recurringItemsTable.anchorDate, todayISO),
      ),
    );
}

export { archiveExpiredOneTime };

function nextOccurrenceISO(item: RecurringRow): string | null {
  const today = todayDate();
  const horizon = new Date(
    today.getFullYear() + 2,
    today.getMonth(),
    today.getDate(),
  );
  const events = expandItem(item, today, horizon);
  return events[0]?.date ?? null;
}

function monthlyAmountAbs(
  item: RecurringRow,
  from: Date,
  to: Date,
): number {
  if (item.active !== "true") return 0;
  const events = expandItem(item, from, to);
  return events.reduce((s, e) => s + Math.abs(e.amount), 0);
}

function fixed2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

router.get("/bills/summary", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  await archiveExpiredOneTime(userId);

  const items = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, userId));

  const debts = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId));

  const today = todayDate();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const monthStartISO = fmtISO(monthStart);
  const monthEndISO = fmtISO(monthEnd);

  // (#70) Cross-reference matched forecast resolutions against transactions
  // to compute the actual amount paid against each recurring item this
  // month. We pull resolutions whose occurrence_date falls in the current
  // month, then sum the absolute amount of each matched bank/card txn,
  // grouped by recurringItemId.
  const matchedRows = await db
    .select({
      recurringItemId: forecastResolutionsTable.recurringItemId,
      matchedTxnId: forecastResolutionsTable.matchedTxnId,
    })
    .from(forecastResolutionsTable)
    .where(
      and(
        eq(forecastResolutionsTable.userId, userId),
        eq(forecastResolutionsTable.status, "matched"),
        gte(forecastResolutionsTable.occurrenceDate, monthStartISO),
        lte(forecastResolutionsTable.occurrenceDate, monthEndISO),
      ),
    );
  const txnIds = Array.from(
    new Set(
      matchedRows
        .map((r) => r.matchedTxnId)
        .filter((x): x is string => !!x),
    ),
  );
  const txnAmountById = new Map<string, number>();
  if (txnIds.length > 0) {
    const txns = await db
      .select({
        id: transactionsTable.id,
        amount: transactionsTable.amount,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, userId),
          inArray(transactionsTable.id, txnIds),
        ),
      );
    for (const t of txns) {
      txnAmountById.set(t.id, Math.abs(Number(t.amount) || 0));
    }
  }
  const actualByItem = new Map<string, number>();
  for (const r of matchedRows) {
    if (!r.recurringItemId || !r.matchedTxnId) continue;
    const amt = txnAmountById.get(r.matchedTxnId);
    if (amt === undefined) continue;
    actualByItem.set(
      r.recurringItemId,
      (actualByItem.get(r.recurringItemId) ?? 0) + amt,
    );
  }

  // Build debt-min rows + figure out which recurring items are linked to a
  // debt (so we suppress them from the regular bills list to avoid double
  // counting the same payment in bills + debt minimums).
  const { rows: debtMinRows, suppressedRecurringIds } = buildDebtMinSchedule(
    debts,
    items,
    today,
  );

  // Synthetic "Avalanche extra payment" locked row — surfaces the slider
  // amount as an end-of-month bill so the Bills page totals reflect what
  // the user is committing on Avalanche. Hidden when manualExtra=0 or
  // there are no active debts to attack.
  const [avaSettings] = await db
    .select()
    .from(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, userId));
  const manualExtra = Number(avaSettings?.manualExtra ?? 0) || 0;
  const avalancheExtraRow = buildAvalancheExtraRow(debts, manualExtra, today);
  if (avalancheExtraRow) debtMinRows.push(avalancheExtraRow);

  const incomeRows: unknown[] = [];
  const billRows: unknown[] = [];
  let incomeTotal = 0;
  let billsTotal = 0;
  let active = 0;

  const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sortedItems) {
    if (suppressedRecurringIds.has(item.id)) continue;
    const monthlyAmount = monthlyAmountAbs(item, monthStart, monthEnd);
    const actualAmount = actualByItem.get(item.id) ?? 0;
    const row = {
      item,
      nextOccurrence: nextOccurrenceISO(item),
      monthlyAmount: fixed2(monthlyAmount),
      actualAmount: fixed2(actualAmount),
    };
    if (item.kind === "income") incomeRows.push(row);
    else billRows.push(row);
    if (item.active === "true") {
      active++;
      if (item.kind === "income") incomeTotal += monthlyAmount;
      else billsTotal += monthlyAmount;
    }
  }

  // debtMin total is exactly the sum of the locked debt-minimum rows so the
  // summary stays consistent with what the Bills page renders.
  const debtMin = debtMinRows.reduce(
    (s, r) => s + Math.abs(Number(r.amount) || 0),
    0,
  );
  const totalOutflow = billsTotal + debtMin;
  const net = incomeTotal - totalOutflow;

  res.json({
    income: incomeRows,
    bills: billRows,
    debtMins: debtMinRows,
    monthly: {
      income: fixed2(incomeTotal),
      bills: fixed2(billsTotal),
      debtMin: fixed2(debtMin),
      totalOutflow: fixed2(totalOutflow),
      net: fixed2(net),
      active,
      monthStart: fmtISO(monthStart),
      monthEnd: fmtISO(monthEnd),
    },
  });
});

export default router;
