// (#809 / #821 / #822) Pure construction of the Amex page's
// balance-history window (the 12 months ending this month, up to today). Extracted from the
// `balanceWindow` useMemo in `src/pages/amex.tsx` so the weekly
// bucketing — and specifically the rule that the rightmost data point
// and the "Today" reference line both land on today — can be unit
// tested without mounting the page.
//
// (W4) The window is the 12 months ending this month and rolls forward.
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
// Import from the concrete modules, NOT the account-page barrel: the barrel
// re-exports BalanceTrendChart, which statically imports recharts — through
// a barrel import here the whole 451 KB charts bundle lands in the entry
// graph (caught by scripts/check-entry-graph.mjs). The chart TYPES are safe
// as `import type` (fully erased at build).
import {
  compareMonth,
  monthKeyFromISO,
  shiftMonth,
  type MonthKey,
} from "@/components/account-page/month-navigator";
import type {
  WindowConfig,
  WindowPoint,
} from "@/components/account-page/balance-trend-chart";

// The product's data horizon (kept for callers; the window no longer floors on it).
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

  // (W4) The 12 months ENDING THIS MONTH: it rolls forward with the clock (the
  // old window was pinned to May 2026 and ran out in April 2027, leaving the
  // chart with no "today"). It ends at today — no empty future area. Months
  // before the data horizon have no balance and simply have no points.
  const windowStart = startOfMonth(
    new Date(currentMonth.year, currentMonth.month - 11, 1),
  );
  const windowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());

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
    // Omit weeks ending after today.
    if (satDay > todayDay) break;
    const satMk: MonthKey = {
      year: sat.getFullYear(),
      month: sat.getMonth(),
    };
    // End-of-week balance = end of the prior month (from the shared
    // anchored month-end helper) + this month's card-scoped
    // transactions through the Saturday.
    const prevMonthEnd = balanceAtEndOf(shiftMonth(satMk, -1));
    if (prevMonthEnd === null) {
      sat = addDays(sat, 7);
      continue;
    }
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
