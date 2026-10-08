import { describe, it, expect } from "vitest";
import { centsValue, fmtMoney, MISSING, toAmount, wholeDollars } from "./money";
import { formatCurrency } from "./utils";

describe("fmtMoney — blank, never zero", () => {
  it("a missing or unreadable amount is a dash, where formatCurrency says $0.00", () => {
    for (const v of [null, undefined, "", "n/a", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fmtMoney(v)).toBe(MISSING);
      expect(fmtMoney(v, { whole: true })).toBe(MISSING);
    }
    expect(formatCurrency(null)).toBe("$0.00"); // the trap this replaces
  });

  it("every readable amount prints exactly as formatCurrency prints it", () => {
    for (const v of [0, 1234.5, -45, 0.01, -0.01, 1_000_000, 12345.678, "1234.50", "-12.00", 41.3]) {
      expect(fmtMoney(v)).toBe(formatCurrency(v));
    }
    expect(fmtMoney(1234.5)).toBe("$1,234.50");
    expect(fmtMoney("-82.10")).toBe("-$82.10");
  });

  it("a real zero is $0.00 — and never negative zero", () => {
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(-0)).toBe("$0.00");
    expect(fmtMoney(-0.001)).toBe("$0.00");
  });
});

describe("fmtMoney { whole } — h2's whole dollars, half away from zero", () => {
  it.each([
    [1234.5, "$1,235"],
    [1234.49, "$1,234"],
    [0.5, "$1"],
    [0.49, "$0"],
    [12345.67, "$12,346"],
    [-2.5, "-$3"],
    [-2.49, "-$2"],
    [1_000_000, "$1,000,000"],
  ])("%s → %s", (n, out) => {
    expect(fmtMoney(n, { whole: true })).toBe(out);
  });

  it("rounds through integer cents, so float noise never decides a dollar", () => {
    expect(fmtMoney(0.1 + 0.2 + 1234.2, { whole: true })).toBe("$1,235");
    expect(wholeDollars(Number("1234.50"))).toBe(1235);
  });

  it("a real zero is $0 — and never negative zero", () => {
    expect(fmtMoney(0, { whole: true })).toBe("$0");
    expect(fmtMoney(-0.2, { whole: true })).toBe("$0");
  });
});

describe("toAmount — API money strings to numbers", () => {
  it("parses the strings the API sends", () => {
    expect(toAmount("1234.56")).toBe(1234.56);
    expect(toAmount("-12.00")).toBe(-12);
    expect(toAmount(41.3)).toBe(41.3);
  });
  it("anything unreadable is null, never 0", () => {
    expect(toAmount(null)).toBeNull();
    expect(toAmount(undefined)).toBeNull();
    expect(toAmount("")).toBeNull();
    expect(toAmount("n/a")).toBeNull();
  });
});

describe("centsValue — the exact value a figure stands for", () => {
  it("is the amount to the cent", () => {
    expect(centsValue(12345.67)).toBe("12345.67");
    expect(centsValue(412.4)).toBe("412.40");
    expect(centsValue(-2.5)).toBe("-2.50");
  });
});
