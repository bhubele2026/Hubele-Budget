export type Cadence =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "onetime";

export type RecurringLite = {
  id: string;
  kind: string;
  name: string;
  amount: string | number;
  frequency: string;
  dayOfMonth: number | null;
  anchorDate: string | null;
  active: string | boolean;
};

export type CashEvent = {
  date: string;
  itemId: string;
  label: string;
  kind: "income" | "expense";
  amount: number;
};

const MS_DAY = 86_400_000;

function parseISO(s: string): Date {
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

function isActive(item: RecurringLite): boolean {
  return typeof item.active === "boolean" ? item.active : item.active === "true";
}

export function expandItem(
  item: RecurringLite,
  from: Date,
  to: Date,
): CashEvent[] {
  if (!isActive(item)) return [];
  const out: CashEvent[] = [];
  const kind: "income" | "expense" = item.kind === "income" ? "income" : "expense";
  const sign = kind === "income" ? 1 : -1;
  const amt = Math.abs(Number(item.amount) || 0);
  const anchor = item.anchorDate ? parseISO(item.anchorDate) : from;

  const push = (d: Date) => {
    if (d < from || d > to) return;
    out.push({
      date: fmtISO(d),
      itemId: item.id,
      label: item.name,
      kind,
      amount: sign * amt,
    });
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

export function expandAll(
  items: RecurringLite[],
  from: Date,
  to: Date,
): CashEvent[] {
  const events: CashEvent[] = [];
  for (const item of items) events.push(...expandItem(item, from, to));
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}

export type DayBucket = {
  date: string;
  income: number;
  expense: number;
  net: number;
  balance: number;
  events: CashEvent[];
};

export function buildDaily(
  events: CashEvent[],
  startBalance: number,
  from: Date,
  to: Date,
): DayBucket[] {
  const byDate = new Map<string, CashEvent[]>();
  for (const e of events) {
    const arr = byDate.get(e.date) ?? [];
    arr.push(e);
    byDate.set(e.date, arr);
  }
  const days: DayBucket[] = [];
  let bal = startBalance;
  const totalDays = Math.round((to.getTime() - from.getTime()) / MS_DAY) + 1;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(from, i);
    const key = fmtISO(d);
    const evs = byDate.get(key) ?? [];
    let income = 0,
      expense = 0;
    for (const e of evs) {
      if (e.amount > 0) income += e.amount;
      else expense += -e.amount;
    }
    const net = income - expense;
    bal = Math.round((bal + net) * 100) / 100;
    days.push({ date: key, income, expense, net, balance: bal, events: evs });
  }
  return days;
}

export function aggregateMonthly(days: DayBucket[]): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  const order: string[] = [];
  for (const d of days) {
    const key = d.date.slice(0, 7) + "-01";
    if (!buckets.has(key)) {
      buckets.set(key, {
        date: key,
        income: 0,
        expense: 0,
        net: 0,
        balance: d.balance,
        events: [],
      });
      order.push(key);
    }
    const b = buckets.get(key)!;
    b.income += d.income;
    b.expense += d.expense;
    b.net += d.net;
    b.balance = d.balance;
    b.events.push(...d.events);
  }
  return order.map((k) => buckets.get(k)!);
}
