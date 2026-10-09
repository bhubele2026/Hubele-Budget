import { describe, it, expect } from "vitest";
import { DECISION, VERDICT, apiMessage, comingSaturday, isWebAddress, monthWord, parseAmount, parseDollars, refusal } from "./afford";

describe("afford words", () => {
  it("every verdict is a word, and the two that break the plan are the loud tone", () => {
    expect(VERDICT.fits.word).toBe("Fits");
    expect(VERDICT.tight.word).toBe("Tight");
    expect(VERDICT.breaks_buffer.word).toBe("Would dip below your buffer");
    expect(VERDICT.breaks_zero.word).toBe("Would overdraw");
    expect([VERDICT.breaks_buffer.chip, VERDICT.breaks_zero.chip]).toEqual(["bad", "bad"]);
  });
  it("decisions", () => {
    expect(Object.values(DECISION).map((d) => d.word)).toEqual(["Waiting", "Approved", "Bought", "Dropped"]);
  });
  it("monthWord", () => {
    expect(monthWord("2027-03")).toBe("Mar 2027");
    expect(monthWord(null)).toBeNull();
    expect(monthWord("nope")).toBeNull();
  });
  it("comingSaturday: today when today is Saturday", () => {
    expect(comingSaturday("2026-10-07")).toBe("2026-10-10"); // Wednesday
    expect(comingSaturday("2026-10-10")).toBe("2026-10-10");
    expect(comingSaturday("2026-10-11")).toBe("2026-10-17"); // Sunday
  });
});

describe("typed dollars", () => {
  it("parseDollars is canonical or null", () => {
    expect(parseDollars("$1,234.5")).toBe("1234.50");
    expect(parseDollars("120")).toBe("120.00");
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
  it("parseAmount", () => {
    expect([parseAmount(""), parseAmount("$12"), parseAmount("1,000.5"), parseAmount("12.345"), parseAmount("abc")]).toEqual([null, 12, 1000.5, "bad", "bad"]);
  });
  it("isWebAddress refuses scripts", () => {
    expect(isWebAddress("https://example.com/x")).toBe(true);
    expect(isWebAddress("javascript:alert(1)")).toBe(false);
  });
});

describe("error words", () => {
  it("uses the server's message, the owner-only sentence, or the fallback", () => {
    expect(apiMessage({ data: { error: "Nope" } }, "x")).toBe("Nope");
    expect(apiMessage({ status: 403 }, "x")).toBe("Only the household owner can do this.");
    expect(apiMessage({}, "x")).toBe("x");
  });
  it("refusal words for the afford check", () => {
    expect(refusal({ data: { error: "date_past_window" } })).toContain("further out");
    expect(refusal({ status: 404 })).toContain("couldn't find that category");
    expect(refusal({})).toBe("Couldn't check that. Nothing changed.");
  });
});
