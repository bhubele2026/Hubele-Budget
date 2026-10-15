import { describe, it, expect } from "vitest";
import { amexSummaryMatches, scoped } from "./queryState";

/** (Q4) `scoped`: previous-scope data is never `data`. */
describe("scoped", () => {
  const is = (want: string) => (d: { id: string }) => d.id === want;

  it("a matching response is data", () => {
    expect(scoped({ data: { id: "a" } }, is("a"))).toEqual({ data: { id: "a" }, previous: undefined, isSwitching: false });
  });

  it("another scope's response is only `previous`, and says it is switching", () => {
    const r = scoped({ data: { id: "all" } }, is("plat"));
    expect(r.data).toBeUndefined();
    expect(r.previous).toEqual({ id: "all" });
    expect(r.isSwitching).toBe(true);
  });

  it("a placeholder is never data, even if it happens to match", () => {
    const r = scoped({ data: { id: "a" }, isPlaceholderData: true }, is("a"));
    expect(r.data).toBeUndefined();
    expect(r.isSwitching).toBe(true);
  });

  it("no response yet is not 'switching'", () => {
    expect(scoped({ data: undefined }, is("a"))).toEqual({ data: undefined, previous: undefined, isSwitching: false });
  });
});

describe("amexSummaryMatches", () => {
  const sum = (accountId: string | null, from: string, to: string, limitations: string[] = []) => ({
    scope: { accountId },
    period: { from, to },
    limitations,
  });
  const req = { accountId: "plat", from: "2026-09-13", to: "2026-09-19" };

  it("same card and days", () => {
    expect(amexSummaryMatches(sum("plat", "2026-09-13", "2026-09-19"), req)).toBe(true);
  });
  it("all cards is accountId null", () => {
    expect(amexSummaryMatches(sum(null, "2026-09-13", "2026-09-19"), { ...req, accountId: "all" })).toBe(true);
    expect(amexSummaryMatches(sum(null, "2026-09-13", "2026-09-19"), req)).toBe(false);
  });
  it("another card or other days is not a match", () => {
    expect(amexSummaryMatches(sum("gold", "2026-09-13", "2026-09-19"), req)).toBe(false);
    expect(amexSummaryMatches(sum("plat", "2026-09-06", "2026-09-12"), req)).toBe(false);
    expect(amexSummaryMatches(sum("plat", "2026-09-14", "2026-09-19"), req)).toBe(false);
  });
  it("a from the server moved up to the tracking start still counts, only when it says so", () => {
    const asked = { accountId: "plat", from: "2026-04-01", to: "2026-04-30" };
    expect(amexSummaryMatches(sum("plat", "2026-04-15", "2026-04-30", ["tracking_start:2026-04-15"]), asked)).toBe(true);
    expect(amexSummaryMatches(sum("plat", "2026-04-15", "2026-04-30"), asked)).toBe(false);
  });
});
