import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import {
  db,
  recurringItemsTable,
  debtsTable,
  forecastResolutionsTable,
  transactionsTable,
  avalancheSettingsTable,
} from "@workspace/db";
import { expandItem, fmtISO } from "./cashSignal";
import {
  buildDebtMinSchedule,
  buildAvalancheExtraRow,
  type DebtMinRow,
} from "./debtMinSchedule";

/**
 * The Bills-summary builder.
 *
 * ⚠️ THIS IS A MOVE, NOT A REWRITE. Every line below came out of the
 * `GET /bills/summary` handler in `routes/bills.ts` unchanged; that route now
 * calls this function and serves its return value directly. It was extracted
 * the moment `/api/spine` needed "what's due next" and "how many are due",
 * because the ONLY safe way for two endpoints to agree on a bill is for them to
 * run the same code over the same rows. Deriving the next bill from the raw
 * libs instead (expandItem + buildDebtMinSchedule) would have quietly skipped
 * the suppression rules that stop a debt-linked bill being counted twice —
 * agreement by luck rather than by construction.
 */

type RecurringRow = typeof recurringItemsTable.$inferSelect;

export type BillsSummaryRow = {
  item: RecurringRow;
  nextOccurrence: string | null;
  monthlyAmount: string;
  actualAmount: string;
};

export type BillsSummary = {
  income: BillsSummaryRow[];
  bills: BillsSummaryRow[];
  debtMins: DebtMinRow[];
  monthly: {
    income: string;
    bills: string;
    debtMin: string;
    totalOutflow: string;
    net: string;
    active: number;
    monthStart: string;
    monthEnd: string;
  };
};

export function todayDate(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export async function archiveExpiredOneTime(householdId: string): Promise<void> {
  const todayISO = fmtISO(todayDate());
  await db
    .update(recurringItemsTable)
    .set({ active: "false" })
    .where(
      and(
        eq(recurringItemsTable.householdId, householdId),
        eq(recurringItemsTable.frequency, "onetime"),
        eq(recurringItemsTable.active, "true"),
        lt(recurringItemsTable.anchorDate, todayISO),
      ),
    );
}

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

function monthlyAmountAbs(item: RecurringRow, from: Date, to: Date): number {
  if (item.active !== "true") return 0;
  const events = expandItem(item, from, to);
  return events.reduce((s, e) => s + Math.abs(e.amount), 0);
}

function fixed2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export async function buildBillsSummary(
  householdId: string,
  ownerUserId: string,
  monthParam = "",
): Promise<BillsSummary> {
  await archiveExpiredOneTime(householdId);

  const items = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, householdId));

  const debts = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.householdId, householdId));

  const today = todayDate();
  // (#500) Optional ?month=YYYY-MM-01 picks which calendar month drives the
  // calendar expansion (per-row /mo hint, group totals) and matched-
  // resolution windowing (planned/actual badges). Defaults to today's
  // month so callers without the param see the prior behavior.
  const monthMatch = /^(\d{4})-(\d{2})-01$/.exec(monthParam);
  const viewYear = monthMatch ? Number(monthMatch[1]) : today.getFullYear();
  const viewMonth0 = monthMatch ? Number(monthMatch[2]) - 1 : today.getMonth();
  const monthStart = new Date(viewYear, viewMonth0, 1);
  const monthEnd = new Date(viewYear, viewMonth0 + 1, 0);
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
        eq(forecastResolutionsTable.householdId, householdId),
        eq(forecastResolutionsTable.status, "matched"),
        gte(forecastResolutionsTable.occurrenceDate, monthStartISO),
        lte(forecastResolutionsTable.occurrenceDate, monthEndISO),
      ),
    );
  const txnIds = Array.from(
    new Set(
      matchedRows.map((r) => r.matchedTxnId).filter((x): x is string => !!x),
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
          eq(transactionsTable.householdId, householdId),
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
    .where(eq(avalancheSettingsTable.userId, ownerUserId));
  const manualExtra = Number(avaSettings?.manualExtra ?? 0) || 0;
  const avalancheExtraRow = buildAvalancheExtraRow(debts, manualExtra, today);
  if (avalancheExtraRow) debtMinRows.push(avalancheExtraRow);

  const incomeRows: BillsSummaryRow[] = [];
  const billRows: BillsSummaryRow[] = [];
  let incomeTotal = 0;
  let billsTotal = 0;
  let active = 0;

  const sortedItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sortedItems) {
    if (suppressedRecurringIds.has(item.id)) continue;
    const monthlyAmount = monthlyAmountAbs(item, monthStart, monthEnd);
    const actualAmount = actualByItem.get(item.id) ?? 0;
    const row: BillsSummaryRow = {
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

  return {
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
  };
}

/**
 * "What is due next, and how much is left this month" — the two facts the
 * Bills tile states, derived from the summary ABOVE rather than from the
 * database, so they can never describe a different set of bills than the Bills
 * page does.
 *
 * These are selections over already-computed rows, not new money math: no
 * amount is added, scaled, or re-derived here — `nextBill.amount` is the exact
 * `monthlyAmount`/`amount` string the summary produced.
 *
 * - `nextBill` = the earliest upcoming occurrence across real bills AND debt
 *   minimums, on or after today. Income rows are excluded — a paycheck is not
 *   a bill. Deliberately NOT clipped to the month: on the 29th the honest
 *   answer to "what's next" is next month's rent, not "nothing".
 * - `billsDueCount` = how many of those occurrences still land inside the
 *   summary's own month window — i.e. what is left to pay this month. Clipped
 *   to the month on purpose: an unbounded "bills due" count would grow with the
 *   horizon and mean nothing.
 */
export function pickNextBill(summary: BillsSummary, today: Date): {
  nextBill: { name: string; amount: string; dueDate: string } | null;
  billsDueCount: number;
} {
  const todayISO = fmtISO(today);
  const upcoming: Array<{ name: string; amount: string; dueDate: string }> = [];

  for (const r of summary.bills) {
    if (r.item.active !== "true") continue;
    if (!r.nextOccurrence || r.nextOccurrence < todayISO) continue;
    upcoming.push({
      name: r.item.name,
      amount: r.monthlyAmount,
      dueDate: r.nextOccurrence,
    });
  }
  for (const r of summary.debtMins) {
    if (!r.nextOccurrence || r.nextOccurrence < todayISO) continue;
    // Debt-min amounts are stored negative (an outflow); the bills rows are
    // stored positive. Present one sign to the caller — magnitude, matching
    // the bills rows — so the tile never renders "-$120 due".
    upcoming.push({
      name: r.debtName,
      amount: (Math.round(Math.abs(Number(r.amount) || 0) * 100) / 100).toFixed(2),
      dueDate: r.nextOccurrence,
    });
  }

  upcoming.sort((a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0,
  );

  const monthEnd = summary.monthly.monthEnd;
  return {
    nextBill: upcoming[0] ?? null,
    billsDueCount: upcoming.filter((u) => u.dueDate <= monthEnd).length,
  };
}
