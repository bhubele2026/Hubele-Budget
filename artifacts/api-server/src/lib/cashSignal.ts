import { and, eq, gte, lte } from "drizzle-orm";
import {
  db,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
} from "@workspace/db";

type Cadence =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "onetime";

type RecurringRow = typeof recurringItemsTable.$inferSelect;

export type CashEvent = {
  date: string;
  itemId: string;
  label: string;
  kind: "income" | "expense";
  amount: number;
};

export function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
}

function setSafeDay(year: number, monthIdx: number, day: number): Date {
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return new Date(year, monthIdx, Math.min(day, lastDay));
}

export function expandItem(item: RecurringRow, from: Date, to: Date): CashEvent[] {
  if (item.active !== "true") return [];
  const out: CashEvent[] = [];
  const kind: "income" | "expense" = item.kind === "income" ? "income" : "expense";
  const sign = kind === "income" ? 1 : -1;
  const amt = Math.abs(Number(item.amount) || 0);
  const anchor = item.anchorDate ? parseISO(item.anchorDate) : from;

  const push = (d: Date) => {
    if (d < from || d > to) return;
    out.push({ date: fmtISO(d), itemId: item.id, label: item.name, kind, amount: sign * amt });
  };

  switch (item.frequency as Cadence) {
    case "onetime":
      push(anchor);
      break;
    case "weekly": {
      let cur = anchor;
      while (cur > from) cur = addDays(cur, -7);
      while (cur < from) cur = addDays(cur, 7);
      while (cur <= to) {
        push(cur);
        cur = addDays(cur, 7);
      }
      break;
    }
    case "biweekly": {
      let cur = anchor;
      while (cur > from) cur = addDays(cur, -14);
      while (cur < from) cur = addDays(cur, 14);
      while (cur <= to) {
        push(cur);
        cur = addDays(cur, 14);
      }
      break;
    }
    case "monthly": {
      const day = item.dayOfMonth ?? anchor.getDate();
      let y = from.getFullYear(),
        m = from.getMonth();
      const anchorFirst = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const fromFirst = new Date(from.getFullYear(), from.getMonth(), 1);
      if (anchorFirst > fromFirst) {
        y = anchor.getFullYear();
        m = anchor.getMonth();
      }
      let cur = setSafeDay(y, m, day);
      while (cur < from) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cur = setSafeDay(y, m, day);
      }
      while (cur <= to) {
        push(cur);
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cur = setSafeDay(y, m, day);
      }
      break;
    }
    case "semimonthly": {
      const d1 = item.dayOfMonth ?? anchor.getDate();
      const d2 = ((d1 + 14 - 1) % 30) + 1;
      let y = from.getFullYear(),
        m = from.getMonth();
      const days = [Math.min(d1, d2), Math.max(d1, d2)];
      while (true) {
        const a = setSafeDay(y, m, days[0]);
        const b = setSafeDay(y, m, days[1]);
        if (a > to && b > to) break;
        push(a);
        push(b);
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
      }
      break;
    }
    case "quarterly": {
      let cur = anchor;
      while (cur > from) cur = addMonths(cur, -3);
      while (cur < from) cur = addMonths(cur, 3);
      while (cur <= to) {
        push(cur);
        cur = addMonths(cur, 3);
      }
      break;
    }
    case "annual": {
      let cur = anchor;
      while (cur > from) cur = addMonths(cur, -12);
      while (cur < from) cur = addMonths(cur, 12);
      while (cur <= to) {
        push(cur);
        cur = addMonths(cur, 12);
      }
      break;
    }
  }
  return out;
}

export type CashSignal = {
  bankToday: string;
  lowestProjected: string;
  lowestDate: string | null;
  cashBuffer: string;
  status: "ready" | "tight" | "not_yet" | "no_data";
  maxSafeExtra: string;
  snapshotAt: string | null;
  snapshotSource: string | null;
  horizonDays?: number;
  fromDate?: string;
  toDate?: string;
  startingBalance?: string;
  endingBalance?: string;
  endingDate?: string | null;
  projectedIncome?: string;
  projectedExpenses?: string;
  acceptedImpact?: string;
  daily?: Array<{ date: string; balance: string }>;
};

function r2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Compute the cash signal: today's bank balance + projection of lowest balance.
 *
 * Anchored on the bank snapshot when present:
 *   - Skip planned events whose date is on/before the snapshot date (already baked in).
 *   - Skip checking transactions on/before the snapshot date (already counted).
 */
export async function computeCashSignal(
  userId: string,
  opts: { horizonDays?: number; fromDate?: string } = {},
): Promise<CashSignal> {
  const [settings] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, userId));
  const cashBuffer = Number(settings?.cashBuffer ?? 500) || 0;
  const daysAhead = opts.horizonDays ?? settings?.daysAhead ?? 90;

  const today = new Date();
  const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const fromDateOnly = opts.fromDate ? parseISO(opts.fromDate) : todayDateOnly;
  const fromISO = fmtISO(fromDateOnly);
  const to = addDays(fromDateOnly, daysAhead);
  const toISO = fmtISO(to);

  const snapshotBalance = settings?.bankSnapshotBalance != null
    ? Number(settings.bankSnapshotBalance)
    : null;
  const snapshotAt = settings?.bankSnapshotAt ?? null;
  const snapshotISO = snapshotAt ? fmtISO(snapshotAt) : null;

  // No snapshot → fall back to startingBalance
  const startBalanceAtAnchor = snapshotBalance ?? (Number(settings?.startingBalance ?? 0) || 0);
  // Anchor: events strictly AFTER snapshot date are projected; if no snapshot, project from today
  const anchorISO = snapshotISO ?? fmtISO(todayDateOnly);
  // Expansion start: cover from min(anchor, fromDate) so we can roll the
  // balance forward to fromDate even when fromDate > anchor.
  const expandStart = anchorISO < fromISO ? parseISO(anchorISO) : fromDateOnly;

  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, userId));
  const events: CashEvent[] = [];
  for (const item of recurring) events.push(...expandItem(item, expandStart, to));

  // Pull future-anchored checking transactions (forecast_flag and reflecting bank movement after snapshot)
  const txns = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        eq(transactionsTable.forecastFlag, true),
        gte(transactionsTable.occurredOn, anchorISO),
        lte(transactionsTable.occurredOn, toISO),
      ),
    );

  // Get matched-resolutions to suppress double-count of plan items already paid for by a txn
  const resolutions = await db
    .select()
    .from(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, userId));
  const matchedPlanKeys = new Set<string>();
  const matchedTxnIds = new Set<string>();
  for (const r of resolutions) {
    if (r.status === "matched") {
      if (r.recurringItemId && r.occurrenceDate) {
        matchedPlanKeys.add(`${r.recurringItemId}|${r.occurrenceDate}`);
      }
      if (r.matchedTxnId) matchedTxnIds.add(r.matchedTxnId);
    }
  }

  type Item = { date: string; amount: number; matched: boolean };
  const items: Item[] = [];
  for (const ev of events) {
    if (ev.date <= anchorISO) continue; // already baked into snapshot
    const matched = matchedPlanKeys.has(`${ev.itemId}|${ev.date}`);
    if (matched) continue;
    items.push({ date: ev.date, amount: ev.amount, matched: false });
  }
  for (const t of txns) {
    if (t.occurredOn <= anchorISO) continue;
    items.push({
      date: t.occurredOn,
      amount: Number(t.amount) || 0,
      matched: matchedTxnIds.has(t.id),
    });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Roll the balance forward from anchor up to (but not including) fromDate
  // so `startingBalance` reflects what the bank should be on the chart's
  // first day.
  let bal = startBalanceAtAnchor;
  for (const it of items) {
    if (it.date >= fromISO) break;
    bal = Math.round((bal + it.amount) * 100) / 100;
  }
  const startingBalance = bal;

  // Build daily series in [fromDate, toDate] and gather window stats.
  const totalDays = Math.round((to.getTime() - fromDateOnly.getTime()) / 86_400_000) + 1;
  const daily: Array<{ date: string; balance: string }> = [];
  let lowest = startingBalance;
  let lowestDate: string | null = null;
  let projectedIncome = 0;
  let projectedExpenses = 0;
  let acceptedImpact = 0;

  let cursor = 0;
  // Skip items before window (already applied above)
  while (cursor < items.length && items[cursor].date < fromISO) cursor++;

  for (let i = 0; i < totalDays; i++) {
    const d = addDays(fromDateOnly, i);
    const dISO = fmtISO(d);
    while (cursor < items.length && items[cursor].date <= dISO) {
      const it = items[cursor];
      bal = Math.round((bal + it.amount) * 100) / 100;
      if (it.amount > 0) projectedIncome += it.amount;
      else projectedExpenses += -it.amount;
      if (it.matched) acceptedImpact += it.amount;
      cursor++;
    }
    if (bal < lowest) {
      lowest = bal;
      lowestDate = dISO;
    }
    daily.push({ date: dISO, balance: r2(bal) });
  }
  const endingBalance = bal;
  const endingDate = toISO;

  const headroom = Math.max(0, lowest - cashBuffer);
  let status: CashSignal["status"];
  if (snapshotBalance == null) status = "no_data";
  else if (lowest >= cashBuffer + 200) status = "ready";
  else if (lowest >= cashBuffer) status = "tight";
  else status = "not_yet";

  return {
    bankToday: r2(startBalanceAtAnchor),
    lowestProjected: r2(lowest),
    lowestDate,
    cashBuffer: r2(cashBuffer),
    status,
    maxSafeExtra: r2(headroom),
    snapshotAt: snapshotAt ? snapshotAt.toISOString() : null,
    snapshotSource: settings?.bankSnapshotSource ?? null,
    horizonDays: daysAhead,
    fromDate: fromISO,
    toDate: toISO,
    startingBalance: r2(startingBalance),
    endingBalance: r2(endingBalance),
    endingDate,
    projectedIncome: r2(projectedIncome),
    projectedExpenses: r2(projectedExpenses),
    acceptedImpact: r2(acceptedImpact),
    daily,
  };
}
