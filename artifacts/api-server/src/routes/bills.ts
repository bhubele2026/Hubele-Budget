import { Router, type IRouter } from "express";
import { and, eq, lt } from "drizzle-orm";
import { db, recurringItemsTable, debtsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { expandItem, fmtISO } from "../lib/cashSignal";

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

  const incomeRows: unknown[] = [];
  const billRows: unknown[] = [];
  let incomeTotal = 0;
  let billsTotal = 0;
  let active = 0;

  const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sortedItems) {
    const monthlyAmount = monthlyAmountAbs(item, monthStart, monthEnd);
    const row = {
      item,
      nextOccurrence: nextOccurrenceISO(item),
      monthlyAmount: fixed2(monthlyAmount),
    };
    if (item.kind === "income") incomeRows.push(row);
    else billRows.push(row);
    if (item.active === "true") {
      active++;
      if (item.kind === "income") incomeTotal += monthlyAmount;
      else billsTotal += monthlyAmount;
    }
  }

  let debtMin = 0;
  for (const d of debts) {
    if (d.status && d.status !== "active") continue;
    debtMin += Math.abs(Number(d.minPayment) || 0);
  }
  const totalOutflow = billsTotal + debtMin;
  const net = incomeTotal - totalOutflow;

  res.json({
    income: incomeRows,
    bills: billRows,
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
