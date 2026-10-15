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
import { cardOwedMoves, type CardMoveInput } from "./cardBalanceWalk";

// The product's data horizon (kept for callers; the window no longer floors on it).
export const MAY_2026: MonthKey = { year: 2026, month: 4 };

/** (Q3) A card row: `source` says its sign, `pending` keeps it out (`cardBalanceWalk.ts`). */
export type BalanceWindowTxn = CardMoveInput;

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

  // ⭐ (Q3) Each row as its change to what the card OWES (posted rows only,
  // every source on the owed sign) — the same rows and signs as the month-end
  // closure (`balanceAtEndOf`) and the per-row "bal", so a week's point and a
  // row's figure can never disagree. Cents, so a point is exact.
  const moves = cardOwedMoves(transactions).map((m) => ({
    day: m.occurredOn.slice(0, 10),
    month: monthKeyFromISO(m.occurredOn),
    cents: Math.round(m.owed * 100),
  }));
  const intraMonthThrough = (mk: MonthKey, day: string): number => {
    let c = 0;
    for (const t of moves) {
      if (compareMonth(t.month, mk) === 0 && t.day <= day) c += t.cents;
    }
    return c;
  };
  const pointAt = (prevMonthEnd: number, intraCents: number): number =>
    (Math.round(prevMonthEnd * 100) + intraCents) / 100 + 0;

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

  // (W6) No flat line where there is no data. `balanceAtEndOf` carries the
  // anchored balance backwards, so months before the card has history would
  // plot a flat line at that balance. The series starts at the first real
  // week: no earlier than the tracking start (May 1, 2026), and for a card
  // whose first transaction is later, the Saturday just before it (its
  // opening balance). Earlier months stay empty; nothing is invented.
  let firstDay = "2026-05-01";
  let firstTxn: string | null = null;
  for (const t of moves) {
    const d = t.day;
    if (firstTxn === null || d < firstTxn) firstTxn = d;
  }
  if (firstTxn !== null) {
    const [fy, fm, fd] = firstTxn.split("-").map(Number);
    const first = new Date(fy!, fm! - 1, fd!);
    const opening = dayStr(addDays(first, -(first.getDay() + 1)));
    if (opening > firstDay) firstDay = opening;
  }
  const noHistoryBefore =
    firstDay > dayStr(windowStart)
      ? new Date(+firstDay.slice(0, 4), +firstDay.slice(5, 7) - 1, 1).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        })
      : null;

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
    if (satDay < firstDay) {
      sat = addDays(sat, 7);
      continue;
    }
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
    series.push({
      x: sat.getTime(),
      balance: pointAt(prevMonthEnd, intraMonthThrough(satMk, satDay)),
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
    todayDay >= firstDay &&
    (series.length === 0 || series[series.length - 1].x !== todayMidMs)
  ) {
    const todayMk: MonthKey = {
      year: now.getFullYear(),
      month: now.getMonth(),
    };
    const prevMonthEnd = balanceAtEndOf(shiftMonth(todayMk, -1));
    if (prevMonthEnd !== null) {
      series.push({
        x: todayMidMs,
        balance: pointAt(prevMonthEnd, intraMonthThrough(todayMk, todayDay)),
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
    noHistoryBefore,
  };
}
