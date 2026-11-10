// ⭐ (AVAL-W) "WE PAID IT" — what the home page's avalanche box and the Debt
// page's weekly panel show for THIS week, worked out once for both.
//
// Owner, 2026-11-10: "on the home page I want a box that says which avalanche we
// are paying, when and a button to say we did".
//
// PRESENTATION ONLY. Every figure is the server's (`GET /avalanche/weekly`: the
// plan the forecast puts on the curve, and `lastPaid`, the latest press); this
// file picks the state and the words, it never adds, rounds or re-derives a
// payment. Type-only imports: nothing here reaches the landing chunk.

import type { AvalancheWeeklyLastPaid, AvalancheWeeklyPlan, AvalancheWeeklyWeek } from "@workspace/api-client-react";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function dayName(weekday: number): string {
  return DAY_NAMES[weekday] ?? "Friday";
}

/** Where a week's money goes, as words: the debts it pays, else the debt next in line. */
export function weekCardLabel(w: Pick<AvalancheWeeklyWeek, "targets" | "nextTarget">): string {
  if (w.targets.length > 0) return w.targets.map((t) => t.name).join(" + ");
  return w.nextTarget?.name ?? "—";
}

/** "Today", else "Friday, Nov 13" — a household day, with no timezone in the way. */
export function payDayLabel(iso: string, todayISO: string): string {
  if (iso === todayISO) return "Today";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dayName(d.getUTCDay())}, ${SHORT.format(d)}`;
}

/**
 * This week, as one of:
 *   - `hidden`: monthly (or no plan) — the box draws nothing;
 *   - `none`: weekly, and no debt is left for the avalanche to pay;
 *   - `toPay`: this week pays something and is not answered — "We paid it";
 *   - `paid`: this week was marked paid here (`lastPaid` is this week) — "Undo";
 *   - `answered`: answered elsewhere (the Forecast);
 *   - `nothingSafe`: nothing is safe to pay this week.
 * `next` is the next week that pays something. `earlier` is a previous week's
 * press that can still be undone, offered quietly beside this week's state.
 */
export type WeekPayView =
  | { kind: "hidden" }
  | { kind: "none" }
  | { kind: "toPay"; week: AvalancheWeeklyWeek; next: AvalancheWeeklyWeek | null; earlier: AvalancheWeeklyLastPaid | null }
  | { kind: "paid"; week: AvalancheWeeklyWeek; paid: AvalancheWeeklyLastPaid; next: AvalancheWeeklyWeek | null }
  | { kind: "answered"; week: AvalancheWeeklyWeek; next: AvalancheWeeklyWeek | null; earlier: AvalancheWeeklyLastPaid | null }
  | { kind: "nothingSafe"; week: AvalancheWeeklyWeek; next: AvalancheWeeklyWeek | null; earlier: AvalancheWeeklyLastPaid | null };

export function weekPayView(plan: AvalancheWeeklyPlan | null | undefined): WeekPayView {
  if (!plan || plan.cadence !== "weekly") return { kind: "hidden" };
  const week = plan.weeks[0];
  if (!week) return { kind: "none" };
  const next = plan.weeks.slice(1).find((w) => w.paid > 0) ?? null;
  const last = plan.lastPaid ?? null;
  if (last && last.date === week.date) return { kind: "paid", week, paid: last, next };
  const earlier = last && last.undoable && last.date < week.date ? last : null;
  if (week.answered) return { kind: "answered", week, next, earlier };
  if (week.paid > 0 && week.targets.length > 0) return { kind: "toPay", week, next, earlier };
  return { kind: "nothingSafe", week, next, earlier };
}

/** The debts a press paid, as words ("Card A + Card B"). */
export function paidCardLabel(p: Pick<AvalancheWeeklyLastPaid, "targets">): string {
  return p.targets.map((t) => t.name).join(" + ") || "—";
}

/**
 * A press that paid a debt whose balance comes from the bank (no balance was
 * written for it): when that balance moves. Null when it paid none.
 */
export function linkedNote(p: Pick<AvalancheWeeklyLastPaid, "targets">): string | null {
  const linked = p.targets.filter((t) => t.linked);
  if (linked.length === 0) return null;
  if (p.targets.length === 1) return "Its balance updates when the bank shows the payment.";
  const names = linked.map((t) => t.name).join(" and ");
  return linked.length === 1
    ? `${names}: its balance updates when the bank shows the payment.`
    : `${names}: their balances update when the bank shows the payment.`;
}

/** The refusal's own plain words when the server sent them, else a plain line. */
export function weekPayErrorWords(e: unknown): string {
  const data = (e as { data?: unknown } | null)?.data;
  const words = data && typeof data === "object" ? (data as { error?: unknown }).error : null;
  return typeof words === "string" && words.trim() ? words : "That did not go through. Try again.";
}
