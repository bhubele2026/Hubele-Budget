import type { Transaction } from "@workspace/api-client-react";

export type WeeklyStreak = {
  weeks: number;
  direction: "under" | "over" | "none";
};

function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sundayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}

/** ISO date `n` days before `now` — for bounding the transactions query. */
export function isoDaysAgo(now: Date, n: number): string {
  return fmtISO(addDays(now, -n));
}
export function todayISO(now: Date): string {
  return fmtISO(now);
}

/**
 * Trailing run of COMPLETED weeks that all landed the same side of the weekly
 * allowance — `under` (good) or `over` (the roast). Walks back from last week
 * and stops at the first week that flips direction or has no spend data.
 * Mirrors the allowances over-budget streak but reports either direction.
 */
export function weeklyBudgetStreak(
  txns: Transaction[],
  weeklyAmt: number,
  overrides: Record<string, string> | undefined,
  now: Date,
): WeeklyStreak {
  if (weeklyAmt <= 0) return { weeks: 0, direction: "none" };
  const ov = overrides ?? {};
  let weekSun = addDays(sundayOf(now), -7); // last fully-completed week
  let direction: "under" | "over" | "none" = "none";
  let weeks = 0;
  for (let i = 0; i < 26; i++) {
    const start = fmtISO(weekSun);
    const end = fmtISO(addDays(weekSun, 6));
    let spend = 0;
    let any = false;
    for (const t of txns) {
      if (!t.weeklyAllowance) continue;
      if (t.occurredOn >= start && t.occurredOn <= end) {
        const a = Number(t.amount) || 0;
        if (a < 0) spend += -a;
        any = true;
      }
    }
    if (!any) break;
    const planned = ov[start] != null ? Number(ov[start]) : weeklyAmt;
    if (!(planned > 0)) break;
    const thisDir: "under" | "over" = spend > planned ? "over" : "under";
    if (direction === "none") direction = thisDir;
    if (thisDir !== direction) break;
    weeks++;
    weekSun = addDays(weekSun, -7);
  }
  return weeks > 0 ? { weeks, direction } : { weeks: 0, direction: "none" };
}
