// (#809 / #821 / #822) Pure construction of the Amex page's
// forward-looking ending-balance window. Extracted from the
// `balanceWindow` useMemo in `src/pages/amex.tsx` so the weekly
// bucketing — and specifically the rule that the rightmost data point
// and the "Today" reference line both land on today — can be unit
// tested without mounting the page.
//
// The window is a fixed 12-month span that rolls forward by month.
// Credit-card spending isn't forecastable, so we plot only real history
// as it accumulates: one point per Sun–Sat week (anchored on the
// Saturday that closes it) from the window start through today. Weeks
// ending after today are omitted so the right portion of the chart
// stays genuinely blank. (#821) Because the in-progress current week's
// closing Saturday is in the future, the loop would otherwise strand
// the rightmost real point on the prior week's Saturday — so a partial
// bucket anchored on TODAY (local midnight) is appended, unless today
// is itself a Saturday (already pushed by the loop).
import { startOfMonth, addMonths, addDays, endOfWeek } from "date-fns";
import {
  compareMonth,
  monthKeyFromISO,
  shiftMonth,
  type MonthKey,
  type WindowConfig,
  type WindowPoint,
} from "@/components/account-page";

// Earliest month the forward-looking balance window may start on. The
// window is `max(MAY_2026, start of current month)` so it never reaches
// back before the product's data horizon, yet rolls forward by a month
// every time "today" crosses into a new month.
export const MAY_2026: MonthKey = { year: 2026, month: 4 };

export type BalanceWindowTxn = {
  occurredOn: string;
  amount: string | number;
};

export type BuildBalanceWindowArgs = {
  /** Whether a usable anchor exists; null window when false. */
  anchorPresent: boolean;
  /** Today's month (= `monthKeyOf(new Date())` on the page). */
  currentMonth: MonthKey;
  /** End-of-month balance closure shared with the header tile. */
  balanceAtEndOf: (target: MonthKey) => number | null;
  /** Card-scoped Amex transactions feeding the intra-month sums. */
  transactions: ReadonlyArray<BalanceWindowTxn>;
  /** Injectable "now" for deterministic tests; defaults to new Date(). */
  now?: Date;
};

/**
 * Build the forward-looking `WindowConfig` (or `null` when there is no
 * anchor). Mirrors the page's `balanceWindow` useMemo exactly.
 */
export function buildBalanceWindow(
  args: BuildBalanceWindowArgs,
): WindowConfig | null {
  const {
    anchorPresent,
    currentMonth,
    balanceAtEndOf,
    transactions,
    now = new Date(),
  } = args;

  if (!anchorPresent) return null;

  // Window start = max(May 2026, start of current month). Derived from
  // `currentMonth` (= today's month) so it advances automatically on
  // the first of each new month.
  const startMk =
    compareMonth(currentMonth, MAY_2026) < 0 ? MAY_2026 : currentMonth;
  const windowStart = startOfMonth(new Date(startMk.year, startMk.month, 1));
  // 12-month span: window start through (start + 12 months − 1 day).
  const windowEnd = addDays(addMonths(windowStart, 12), -1);

  const monthTicks: number[] = [];
  for (let i = 0; i < 12; i++) {
    monthTicks.push(addMonths(windowStart, i).getTime());
  }

  const fmtMonthYear = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const subtitle = `${fmtMonthYear(windowStart)} – ${fmtMonthYear(
    addMonths(windowStart, 11),
  )}`;

  const pad = (n: number) => String(n).padStart(2, "0");
  const dayStr = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayDay = dayStr(now);

  const series: WindowPoint[] = [];
  // First bucket: the Saturday that closes the week containing the
  // window start. Normalize to local midnight so its X position lines
  // up cleanly with the month-boundary ticks/domain.
  let sat = endOfWeek(windowStart, { weekStartsOn: 0 });
  sat = new Date(sat.getFullYear(), sat.getMonth(), sat.getDate());

  while (sat.getTime() <= windowEnd.getTime()) {
    const satDay = dayStr(sat);
    // Omit weeks ending after today — keep the right side blank.
    if (satDay > todayDay) break;
    const satMk: MonthKey = {
      year: sat.getFullYear(),
      month: sat.getMonth(),
    };
    // End-of-week balance = end of the prior month (from the shared
    // anchored month-end helper) + this month's card-scoped
    // transactions through the Saturday.
    const prevMonthEnd = balanceAtEndOf(shiftMonth(satMk, -1));
    if (prevMonthEnd === null) break;
    let intraMonth = 0;
    for (const t of transactions) {
      if (
        compareMonth(monthKeyFromISO(t.occurredOn), satMk) === 0 &&
        t.occurredOn.slice(0, 10) <= satDay
      ) {
        intraMonth += Number(t.amount) || 0;
      }
    }
    series.push({
      x: sat.getTime(),
      balance: prevMonthEnd + intraMonth,
      label: sat.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    });
    sat = addDays(sat, 7);
  }

  // (#821) The loop above stops before the in-progress current week —
  // its closing Saturday is in the future — which would leave the
  // rightmost real point stranded on the prior week's Saturday. Append
  // a partial bucket anchored on TODAY (local midnight, matching how the
  // Saturday points are anchored) so the most-recent point lines up with
  // the "Today" reference line. Its balance is the latest known balance
  // as of today: end of the prior month + this month's card-scoped
  // transactions through today — the same computation the weekly loop
  // uses, just closed on today instead of a Saturday. Skip when today is
  // itself a Saturday (already pushed by the loop).
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayMidMs = todayMid.getTime();
  if (
    todayMidMs >= windowStart.getTime() &&
    todayMidMs <= windowEnd.getTime() &&
    (series.length === 0 || series[series.length - 1].x !== todayMidMs)
  ) {
    const todayMk: MonthKey = {
      year: now.getFullYear(),
      month: now.getMonth(),
    };
    const prevMonthEnd = balanceAtEndOf(shiftMonth(todayMk, -1));
    if (prevMonthEnd !== null) {
      let intraMonth = 0;
      for (const t of transactions) {
        if (
          compareMonth(monthKeyFromISO(t.occurredOn), todayMk) === 0 &&
          t.occurredOn.slice(0, 10) <= todayDay
        ) {
          intraMonth += Number(t.amount) || 0;
        }
      }
      series.push({
        x: todayMidMs,
        balance: prevMonthEnd + intraMonth,
        label: todayMid.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      });
    }
  }

  return {
    series,
    domain: [windowStart.getTime(), windowEnd.getTime()],
    monthTicks,
    // Anchor the "Today" reference line on local midnight so it lines up
    // exactly with the rightmost (today) data point, which is also
    // anchored on local midnight.
    todayMs: todayMidMs,
    subtitle,
  };
}
