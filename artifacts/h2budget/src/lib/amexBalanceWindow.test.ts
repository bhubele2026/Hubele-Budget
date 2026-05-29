import { describe, it, expect } from "vitest";
import { buildBalanceWindow, type BalanceWindowTxn } from "./amexBalanceWindow";
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
