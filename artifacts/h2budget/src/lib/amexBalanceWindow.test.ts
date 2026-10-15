import { describe, it, expect } from "vitest";
import { buildBalanceWindow, type BalanceWindowTxn } from "./amexBalanceWindow";
import { makeAmexBalanceAtEndOf } from "./amexEndingBalance";
import { type MonthKey, monthKeyOf } from "@/components/account-page";

// (#822) Guard for the #821 fix: the forward-looking Amex balance
// window must always place its rightmost data point on TODAY (not the
// previous closed week's Saturday), and the "Today" reference line
// (`window.todayMs`) must sit at today's local-midnight timestamp so
// the line aligns with that rightmost point.
//
// `buildBalanceWindow` takes an injectable `now`, so these tests pin a
// fixed date instead of depending on the real clock. The
// `balanceAtEndOf` closure is stubbed to a constant — the exact balance
// math is covered by amexEndingBalance.test.ts; here we only care about
// the date-bucketing geometry.

const localMidnightMs = (y: number, m: number, d: number) =>
  new Date(y, m, d).getTime();

// Format a timestamp as a local `YYYY-MM-DD` key. The window's point
// `x` values are local-midnight timestamps, so we must read them back
// with local getters — using `toISOString()` would shift the date in
// non-UTC test environments.
const localDayKey = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const constBalanceAtEndOf = (value: number) => (_target: MonthKey) => value;

describe("(#822) buildBalanceWindow rightmost point lands on today", () => {
  // A mid-month weekday (Wed May 27, 2026). Not a Saturday.
  const now = new Date(2026, 4, 27, 14, 30, 0);
  const currentMonth: MonthKey = monthKeyOf(now);
  const noTxns: BalanceWindowTxn[] = [];

  it("anchors the rightmost point on today when today is NOT a Saturday", () => {
    const window = buildBalanceWindow({
      anchorPresent: true,
      currentMonth,
      balanceAtEndOf: constBalanceAtEndOf(1000),
      transactions: noTxns,
      now,
    });
    expect(window).not.toBeNull();
    const last = window!.series[window!.series.length - 1];
    // Rightmost point sits exactly on today's local midnight.
    expect(last.x).toBe(localMidnightMs(2026, 4, 27));
  });

  it("aligns window.todayMs with today's local-midnight timestamp", () => {
    const window = buildBalanceWindow({
      anchorPresent: true,
      currentMonth,
      balanceAtEndOf: constBalanceAtEndOf(1000),
      transactions: noTxns,
      now,
    });
    expect(window!.todayMs).toBe(localMidnightMs(2026, 4, 27));
    // And it coincides with the rightmost data point so the reference
    // line lines up with the last dot.
    const last = window!.series[window!.series.length - 1];
    expect(window!.todayMs).toBe(last.x);
  });

  it("does NOT append a duplicate today point when today IS a Saturday", () => {
    // Sat May 30, 2026 — the week's closing Saturday is today itself,
    // so the weekly loop already pushed it; no extra bucket should be
    // appended.
    const saturday = new Date(2026, 4, 30, 9, 0, 0);
    const window = buildBalanceWindow({
      anchorPresent: true,
      currentMonth: monthKeyOf(saturday),
      balanceAtEndOf: constBalanceAtEndOf(1000),
      transactions: noTxns,
      now: saturday,
    });
    expect(window).not.toBeNull();
    const satMs = localMidnightMs(2026, 4, 30);
    // The last point is today's Saturday...
    const last = window!.series[window!.series.length - 1];
    expect(last.x).toBe(satMs);
    // ...and it appears exactly once (no duplicate appended bucket).
    const occurrences = window!.series.filter((p) => p.x === satMs).length;
    expect(occurrences).toBe(1);
    // todayMs still aligns with that final Saturday point.
    expect(window!.todayMs).toBe(satMs);
  });

  it("keeps past weeks anchored on their week-ending Saturday", () => {
    const window = buildBalanceWindow({
      anchorPresent: true,
      currentMonth,
      balanceAtEndOf: constBalanceAtEndOf(1000),
      transactions: noTxns,
      now,
    });
    // The window starts May 2026 (the data horizon). The earlier
    // points (everything but the appended "today" bucket) must each
    // fall on a Saturday (getDay() === 6).
    const series = window!.series;
    expect(series.length).toBeGreaterThan(1);
    const pastPoints = series.slice(0, -1);
    for (const p of pastPoints) {
      expect(new Date(p.x).getDay()).toBe(6);
    }
    // The very last (today) point is the only non-Saturday point.
    expect(new Date(series[series.length - 1].x).getDay()).not.toBe(6);
  });

  it("returns null when no anchor is present", () => {
    const window = buildBalanceWindow({
      anchorPresent: false,
      currentMonth,
      balanceAtEndOf: constBalanceAtEndOf(1000),
      transactions: noTxns,
      now,
    });
    expect(window).toBeNull();
  });
});

// (#825) Cover the actual per-week DOLLAR values of the forward-looking
// Amex balance window. #822 above locked the date geometry but stubbed
// `balanceAtEndOf` to a constant and passed no transactions, so the
// intra-month accumulation (`prevMonthEnd + sum(this month's card-scoped
// txns through the bucket date)`) was never exercised. Here we feed a
// REAL `balanceAtEndOf` closure (via `makeAmexBalanceAtEndOf`) plus a
// small set of card-scoped transactions and assert each weekly point's
// balance equals end-of-prior-month plus that month's transactions dated
// on/before the bucket date.
describe("(#825) buildBalanceWindow weekly dollar values", () => {
  // Mid-month weekday: Wed May 27, 2026. With a May-2026 window start,
  // the weekly Saturday buckets land on May 2, 9, 16, 23 and the
  // appended partial bucket lands on today (May 27).
  const now = new Date(2026, 4, 27, 14, 30, 0);
  const currentMonth: MonthKey = monthKeyOf(now);

  // Anchor the end-of-April balance at exactly 1000 with no April
  // transactions, so `balanceAtEndOf(April)` is a clean 1000 and every
  // May bucket's `prevMonthEnd` term is 1000. The May transactions below
  // then drive the intra-month accumulation we want to verify.
  const anchor = { balance: 1000, asOf: "2026-04-30" };

  // Card-scoped May transactions. Spread across weeks so each bucket
  // captures a different cumulative sum, with one txn (May 28) dated
  // AFTER both the last Saturday bucket and today to prove later txns
  // are excluded from earlier buckets.
  const transactions: BalanceWindowTxn[] = [
    { occurredOn: "2026-05-05", amount: 100, source: "amex" }, // after May 2 bucket
    { occurredOn: "2026-05-12", amount: 200, source: "amex" },
    { occurredOn: "2026-05-20", amount: 50, source: "amex" },
    { occurredOn: "2026-05-28", amount: 500, source: "amex" }, // after today (May 27)
  ];

  const balanceAtEndOf = makeAmexBalanceAtEndOf({
    anchor,
    amexTransactions: transactions,
    fallbackMonth: currentMonth,
  });

  const buildWindow = () =>
    buildBalanceWindow({
      anchorPresent: true,
      currentMonth,
      balanceAtEndOf,
      transactions,
      now,
    });

  it("each weekly point equals prior-month-end + that month's txns through the bucket date", () => {
    const window = buildWindow();
    expect(window).not.toBeNull();
    const byDay = new Map(
      window!.series.map((p) => [
        localDayKey(p.x),
        p.balance,
      ]),
    );
    // May 2: prior-month-end (1000) + no May txns yet.
    expect(byDay.get("2026-05-02")).toBe(1000);
    // May 9: + May 5 txn (100).
    expect(byDay.get("2026-05-09")).toBe(1100);
    // May 16: + May 5, 12 (100 + 200).
    expect(byDay.get("2026-05-16")).toBe(1300);
    // May 23: + May 5, 12, 20 (100 + 200 + 50).
    expect(byDay.get("2026-05-23")).toBe(1350);
  });

  it("appends a today bucket that sums txns through today, not the prior Saturday", () => {
    const window = buildWindow();
    const last = window!.series[window!.series.length - 1];
    // Rightmost point is today (May 27), not the May 23 Saturday.
    expect(localDayKey(last.x)).toBe("2026-05-27");
    // Through today the cumulative May sum is still 100 + 200 + 50 = 350
    // on top of the 1000 prior-month-end (the May 28 txn is excluded).
    expect(last.balance).toBe(1350);
  });

  it("excludes transactions dated after a bucket from that bucket's balance", () => {
    const window = buildWindow();
    const byDay = new Map(
      window!.series.map((p) => [
        localDayKey(p.x),
        p.balance,
      ]),
    );
    // The May 5 txn (+100) is dated AFTER the May 2 bucket, so May 2
    // must NOT include it (stays at the 1000 prior-month-end).
    expect(byDay.get("2026-05-02")).toBe(1000);
    // The May 28 txn (+500) is dated after every bucket (incl. today),
    // so it never appears: no point reaches 1000 + 350 + 500 = 1850.
    for (const p of window!.series) {
      expect(p.balance).not.toBe(1850);
    }
    // And today (the latest bucket) tops out at 1350, confirming the
    // May 28 txn was excluded there too.
    const last = window!.series[window!.series.length - 1];
    expect(last.balance).toBe(1350);
  });
});

// (W4) The window is the 12 months ENDING THIS MONTH, up to today: it rolls
// forward (the old one ran out in April 2027) and has no empty future.
describe("(W4) buildBalanceWindow is the last 12 months, ending today", () => {
  const build = (now: Date) =>
    buildBalanceWindow({
      anchorPresent: true,
      currentMonth: monthKeyOf(now),
      balanceAtEndOf: constBalanceAtEndOf(1000),
      transactions: [],
      now,
    })!;

  it("spans the 12 months ending this month", () => {
    const w = build(new Date(2026, 9, 14, 12));
    expect(w.subtitle).toBe("Nov 2025 – Oct 2026");
    expect(w.monthTicks).toHaveLength(12);
    expect(w.domain[0]).toBe(localMidnightMs(2025, 10, 1));
  });

  it("ends at today: no future area, no future points", () => {
    const now = new Date(2026, 9, 14, 12);
    const w = build(now);
    expect(w.domain[1]).toBe(localMidnightMs(2026, 9, 14));
    expect(w.todayMs).toBe(w.domain[1]);
    for (const p of w.series) expect(p.x).toBeLessThanOrEqual(w.domain[1]);
    expect(w.series[w.series.length - 1]!.x).toBe(w.todayMs);
  });

  it("rolls forward: a date after April 2027 still includes today", () => {
    const now = new Date(2027, 5, 9, 12);
    const w = build(now);
    expect(w.subtitle).toBe("Jul 2026 – Jun 2027");
    expect(w.domain[0]).toBeLessThanOrEqual(w.todayMs);
    expect(w.domain[1]).toBe(localMidnightMs(2027, 5, 9));
    expect(w.series[w.series.length - 1]!.x).toBe(localMidnightMs(2027, 5, 9));
    const w2 = build(new Date(2028, 0, 3, 12));
    expect(w2.subtitle).toBe("Feb 2027 – Jan 2028");
    expect(w2.series.length).toBeGreaterThan(40);
  });

  it("months with no balance have no points; later months still do", () => {
    const now = new Date(2026, 9, 14, 12);
    const w = buildBalanceWindow({
      anchorPresent: true,
      currentMonth: monthKeyOf(now),
      balanceAtEndOf: (m) => (m.year === 2026 && m.month >= 4 ? 500 : null),
      transactions: [],
      now,
    })!;
    expect(w.series.length).toBeGreaterThan(15);
    expect(w.series[0]!.x).toBeGreaterThanOrEqual(localMidnightMs(2026, 4, 1));
  });
});

// (W6) No flat line where there is no data.
describe("(W6) the series starts at the first real week", () => {
  const now = new Date(2026, 9, 14, 12);
  const build = (transactions: BalanceWindowTxn[]) =>
    buildBalanceWindow({
      anchorPresent: true,
      currentMonth: monthKeyOf(now),
      balanceAtEndOf: constBalanceAtEndOf(1000),
      transactions,
      now,
    })!;

  it("keeps the 12-month axis but plots nothing before the tracking start", () => {
    const w = build([{ occurredOn: "2026-05-05", amount: 10, source: "amex" }]);
    expect(w.subtitle).toBe("Nov 2025 – Oct 2026");
    expect(w.domain[0]).toBe(localMidnightMs(2025, 10, 1));
    expect(w.series[0]!.x).toBe(localMidnightMs(2026, 4, 2)); // the Saturday before the first transaction
    expect(w.series.every((p) => p.x >= localMidnightMs(2026, 4, 1))).toBe(true);
    expect(w.noHistoryBefore).toBe("May 2026");
  });
  it("a card whose first transaction is later starts later", () => {
    const w = build([{ occurredOn: "2026-08-12", amount: 10, source: "amex" }]); // a Wednesday
    expect(w.series[0]!.x).toBe(localMidnightMs(2026, 7, 8));
    expect(w.noHistoryBefore).toBe("August 2026");
  });
});

// ⭐ (Q3) Plaid card rows (bank sign: a purchase negative) plot the same line as
// the workbook rows above: each point is the prior month's end plus that
// month's OWED changes through the point, posted rows only.
describe("(Q3) buildBalanceWindow with Plaid card rows", () => {
  const now = new Date(2026, 4, 27, 14, 30, 0);
  const currentMonth: MonthKey = monthKeyOf(now);
  const anchor = { balance: 1000, asOf: "2026-04-30" };
  const transactions: BalanceWindowTxn[] = [
    { occurredOn: "2026-05-05", amount: -100, source: "plaid:amex" }, // purchase +100
    { occurredOn: "2026-05-12", amount: -200, source: "plaid:amex" }, // purchase +200
    { occurredOn: "2026-05-20", amount: 150, source: "plaid:amex" }, //  payment  −150
    { occurredOn: "2026-05-26", amount: -40, source: "plaid:amex", pending: true }, // pending: not walked
  ];
  const balanceAtEndOf = makeAmexBalanceAtEndOf({ anchor, amexTransactions: transactions, fallbackMonth: currentMonth });
  const w = buildBalanceWindow({ anchorPresent: true, currentMonth, balanceAtEndOf, transactions, now })!;
  const byDay = new Map(w.series.map((p) => [localDayKey(p.x), p.balance]));

  it("purchases raise the line and a payment lowers it", () => {
    expect(byDay.get("2026-05-02")).toBe(1000);
    expect(byDay.get("2026-05-09")).toBe(1100);
    expect(byDay.get("2026-05-16")).toBe(1300);
    expect(byDay.get("2026-05-23")).toBe(1150);
  });

  it("today's point leaves the pending row out and equals the month-end helper", () => {
    const last = w.series[w.series.length - 1]!;
    expect(localDayKey(last.x)).toBe("2026-05-27");
    expect(last.balance).toBe(1150);
    expect(balanceAtEndOf(currentMonth)).toBe(1150);
  });
});

// ⭐ (F6 round 5, review finding 1 — merged onto Q3's walk) The chart's
// intra-month sums read only the rows that count, as the ending-balance tile
// does: its today point equals the tile again, and an expired hold lifts no
// weekly point. Synthetic Plaid rows (bank sign): the card read 10/03 at
// 1,000.00; 10/01 A 10 posted; 10/05 H 52 an expired hold; 10/06 B 20 posted;
// today Thu 10/15. Round 4: the tile 1,020, the chart's Oct 10 and today points 1,072.
describe("(F6 round 5) the 12-month chart leaves out an expired hold, as the tile does", () => {
  const now = new Date(2026, 9, 15, 12, 0, 0);
  const anchor = { balance: 1000, asOf: "2026-10-03T15:00:00Z" };
  const rows: BalanceWindowTxn[] = [
    { occurredOn: "2026-10-01", amount: "-10.00", source: "plaid:amex" },
    { occurredOn: "2026-10-05", amount: "-52.00", source: "plaid:amex", pending: true, expiredHold: true },
    { occurredOn: "2026-10-06", amount: "-20.00", source: "plaid:amex" },
  ];
  const windowOf = (txns: BalanceWindowTxn[]) => {
    const balanceAtEndOf = makeAmexBalanceAtEndOf({ anchor, amexTransactions: txns });
    return { balanceAtEndOf, w: buildBalanceWindow({ anchorPresent: true, currentMonth: monthKeyOf(now), balanceAtEndOf, transactions: txns, now })! };
  };
  const pointOn = (w: ReturnType<typeof buildBalanceWindow>, day: string) => w!.series.find((p) => localDayKey(p.x) === day)?.balance;

  it("today's point equals the ending-balance tile: 1,020.00 (round 4: 1,072.00)", () => {
    const { balanceAtEndOf, w } = windowOf(rows);
    expect(pointOn(w, "2026-10-15")).toBe(1020);
    expect(pointOn(w, "2026-10-15")).toBe(balanceAtEndOf(monthKeyOf(now)));
    // The weekly points: Sat 10/03 = 990 + 10; Sat 10/10 = + 20 (the hold adds nothing).
    expect(pointOn(w, "2026-10-03")).toBe(1000);
    expect(pointOn(w, "2026-10-10")).toBe(1020);
  });

  it("the server's flag alone (no pending flag on the row) keeps it out; the same 52 posted and counted reads 1,072.00", () => {
    const flagOnly = windowOf(rows.map(({ pending: _p, ...r }) => r));
    expect(pointOn(flagOnly.w, "2026-10-15")).toBe(1020);
    const { balanceAtEndOf, w } = windowOf(rows.map(({ pending: _p, expiredHold: _e, ...r }) => r));
    expect(pointOn(w, "2026-10-15")).toBe(1072);
    expect(balanceAtEndOf(monthKeyOf(now))).toBe(1072);
  });
});
