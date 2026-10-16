import { describe, expect, it } from "vitest";
import { calculatedLine, rowsWords } from "./checkingWords";
import { bankReadCaption, openingCaption } from "./openingWords";

const READ = { balance: "0.00", at: "2026-10-15T12:02:00.000Z", source: "plaid" }; // Oct 15, 7:02 AM Chicago

describe("(C1) calculatedLine", () => {
  it("a real $0.00 reading with rows since", () => {
    expect(calculatedLine(READ, { count: 2 })).toBe("Calculated · bank read $0.00 Oct 15, 7:02 AM · +2 rows since");
  });
  it("one row is singular; none says so", () => {
    expect(calculatedLine(READ, { count: 1 })).toBe("Calculated · bank read $0.00 Oct 15, 7:02 AM · +1 row since");
    expect(calculatedLine(READ, { count: 0 })).toBe("Calculated · bank read $0.00 Oct 15, 7:02 AM · no rows since");
  });
  it("no 'since' half (the response did not carry it) says nothing about rows", () => {
    expect(calculatedLine(READ, null)).toBe("Calculated · bank read $0.00 Oct 15, 7:02 AM");
    expect(calculatedLine(READ, undefined)).toBe("Calculated · bank read $0.00 Oct 15, 7:02 AM");
  });
  it("a typed balance is said as typed, never as the bank's", () => {
    expect(calculatedLine({ balance: "120.00", at: READ.at, source: "manual" }, { count: 3 })).toBe("Typed balance $120.00 (not from the bank) · Oct 15");
  });
  it("no reading: one plain sentence; null, empty and unparsable balances are 'no reading', never $0.00", () => {
    expect(calculatedLine(null, null)).toBe("No bank reading yet");
    expect(calculatedLine(undefined, { count: 2 })).toBe("No bank reading yet");
    expect(calculatedLine({ balance: null, at: READ.at }, null)).toBe("No bank reading yet");
    expect(calculatedLine({ balance: "", at: READ.at }, null)).toBe("No bank reading yet");
    expect(calculatedLine({ balance: "abc", at: READ.at }, null)).toBe("No bank reading yet");
    expect(calculatedLine({ balance: "5.00", at: null }, null)).toBe("No bank reading yet");
  });
});

describe("(C2) the chart's first point, in words", () => {
  it("opens and closes are two moments", () => {
    expect(openingCaption({ dateLabel: "Oct 16", opens: "0.00", closes: 2614.20, hasReading: true })).toBe("Oct 16 · opens $0.00 · closes $2,614.20");
  });
  it("no reading: dashes, never $0.00", () => {
    expect(openingCaption({ dateLabel: "Oct 16", opens: "0.00", closes: "0.00", hasReading: false })).toBe("Oct 16 · opens — · closes —");
    expect(openingCaption({ dateLabel: null, opens: null, closes: undefined, hasReading: true })).toBe("opens — · closes —");
  });
  it('the bank-read line always says since', () => {
    expect(bankReadCaption(READ, { count: 2 })).toBe("Bank read $0.00 Oct 15, 7:02 AM · +2 rows since");
    expect(bankReadCaption(READ, { count: 0 })).toBe("Bank read $0.00 Oct 15, 7:02 AM · no rows since");
    expect(bankReadCaption(null, null)).toBe("No bank reading yet");
  });
  it("rowsWords", () => {
    expect(rowsWords(null)).toBeNull();
    expect(rowsWords({ count: 5 }, "today")).toBe("+5 rows today");
  });
});
