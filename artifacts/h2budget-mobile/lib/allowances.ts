import type { Settings, Txn } from "./api";

const DAY = 86_400_000;

/** Sunday that opens the week containing `d` (local). */
export function sundayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - out.getDay());
  return out;
}
export function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function lastOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
export function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Outflow magnitude (expense) for a transaction; income/refunds → 0. */
function expense(t: Txn): number {
  const n = Number(t.amount) || 0;
  if (n >= 0 || t.isTransfer || t.reimbursable) return 0;
  return Math.abs(n);
}

export type BucketStatus = {
  key: "weekly" | "monthly";
  label: string;
  spent: number;
  planned: number;
  /** spent - planned; positive = over. */
  variance: number;
  pct: number; // 0..1+
  rangeLabel: string;
};

/**
 * Compute the two figures that matter: this week's weekly-allowance spend and
 * this month's monthly-allowance spend, each vs its planned amount.
 */
export function computeStatus(
  settings: Settings | undefined,
  txns: Txn[],
  now = new Date(),
): { weekly: BucketStatus; monthly: BucketStatus } {
  const weekStart = sundayOf(now);
  const weekEnd = new Date(weekStart.getTime() + 6 * DAY);
  const monthStart = firstOfMonth(now);
  const monthEnd = lastOfMonth(now);

  const wFrom = iso(weekStart);
  const wTo = iso(weekEnd);
  const mFrom = iso(monthStart);
  const mTo = iso(monthEnd);

  let weeklySpent = 0;
  let monthlySpent = 0;
  for (const t of txns) {
    const amt = expense(t);
    if (amt === 0) continue;
    if (t.weeklyAllowance && t.occurredOn >= wFrom && t.occurredOn <= wTo) {
      weeklySpent += amt;
    }
    if (t.monthlyAllowance && t.occurredOn >= mFrom && t.occurredOn <= mTo) {
      monthlySpent += amt;
    }
  }

  const weeklyPlanned = Number(settings?.weeklyAllowanceAmount) || 0;
  const monthlyPlanned = Number(settings?.monthlyAllowanceAmount) || 0;

  const fmtRange = (a: Date, b: Date) => {
    const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${a.toLocaleDateString(undefined, o)} – ${b.toLocaleDateString(undefined, o)}`;
  };

  return {
    weekly: {
      key: "weekly",
      label: "Weekly",
      spent: weeklySpent,
      planned: weeklyPlanned,
      variance: weeklySpent - weeklyPlanned,
      pct: weeklyPlanned > 0 ? weeklySpent / weeklyPlanned : 0,
      rangeLabel: fmtRange(weekStart, weekEnd),
    },
    monthly: {
      key: "monthly",
      label: "Monthly",
      spent: monthlySpent,
      planned: monthlyPlanned,
      variance: monthlySpent - monthlyPlanned,
      pct: monthlyPlanned > 0 ? monthlySpent / monthlyPlanned : 0,
      rangeLabel: now.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      }),
    },
  };
}
