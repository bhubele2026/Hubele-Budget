// Shared temporal/situational context for every AI advisor surface.
//
// Before this, each surface computed its own ad-hoc date facts (some had
// day-of-month, none had days-remaining or pace). This one builder gives every
// prompt the SAME awareness of where the household is in time so the advisor
// reasons correctly — e.g. it won't call day-2 spend "down 85%" against a full
// prior month; it frames partial periods as "so far / on pace".
//
// Pure date math — pass `now` (a Date). No DB, no financial figures (those come
// from each surface's own FACTS, unchanged).

export interface SituationalContext {
  /** ISO date, e.g. "2026-07-02". */
  today: string;
  /** e.g. "July 2026". */
  monthLabel: string;
  monthStart: string; // YYYY-MM-01
  monthEnd: string; // last day of month, YYYY-MM-DD
  dayOfMonth: number; // 1..31
  daysInMonth: number;
  daysElapsed: number; // == dayOfMonth
  daysRemaining: number; // daysInMonth - dayOfMonth
  /** % of the month elapsed, 0..100 (rounded). */
  pacePercent: number;
  /** True in roughly the first quarter of the month — treat MTD as provisional. */
  earlyInMonth: boolean;
  /** Current Sun–Sat week bounds. */
  weekStart: string;
  weekEnd: string;
  /** Prior calendar month bounds (for same-day-of-month comparisons). */
  prevMonthStart: string;
  prevMonthEnd: string;
  /** Same day-of-month in the prior month (clamped to its last day). */
  prevMonthSameDay: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function buildSituationalContext(now: Date): SituationalContext {
  const y = now.getFullYear();
  const m = now.getMonth();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);
  const pacePercent = Math.round((dayOfMonth / daysInMonth) * 100);

  const monthStart = `${y}-${pad(m + 1)}-01`;
  const monthEnd = `${y}-${pad(m + 1)}-${pad(daysInMonth)}`;

  // Sun–Sat week containing `now`.
  const sun = new Date(y, m, dayOfMonth - now.getDay());
  const sat = new Date(sun);
  sat.setDate(sat.getDate() + 6);

  // Prior calendar month.
  const prevMonthDate = new Date(y, m - 1, 1);
  const py = prevMonthDate.getFullYear();
  const pm = prevMonthDate.getMonth();
  const prevDaysInMonth = new Date(py, pm + 1, 0).getDate();
  const prevMonthStart = `${py}-${pad(pm + 1)}-01`;
  const prevMonthEnd = `${py}-${pad(pm + 1)}-${pad(prevDaysInMonth)}`;
  const prevSameDay = Math.min(dayOfMonth, prevDaysInMonth);
  const prevMonthSameDay = `${py}-${pad(pm + 1)}-${pad(prevSameDay)}`;

  return {
    today: iso(now),
    monthLabel: now.toLocaleString("en-US", { month: "long", year: "numeric" }),
    monthStart,
    monthEnd,
    dayOfMonth,
    daysInMonth,
    daysElapsed: dayOfMonth,
    daysRemaining,
    pacePercent,
    earlyInMonth: pacePercent <= 25,
    weekStart: iso(sun),
    weekEnd: iso(sat),
    prevMonthStart,
    prevMonthEnd,
    prevMonthSameDay,
  };
}

/**
 * A compact one-block timing summary to prepend to any advisor prompt so the
 * model always knows the date, how far through the month it is, and to frame
 * partial periods honestly.
 */
export function formatTimingForPrompt(ctx: SituationalContext): string {
  return [
    `TIMING: Today is ${ctx.today} — ${ctx.monthLabel}, day ${ctx.dayOfMonth} of ${ctx.daysInMonth} (${ctx.pacePercent}% through the month, ${ctx.daysRemaining} days left).`,
    ctx.earlyInMonth
      ? `It is EARLY in the month — treat month-to-date figures as provisional ("so far / on pace"), and compare only against the same point in prior months, never against a full month.`
      : `Compare month-to-date against the same day-of-month in prior months, not against a full month.`,
  ].join(" ");
}
