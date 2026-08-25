import { describe, it, expect } from "vitest";
import {
  buildAllowanceRollup,
  monthlyCapFor,
  type AllowanceAggregateRow,
} from "./budgetAllowance";

const row = (
  bucket: string | null,
  subBucket: string | null,
  spend: string,
  cnt = "1",
): AllowanceAggregateRow => ({ bucket, subBucket, spend, cnt });

const CAPS = { weekly: "450.00", monthly: "440.45", unplanned: "200.00" };

describe("monthlyCapFor", () => {
  it("scales the weekly cap by how many weeks the month holds", () => {
    expect(monthlyCapFor("weekly", 450, 0, 0, 31)).toBeCloseTo(450 * (31 / 7), 6);
    expect(monthlyCapFor("weekly", 450, 0, 0, 28)).toBe(1800);
  });

  it("passes the monthly and unplanned caps through as stored", () => {
    expect(monthlyCapFor("monthly", 450, 440.45, 200, 31)).toBe(440.45);
    expect(monthlyCapFor("unplanned", 450, 440.45, 200, 31)).toBe(200);
  });
});

describe("buildAllowanceRollup", () => {
  it("always returns all three buckets, in order, even with no spend", () => {
    const r = buildAllowanceRollup([], CAPS, 31);
    expect(r.lines.map((l) => l.bucket)).toEqual(["weekly", "monthly", "unplanned"]);
    expect(r.actual).toBe("0.00");
  });

  it("sums each bucket and totals them", () => {
    const r = buildAllowanceRollup(
      [
        row("weekly", "groceries", "312.40", "6"),
        row("weekly", "dining", "180.10", "4"),
        row("monthly", null, "220.00", "2"),
        row("unplanned", null, "75.00", "1"),
      ],
      CAPS,
      31,
    );
    const by = Object.fromEntries(r.lines.map((l) => [l.bucket, l]));
    expect(by.weekly!.actual).toBe("492.50");
    expect(by.weekly!.count).toBe(10);
    expect(by.monthly!.actual).toBe("220.00");
    expect(by.unplanned!.actual).toBe("75.00");
    expect(r.actual).toBe("787.50");
  });

  it("⚠️ the five weekly slices always sum to the weekly total", () => {
    // A breakdown that does not add up to the figure above it is worse than no
    // breakdown, so weekly spend with no slice chosen lands in misc.
    const r = buildAllowanceRollup(
      [
        row("weekly", "groceries", "100.00"),
        row("weekly", null, "40.00"),
        row("weekly", "not-a-real-bucket", "10.00"),
      ],
      CAPS,
      28,
    );
    const weekly = r.lines.find((l) => l.bucket === "weekly")!;
    const slices = weekly.subBuckets.reduce((a, s) => a + parseFloat(s.actual), 0);
    expect(weekly.actual).toBe("150.00");
    expect(slices.toFixed(2)).toBe("150.00");
    expect(weekly.subBuckets.find((s) => s.bucket === "misc")!.actual).toBe("50.00");
  });

  it("gives weekly all five slices and gives monthly/unplanned none", () => {
    const r = buildAllowanceRollup([row("monthly", "dining", "10.00")], CAPS, 30);
    const by = Object.fromEntries(r.lines.map((l) => [l.bucket, l]));
    expect(by.weekly!.subBuckets.map((s) => s.bucket)).toEqual([
      "groceries",
      "dining",
      "alcohol",
      "entertainment",
      "misc",
    ]);
    expect(by.monthly!.subBuckets).toEqual([]);
    expect(by.unplanned!.subBuckets).toEqual([]);
  });

  it("ignores rows with no bucket — unmarked spend counts nowhere", () => {
    // `effectiveBucket` has no auto-default: blank means blank. An earlier
    // build defaulted unmarked expenses to weekly and double-counted them.
    const r = buildAllowanceRollup(
      [row(null, null, "9999.00", "40"), row("weekly", "misc", "25.00")],
      CAPS,
      30,
    );
    expect(r.actual).toBe("25.00");
  });

  it("reports the weeks basis it used", () => {
    expect(buildAllowanceRollup([], CAPS, 31).weeksInMonth).toBe("4.43");
    expect(buildAllowanceRollup([], CAPS, 28).weeksInMonth).toBe("4.00");
  });

  it("treats missing caps as zero", () => {
    const r = buildAllowanceRollup(
      [],
      { weekly: null, monthly: undefined, unplanned: "" },
      31,
    );
    expect(r.planned).toBe("0.00");
  });
});
