// (PR-B1) `walkLedger` / `rollForwardBalance` ARE the loops `computeCashSignal`
// ran inline before the move. The oracle below is that code, copied verbatim
// from `cashSignal.ts` at 8148f2a1 (the roll-forward and the daily walk with its
// three accumulators), and both sides are run on 2,000 random ledgers each:
// sorted and unsorted item lists, items before / inside / after the window,
// cent and non-cent amounts, empty and one-day windows, and windows that cross
// both daylight-saving changes. Every output must be identical — the same
// floats, the same strings, the same order of accumulation.

import { describe, it, expect } from "vitest";
import {
  rollForwardBalance,
  walkLedger,
  addDaysISO,
} from "@workspace/avalanche-core";
import { addDays, fmtISO, parseISO } from "./cashSignal";

type Item =
  | { kind: "actual"; date: string; amount: number; matched: boolean }
  | { kind: "plan"; date: string; amount: number };

function r2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** ⚠️ THE ORACLE — `computeCashSignal`'s two loops as they were on 8148f2a1. Do not edit. */
function oracle(
  items: Item[],
  startBalanceAtAnchor: number,
  fromDateOnly: Date,
  to: Date,
  fromISO: string,
) {
  let bal = startBalanceAtAnchor;
  for (const it of items) {
    if (it.date >= fromISO) break;
    bal = Math.round((bal + it.amount) * 100) / 100;
  }
  const startingBalance = bal;

  const totalDays = Math.round((to.getTime() - fromDateOnly.getTime()) / 86_400_000) + 1;
  const daily: Array<{ date: string; balance: string }> = [];
  let lowest = startingBalance;
  let lowestDate: string | null = null;
  let projectedIncome = 0;
  let projectedExpenses = 0;
  let acceptedImpact = 0;

  let cursor = 0;
  while (cursor < items.length && items[cursor].date < fromISO) cursor++;

  for (let i = 0; i < totalDays; i++) {
    const d = addDays(fromDateOnly, i);
    const dISO = fmtISO(d);
    while (cursor < items.length && items[cursor].date <= dISO) {
      const it = items[cursor];
      bal = Math.round((bal + it.amount) * 100) / 100;
      if (it.amount > 0) projectedIncome += it.amount;
      else projectedExpenses += -it.amount;
      if (it.kind === "actual" && it.matched) acceptedImpact += it.amount;
      cursor++;
    }
    if (bal < lowest) {
      lowest = bal;
      lowestDate = dISO;
    }
    daily.push({ date: dISO, balance: r2(bal) });
  }
  return { startingBalance, daily, lowest, lowestDate, endingBalance: bal, projectedIncome, projectedExpenses, acceptedImpact };
}

/** The new path, wired the way `computeCashSignal` wires it. */
function viaWalk(items: Item[], startBalanceAtAnchor: number, fromISO: string, toISO: string) {
  const startingBalance = rollForwardBalance(items, startBalanceAtAnchor, fromISO);
  let projectedIncome = 0;
  let projectedExpenses = 0;
  let acceptedImpact = 0;
  const walk = walkLedger(items, startingBalance, fromISO, toISO, (it) => {
    if (it.amount > 0) projectedIncome += it.amount;
    else projectedExpenses += -it.amount;
    if (it.kind === "actual" && it.matched) acceptedImpact += it.amount;
  });
  return {
    startingBalance,
    daily: walk.daily,
    lowest: walk.lowest,
    lowestDate: walk.lowestDate,
    endingBalance: walk.endingBalance,
    projectedIncome,
    projectedExpenses,
    acceptedImpact,
  };
}

/** mulberry32 — a small seeded PRNG, so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Window starts chosen to straddle both US daylight-saving changes, a year end and a leap day.
const STARTS = ["2026-03-01", "2026-03-07", "2026-10-30", "2026-11-01", "2026-12-20", "2028-02-27", "2026-05-14"];

function randomLedger(rand: () => number) {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const fromISO = STARTS[int(0, STARTS.length - 1)]!;
  const days = [0, 0, 1, 6, 30, 90, 120][int(0, 6)]!;
  const n = int(0, 60);
  const items: Item[] = [];
  for (let i = 0; i < n; i++) {
    const date = addDaysISO(fromISO, int(-20, days + 20));
    const shape = rand();
    const amount =
      shape < 0.6
        ? int(-500_000, 300_000) / 100 // whole cents
        : shape < 0.85
          ? (rand() - 0.6) * 4000 // not cents at all (a posted − pending difference can be any float)
          : shape < 0.95
            ? 0
            : int(-50, 50) / 1000; // sub-cent
    items.push(
      rand() < 0.5
        ? { kind: "actual", date, amount, matched: rand() < 0.3 }
        : { kind: "plan", date, amount },
    );
  }
  if (rand() < 0.8) items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const start = rand() < 0.1 ? 0 : int(-200_000, 1_000_000) / 100 + (rand() < 0.2 ? rand() / 7 : 0);
  return { items, start, fromISO, days };
}

describe("walkLedger + rollForwardBalance — the move is exact", () => {
  it("equals the old inline loops on 2,000 random ledgers (seeded)", () => {
    const rand = rng(20261007);
    let nonEmpty = 0;
    let unsorted = 0;
    let wentLower = 0;
    for (let i = 0; i < 2000; i++) {
      const { items, start, fromISO, days } = randomLedger(rand);
      const fromDateOnly = parseISO(fromISO);
      const to = addDays(fromDateOnly, days);
      const toISO = fmtISO(to);
      const want = oracle(items, start, fromDateOnly, to, fromISO);
      const got = viaWalk(items, start, fromISO, toISO);
      expect(got, `case ${i}`).toEqual(want);
      // toEqual treats -0 and 0 alike only through Object.is in some versions — pin the floats exactly.
      expect(Object.is(got.lowest, want.lowest), `case ${i} lowest`).toBe(true);
      expect(Object.is(got.endingBalance, want.endingBalance), `case ${i} ending`).toBe(true);
      expect(Object.is(got.startingBalance, want.startingBalance), `case ${i} start`).toBe(true);
      if (got.daily.length > 1) nonEmpty++;
      if (items.some((it, k) => k > 0 && items[k - 1]!.date > it.date)) unsorted++;
      if (got.lowestDate) wentLower++;
    }
    // Not vacuous: the generator reached the shapes it claims to.
    expect(nonEmpty).toBeGreaterThan(1000);
    expect(unsorted).toBeGreaterThan(200);
    expect(wentLower).toBeGreaterThan(500);
  });

  it("walks the window both ends inclusive, across the spring-forward night", () => {
    const w = walkLedger(
      [
        { date: "2026-03-07", amount: -10 },
        { date: "2026-03-08", amount: -20 },
        { date: "2026-03-09", amount: 5 },
        { date: "2026-03-10", amount: -1000 },
      ],
      100,
      "2026-03-07",
      "2026-03-09",
    );
    expect(w.daily).toEqual([
      { date: "2026-03-07", balance: "90.00" },
      { date: "2026-03-08", balance: "70.00" },
      { date: "2026-03-09", balance: "75.00" },
    ]);
    expect(w.lowest).toBe(70);
    expect(w.lowestDate).toBe("2026-03-08");
    expect(w.endingBalance).toBe(75);
  });

  it("a window that never goes below its start has no lowest date", () => {
    const w = walkLedger([{ date: "2026-05-02", amount: 50 }], 10, "2026-05-01", "2026-05-03");
    expect(w.lowest).toBe(10);
    expect(w.lowestDate).toBeNull();
  });

  it("rollForwardBalance stops at the first item on or after the window", () => {
    expect(
      rollForwardBalance(
        [
          { date: "2026-04-30", amount: -1.005 },
          { date: "2026-05-01", amount: -50 },
          { date: "2026-04-29", amount: -7 },
        ],
        100,
        "2026-05-01",
      ),
    ).toBe(Math.round((100 - 1.005) * 100) / 100);
  });
});
