import { describe, it, expect } from "vitest";
import {
  compareNewestFirst,
  computeRunningBalances,
  sortNewestFirst,
} from "./runningBalance";

describe("computeRunningBalances", () => {
  it("anchors the newest row to the snapshot balance", () => {
    const rows = [
      { id: "a", occurredOn: "2026-05-03", amount: "-25.00" },
      { id: "b", occurredOn: "2026-05-01", amount: "-100.00" },
      { id: "c", occurredOn: "2026-04-29", amount: "1500.00" },
    ];
    const m = computeRunningBalances(rows, 1375);
    expect(m.get("a")).toBe(1375);
    expect(m.get("b")).toBe(1400);
    expect(m.get("c")).toBe(1500);
  });

  it("handles numeric amounts and rounds to cents", () => {
    const rows = [
      { id: "a", occurredOn: "2026-05-03", amount: -12.34 },
      { id: "b", occurredOn: "2026-05-02", amount: -7.66 },
    ];
    const m = computeRunningBalances(rows, 100);
    expect(m.get("a")).toBe(100);
    expect(m.get("b")).toBe(112.34);
  });

  it("returns empty map for empty input", () => {
    expect(computeRunningBalances([], 500).size).toBe(0);
  });

  it("treats invalid amounts as zero", () => {
    const rows = [
      { id: "a", occurredOn: "2026-05-03", amount: "not-a-number" },
      { id: "b", occurredOn: "2026-05-02", amount: "-10.00" },
    ];
    const m = computeRunningBalances(rows, 200);
    expect(m.get("a")).toBe(200);
    expect(m.get("b")).toBe(200);
  });

  it("reconciles back to the implied starting balance", () => {
    // ending = 1000; net = -10 + -20 + 100 = 70 → starting = 930
    const rows = [
      { id: "a", occurredOn: "2026-05-03", amount: "-10.00" },
      { id: "b", occurredOn: "2026-05-02", amount: "-20.00" },
      { id: "c", occurredOn: "2026-05-01", amount: "100.00" },
    ];
    const m = computeRunningBalances(rows, 1000);
    // Balance shown beside the oldest row in the month (after that row
    // posted) minus that row's amount should equal the previous
    // month-end balance.
    const oldestBalAfter = m.get("c")!;
    const oldestAmount = 100;
    expect(oldestBalAfter - oldestAmount).toBe(930);
  });
});

describe("compareNewestFirst", () => {
  it("orders by occurredOn descending", () => {
    const rows = [
      { id: "a", occurredOn: "2026-05-01", amount: "-1.00" },
      { id: "b", occurredOn: "2026-05-03", amount: "-1.00" },
      { id: "c", occurredOn: "2026-05-02", amount: "-1.00" },
    ];
    expect(sortNewestFirst(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("uses occurredAt as a within-day tiebreaker, nulls last", () => {
    const rows = [
      {
        id: "a",
        occurredOn: "2026-05-03",
        amount: "-1.00",
        occurredAt: "2026-05-03T08:00:00Z",
      },
      {
        id: "b",
        occurredOn: "2026-05-03",
        amount: "-1.00",
        occurredAt: "2026-05-03T15:00:00Z",
      },
      {
        id: "c",
        occurredOn: "2026-05-03",
        amount: "-1.00",
        occurredAt: null,
      },
    ];
    // b (15:00) is newest, then a (08:00), then c (no time)
    expect(sortNewestFirst(rows).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("falls back to id descending when occurredAt is identical", () => {
    const rows = [
      { id: "aaa", occurredOn: "2026-05-03", amount: "-1.00" },
      { id: "ccc", occurredOn: "2026-05-03", amount: "-1.00" },
      { id: "bbb", occurredOn: "2026-05-03", amount: "-1.00" },
    ];
    expect(sortNewestFirst(rows).map((r) => r.id)).toEqual([
      "ccc",
      "bbb",
      "aaa",
    ]);
  });

  it("produces same-day balances that decrease toward older rows", () => {
    // Two rows on the same day, both spends. Sorted newest-first by
    // occurredAt: b (later) above a (earlier). Balance after b
    // (newest) = anchor; balance after a (older) = anchor - b.amount.
    const rows = [
      {
        id: "a",
        occurredOn: "2026-05-03",
        amount: "-50.00",
        occurredAt: "2026-05-03T08:00:00Z",
      },
      {
        id: "b",
        occurredOn: "2026-05-03",
        amount: "-25.00",
        occurredAt: "2026-05-03T20:00:00Z",
      },
    ];
    const sorted = sortNewestFirst(rows);
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"]);
    const m = computeRunningBalances(sorted, 1000);
    expect(m.get("b")).toBe(1000); // after the newest spend
    expect(m.get("a")).toBe(1025); // after the earlier same-day spend
  });
});
