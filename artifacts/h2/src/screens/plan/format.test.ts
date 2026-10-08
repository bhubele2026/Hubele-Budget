import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  aprToPercentInput,
  aprWords,
  cadenceWords,
  errorWords,
  isISODate,
  monthEnd,
  monthLabel,
  monthWords,
  ordinal,
  parseDollars,
  parsePositiveDollars,
  percentToApr,
  plainDollars,
  remainingWords,
  shiftMonth,
} from "./format";
import { invalidatePlanWrite } from "./planData";

describe("typed dollars", () => {
  it("accepts dollars, a dollar sign and commas, and returns the API's form", () => {
    expect(parseDollars("350")).toBe("350.00");
    expect(parseDollars("$1,234.5")).toBe("1234.50");
    expect(parseDollars(" 12.34 ")).toBe("12.34");
    expect(parseDollars("0")).toBe("0.00");
  });
  it("refuses what is not an amount of at most two decimals", () => {
    for (const bad of ["", "abc", "-5", "1.234", "1e3", "$", "12,34,56x", "123456789"]) expect(parseDollars(bad)).toBeNull();
  });
  it("a positive amount is above $0", () => {
    expect(parsePositiveDollars("0")).toBeNull();
    expect(parsePositiveDollars("0.00")).toBeNull();
    expect(parsePositiveDollars("0.01")).toBe("0.01");
  });
  it("plainDollars drops .00 and keeps cents", () => {
    expect(plainDollars("600.00")).toBe("600");
    expect(plainDollars("12.5")).toBe("12.50");
    expect(plainDollars(null)).toBe("");
  });
});

describe("APR is a fraction in the API and a percent on screen", () => {
  it("round-trips without float noise", () => {
    expect(aprWords("0.2499")).toBe("24.99%");
    expect(aprToPercentInput("0.2499")).toBe("24.99");
    expect(percentToApr("24.99")).toBe("0.2499");
    expect(percentToApr("0")).toBe("0.0000");
    expect(percentToApr("101")).toBeNull();
    expect(percentToApr("x")).toBeNull();
  });
});

describe("months", () => {
  it("shifts across year ends and finds the last day", () => {
    expect(shiftMonth("2026-12-01", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(monthEnd("2026-10-01")).toBe("2026-10-31");
    expect(monthEnd("2028-02-01")).toBe("2028-02-29");
    expect(monthLabel("2026-10-01")).toBe("October 2026");
    expect(monthWords("2029-03")).toBe("Mar 2029");
  });
});

describe("remaining is planned less spent, in whole cents", () => {
  it("left, over, even", () => {
    expect(remainingWords(260, 172.18)).toEqual({ kind: "left", amount: 87.82 });
    expect(remainingWords(100, 100.01)).toEqual({ kind: "over", amount: 0.01 });
    expect(remainingWords(0.3, 0.1 + 0.2)).toEqual({ kind: "even", amount: 0 });
  });
});

describe("words", () => {
  it("cadence, ordinals, dates, errors", () => {
    expect(cadenceWords("monthly", 3)).toBe("monthly, the 3rd");
    expect(cadenceWords("onetime")).toBe("one time");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(22)).toBe("22nd");
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-10-07")).toBe(true);
    expect(errorWords({ status: 403 })).toBe("Only the household owner can change this.");
    expect(errorWords(new Error("x"))).toBe("Couldn't save. Try again.");
  });
});

describe("a Plan write marks the plan's reads stale", () => {
  it("marks the lists it edits and what derives from them, and nothing else", () => {
    const qc = new QueryClient();
    const marked = [
      "/api/allowance-plans",
      "/api/recurring-items",
      "/api/bills/summary",
      "/api/debts",
      "/api/debt-plan",
      "/api/avalanche/settings",
      "/api/avalanche/extra",
      "/api/budget/months/2026-10-01",
      "/api/forecast",
      "/api/money/position",
    ];
    const untouched = ["/api/me", "/api/members"];
    for (const k of [...marked, ...untouched]) qc.setQueryData([k], 1);
    invalidatePlanWrite(qc);
    for (const k of marked) expect(qc.getQueryState([k])?.isInvalidated, k).toBe(true);
    expect(qc.getQueryState(["/api/me"])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(["/api/members"])?.isInvalidated).toBe(false);
  });
});
