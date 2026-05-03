import { describe, it, expect } from "vitest";
import { amexSignedAmount } from "../lib/workbookImporter";

// Canonical Amex sign convention (Task #93/#130): expense charges are stored
// POSITIVE, payments / credits / income are stored NEGATIVE. The Amex page's
// monthTotals split (positive => CHARGES, negative => PAYMENTS & CREDITS)
// and `scripts/src/importApril2026Amex.ts` both rely on this. Lock it in.
describe("workbookImporter.amexSignedAmount", () => {
  it("stores Expense rows as POSITIVE regardless of input sign", () => {
    expect(amexSignedAmount("Expense", 42.18)).toBe("42.18");
    expect(amexSignedAmount("Expense", -42.18)).toBe("42.18");
    expect(amexSignedAmount("expense", 0)).toBe("0.00");
  });

  it("stores Income rows as NEGATIVE regardless of input sign", () => {
    expect(amexSignedAmount("Income", 100)).toBe("-100.00");
    expect(amexSignedAmount("income", -100)).toBe("-100.00");
  });

  it("stores Credit rows as NEGATIVE regardless of input sign", () => {
    expect(amexSignedAmount("Credit", 2186.96)).toBe("-2186.96");
    expect(amexSignedAmount("credit", -2186.96)).toBe("-2186.96");
  });

  it("treats unknown / blank type as expense (positive)", () => {
    expect(amexSignedAmount("", 10)).toBe("10.00");
    expect(amexSignedAmount("Transfer", 10)).toBe("10.00");
  });
});
