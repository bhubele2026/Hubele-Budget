import { describe, it, expect } from "vitest";
import { toAprDecimal, AprImportError } from "../lib/workbookImporter";

// Workbook import bypasses POST/PATCH /debts validation, so the importer
// itself must normalize APR cells to decimals in [0, 1).
describe("workbookImporter.toAprDecimal", () => {
  it("treats already-decimal numbers as decimals", () => {
    expect(Number(toAprDecimal(0.2849))).toBeCloseTo(0.2849, 6);
    expect(Number(toAprDecimal(0))).toBe(0);
  });

  it("treats bare numeric percents (e.g. 34.99) as percent and divides by 100", () => {
    expect(Number(toAprDecimal(34.99))).toBeCloseTo(0.3499, 6);
    expect(Number(toAprDecimal(24.99))).toBeCloseTo(0.2499, 6);
  });

  it("strips a trailing % sign and divides by 100", () => {
    expect(Number(toAprDecimal("34.99%"))).toBeCloseTo(0.3499, 6);
    expect(Number(toAprDecimal("24.99 %"))).toBeCloseTo(0.2499, 6);
  });

  it("treats a percent string under 1 (e.g. '0.18%') as the literal percent", () => {
    expect(Number(toAprDecimal("0.18%"))).toBeCloseTo(0.0018, 6);
  });

  it("returns '0' for empty / dash / unparseable cells", () => {
    expect(toAprDecimal(null)).toBe("0");
    expect(toAprDecimal(undefined)).toBe("0");
    expect(toAprDecimal("")).toBe("0");
    expect(toAprDecimal("—")).toBe("0");
    expect(toAprDecimal("not a number")).toBe("0");
  });

  it("THROWS on absurdly malformed APRs (e.g. '3499%' → 34.99) rather than silently clamping", () => {
    expect(() => toAprDecimal("3499%")).toThrow(AprImportError);
    expect(() => toAprDecimal("3499%")).toThrow(/>= 1\.0/);
  });

  it("includes the row context in the thrown error so the importer can surface which debt is bad", () => {
    expect(() => toAprDecimal("3499%", 'debt "Mattress Firm"')).toThrow(/Mattress Firm/);
  });

  it("never returns a value >= 1.0 for any plausible workbook input", () => {
    const samples = [0, 0.18, 0.2849, 18, 24.99, 34.99, 99, "0", "0.18", "18%", "34.99%", "99%"];
    for (const s of samples) {
      const n = Number(toAprDecimal(s));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
});
