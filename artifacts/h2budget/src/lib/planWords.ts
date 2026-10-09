import { parseDollars } from "@/lib/afford";

/**
 * Words and small exact helpers for the weekly plan and the debt-plan range
 * panels (F11). Ported from the frozen h2 app (`screens/plan/format.ts`,
 * `PlanWeek.tsx` `planFor`) with their tests. Nothing here works out a money
 * figure: the server's strings are shown as they come.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2028-03" → "Mar 2028". */
export function monthWords(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}` : ym;
}

/** A dollar amount above zero, canonical, or null. */
export function parsePositiveDollars(raw: string): string | null {
  const v = parseDollars(raw);
  return v != null && Number(v) > 0 ? v : null;
}

/** "600.00" → "600" for an input's starting value; "12.50" stays. */
export function plainDollars(amount: string | number | null | undefined): string {
  if (amount == null || amount === "") return "";
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** The words for a plan write's error: the owner-only 403 gets its own sentence. */
export function planErrorWords(e: unknown, fallback = "Couldn't save. Try again."): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return "Only the household owner can change this.";
  if (status === 409) return "That conflicts with another entry. Check the date.";
  return fallback;
}

export interface PlanLike {
  id: string;
  memberUserId: string | null;
  period: "weekly" | "monthly" | string;
  amount: string;
  effectiveFrom: string;
  source: string;
}

/** The plan in force for a member (null = the shared pool) and period: the latest start. */
export function planFor<P extends PlanLike>(plans: readonly P[] | undefined, memberUserId: string | null, period: "weekly" | "monthly"): P | null {
  return (
    plans
      ?.filter((p) => p.memberUserId === memberUserId && p.period === period)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null
  );
}

/** The latest plan per member and period (members only, not the shared pool). */
export function latestMemberPlans<P extends PlanLike>(plans: readonly P[]): P[] {
  return plans
    .filter((p) => p.memberUserId !== null)
    .filter((p) => planFor(plans, p.memberUserId, p.period as "weekly" | "monthly") === p);
}

/** Cents-exact match between the owner's limit and the server's suggestion. */
export function matchesSuggestion(suggested: number | null, current: number | null): boolean {
  return suggested != null && current != null && Math.round(suggested * 100) === Math.round(current * 100);
}
