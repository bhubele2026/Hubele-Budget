import { describe, it, expect } from "vitest";
import {
  buildLineRegister,
  buildBucket,
  type Resolution,
  type Transaction,
} from "./forecastMatch";
import type { CashEvent } from "./forecast";

// (#480) Skip from the Missed bucket persists a `skipped` resolution that
// must hide the occurrence from:
//   - the line register (`allPlan` and the visible `rows`),
//   - the Missed bucket panel,
//   - the projected running balance for the selected month.
// These pure-function tests pin that contract so future refactors of
// `forecastMatch` can't silently bring the row back.

const baseRegisterOpts = {
  txns: [] as Transaction[],
  closedMonths: new Set<string>(),
  startBalance: 1000,
  fromISO: "2026-05-01",
  toISO: "2026-05-31",
  today: new Date("2026-05-15"),
};

const event: CashEvent = {
  itemId: "rent",
  date: "2026-05-10",
  label: "Rent",
  amount: -500,
};

describe("Forecast — skipped status (#480)", () => {
  it("excludes a skipped occurrence from allPlan", () => {
    const resolutions: Resolution[] = [
      {
        id: "r-skip",
        recurringItemId: "rent",
        occurrenceDate: "2026-05-10",
        status: "skipped",
        matchedTxnId: null,
      },
    ];
    const { allPlan, rows } = buildLineRegister({
      ...baseRegisterOpts,
      events: [event],
      resolutions,
    });
    expect(allPlan).toHaveLength(0);
    // And no plan row should leak into the visible register either.
    expect(rows.filter((r) => r.kind === "plan")).toHaveLength(0);
  });

  it("excludes a skipped occurrence from the Missed bucket", () => {
    const resolutions: Resolution[] = [
      {
        id: "r-skip",
        recurringItemId: "rent",
        occurrenceDate: "2026-05-10",
        status: "skipped",
        matchedTxnId: null,
      },
    ];
    const { allPlan, allBank } = buildLineRegister({
      ...baseRegisterOpts,
      events: [event],
      resolutions,
    });
    const bucket = buildBucket({
      allPlan,
      allBank,
      resolutions,
      closedMonths: new Set<string>(),
      monthFilter: "2026-05",
    });
    expect(bucket).toHaveLength(0);
  });

  it("does not affect the running-balance projection for the selected month", () => {
    // With NO bank txns the no-bank fallback walks visible rows to
    // project a running balance. A skipped occurrence must be invisible
    // to that walk so the projected end balance stays at startBalance
    // (the rent event no longer counts).
    const resolutions: Resolution[] = [
      {
        id: "r-skip",
        recurringItemId: "rent",
        occurrenceDate: "2026-05-10",
        status: "skipped",
        matchedTxnId: null,
      },
    ];
    const { rows: skipped } = buildLineRegister({
      ...baseRegisterOpts,
      events: [event],
      resolutions,
    });
    // Sanity: an unresolved control case DOES include the rent row and
    // therefore drags the projection down by $500.
    const { rows: control } = buildLineRegister({
      ...baseRegisterOpts,
      events: [event],
      resolutions: [],
    });
    const lastBalance = (rows: typeof skipped): number | undefined =>
      rows.length === 0 ? baseRegisterOpts.startBalance : rows[rows.length - 1].runningBalance;
    expect(lastBalance(control)).toBeCloseTo(500, 2);
    expect(lastBalance(skipped)).toBeCloseTo(1000, 2);
  });

  it("keeps `missed` and `dismissed` rows visible — only `skipped` is suppressed", () => {
    // Defence: this test guards against a regression where a future
    // refactor accidentally widens the skip filter to also drop
    // `missed`/`dismissed` rows.
    const eventA: CashEvent = { ...event, itemId: "a", date: "2026-05-05" };
    const eventB: CashEvent = { ...event, itemId: "b", date: "2026-05-12" };
    const eventC: CashEvent = { ...event, itemId: "c", date: "2026-05-20" };
    const resolutions: Resolution[] = [
      {
        id: "rA",
        recurringItemId: "a",
        occurrenceDate: "2026-05-05",
        status: "missed",
        matchedTxnId: null,
      },
      {
        id: "rB",
        recurringItemId: "b",
        occurrenceDate: "2026-05-12",
        status: "dismissed",
        matchedTxnId: null,
      },
      {
        id: "rC",
        recurringItemId: "c",
        occurrenceDate: "2026-05-20",
        status: "skipped",
        matchedTxnId: null,
      },
    ];
    const { allPlan } = buildLineRegister({
      ...baseRegisterOpts,
      events: [eventA, eventB, eventC],
      resolutions,
    });
    const ids = allPlan.map((p) => p.itemId).sort();
    expect(ids).toEqual(["a", "b"]);
    const bucket = buildBucket({
      allPlan,
      allBank: [],
      resolutions,
      closedMonths: new Set<string>(),
      monthFilter: "2026-05",
    });
    // Both `missed` and `dismissed` map to status="missed" in the bucket;
    // the `skipped` resolution is intentionally absent.
    expect(bucket.map((b) => b.id).sort()).toEqual(["rA", "rB"]);
    expect(bucket.every((b) => b.status === "missed")).toBe(true);
  });
});
