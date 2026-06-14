import type { Settings, Txn } from "./api";

const DAY = 86_400_000;

export type WeeklyStreak = { weeks: number; direction: "under" | "over" | "none" };

/**
 * Trailing run of COMPLETED weeks that all landed the same side of the weekly
 * allowance — `under` (good) or `over`. Walks back from last week, stops at the
 * first week that flips direction or has no spend.
 */
export function weeklyStreak(
  txns: Txn[],
  weeklyAmt: number,
  now = new Date(),
): WeeklyStreak {
  if (weeklyAmt <= 0) return { weeks: 0, direction: "none" };
  const isoOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  let weekSun = new Date(sundayOf(now).getTime() - 7 * DAY); // last completed week
  let direction: "under" | "over" | "none" = "none";
  let weeks = 0;
  for (let i = 0; i < 26; i++) {
    const start = isoOf(weekSun);
    const end = isoOf(new Date(weekSun.getTime() + 6 * DAY));
    let spend = 0;
    let any = false;
    for (const t of txns) {
      if (!t.weeklyAllowance || t.reimbursable) continue;
      if (t.occurredOn >= start && t.occurredOn <= end) {
        const a = Number(t.amount) || 0;
        if (a < 0) spend += -a;
        any = true;
      }
    }
    if (!any) break;
    const thisDir: "under" | "over" = spend > weeklyAmt ? "over" : "under";
    if (direction === "none") direction = thisDir;
    if (thisDir !== direction) break;
    weeks++;
    weekSun = new Date(weekSun.getTime() - 7 * DAY);
  }
  return weeks > 0 ? { weeks, direction } : { weeks: 0, direction: "none" };
}

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

export type BucketKey = "weekly" | "monthly" | "unplanned";

export type BucketStatus = {
  key: BucketKey;
  label: string;
  spent: number;
  planned: number;
  /** spent - planned; positive = over. */
  variance: number;
  pct: number; // spent / planned
  rangeLabel: string;
  /** Fraction of the period elapsed (0..1). 1 for unplanned (no time pacing). */
  elapsed: number;
  /** Planned * elapsed — what you'd have spent at an even pace. */
  expectedByNow: number;
  /** spent - expectedByNow; positive = spending faster than pace. */
  pace: number;
  /** Days left in the period (0 for unplanned). */
  daysLeft: number;
};

export function computeStatus(
  settings: Settings | undefined,
  txns: Txn[],
  now = new Date(),
): { weekly: BucketStatus; monthly: BucketStatus; unplanned: BucketStatus } {
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
  let unplannedSpent = 0;
  for (const t of txns) {
    const amt = expense(t);
    if (amt === 0) continue;
    if (t.weeklyAllowance && t.occurredOn >= wFrom && t.occurredOn <= wTo) {
      weeklySpent += amt;
    }
    if (t.monthlyAllowance && t.occurredOn >= mFrom && t.occurredOn <= mTo) {
      monthlySpent += amt;
    }
    if (t.unplannedAllowance && t.occurredOn >= mFrom && t.occurredOn <= mTo) {
      unplannedSpent += amt;
    }
  }

  const weeklyPlanned = Number(settings?.weeklyAllowanceAmount) || 0;
  const monthlyPlanned = Number(settings?.monthlyAllowanceAmount) || 0;
  const unplannedPlanned = Number(settings?.unplannedAllowanceAmount) || 0;

  // Elapsed fraction (today counts as a full day toward pace).
  const weekDayIdx = now.getDay(); // 0 Sun .. 6 Sat
  const weekElapsed = (weekDayIdx + 1) / 7;
  const daysInMonth = monthEnd.getDate();
  const monthElapsed = now.getDate() / daysInMonth;

  const fmtRange = (a: Date, b: Date) => {
    const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${a.toLocaleDateString(undefined, o)} – ${b.toLocaleDateString(undefined, o)}`;
  };

  const build = (
    key: BucketKey,
    label: string,
    spent: number,
    planned: number,
    rangeLabel: string,
    elapsed: number,
    daysLeft: number,
  ): BucketStatus => {
    const expectedByNow = planned * elapsed;
    return {
      key,
      label,
      spent,
      planned,
      variance: spent - planned,
      pct: planned > 0 ? spent / planned : 0,
      rangeLabel,
      elapsed,
      expectedByNow,
      pace: spent - expectedByNow,
      daysLeft,
    };
  };

  return {
    weekly: build(
      "weekly",
      "Weekly",
      weeklySpent,
      weeklyPlanned,
      fmtRange(weekStart, weekEnd),
      weekElapsed,
      6 - weekDayIdx,
    ),
    monthly: build(
      "monthly",
      "Monthly",
      monthlySpent,
      monthlyPlanned,
      now.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      monthElapsed,
      daysInMonth - now.getDate(),
    ),
    unplanned: build(
      "unplanned",
      "Unplanned",
      unplannedSpent,
      unplannedPlanned,
      now.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      1,
      0,
    ),
  };
}
