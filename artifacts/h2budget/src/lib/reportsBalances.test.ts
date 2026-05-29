import { describe, it, expect } from "vitest";
import {
  resolveAmexRevolvingBalance,
  type BlueCashDebtLike,
} from "./reportsBalances";

const card = (
  name: string,
  balance: BlueCashDebtLike["balance"],
  extra: Partial<BlueCashDebtLike> = {},
): BlueCashDebtLike => ({ name, balance, ...extra });

describe("resolveAmexRevolvingBalance", () => {
  it("sums Blue Cash Preferred and Platinum when both are present", () => {
    const out = resolveAmexRevolvingBalance([
      card("Amex Blue Cash Preferred", "100.00"),
      card("Amex Platinum Card", "250.50"),
    ]);
    expect(out.found).toBe(true);
    expect(out.availableCount).toBe(2);
    expect(out.total).toBeCloseTo(350.5);
    expect(out.blueCash.available).toBe(true);
    expect(out.platinum.available).toBe(true);
  });

  it("shows Platinum plus an unavailable flag when Blue Cash balance is null", () => {
    const out = resolveAmexRevolvingBalance([
      card("Amex Blue Cash Preferred", null),
      card("Amex Platinum Card", "420.00"),
    ]);
    expect(out.found).toBe(true);
    expect(out.availableCount).toBe(1);
    expect(out.total).toBeCloseTo(420);
    expect(out.blueCash.available).toBe(false);
    expect(out.platinum.available).toBe(true);
  });

  it("never includes Delta SkyMiles Gold even though it also ends 1009", () => {
    const out = resolveAmexRevolvingBalance([
      card("Amex Blue Cash Preferred", "100.00"),
      card("Amex Delta SkyMiles Gold", "9999.00"),
    ]);
    expect(out.total).toBeCloseTo(100);
    expect(out.availableCount).toBe(1);
    expect(out.platinum.available).toBe(false);
    expect(out.blueCash.available).toBe(true);
  });

  it("does not match Platinum on Delta SkyMiles Gold and reports not found", () => {
    const out = resolveAmexRevolvingBalance([
      card("Amex Delta SkyMiles Gold", "500.00"),
    ]);
    expect(out.found).toBe(false);
    expect(out.total).toBe(0);
    expect(out.availableCount).toBe(0);
  });

  it("excludes Blue Cash Everyday from the Blue Cash match", () => {
    const out = resolveAmexRevolvingBalance([
      card("Amex Blue Cash Everyday", "75.00"),
    ]);
    expect(out.found).toBe(false);
    expect(out.blueCash.available).toBe(false);
  });

  it("returns not found when neither revolving card is present", () => {
    const out = resolveAmexRevolvingBalance([
      card("Chase Sapphire", "300.00"),
    ]);
    expect(out.found).toBe(false);
    expect(out.total).toBe(0);
    expect(out.availableCount).toBe(0);
  });

  it("returns not found for empty or nullish input", () => {
    expect(resolveAmexRevolvingBalance([]).found).toBe(false);
    expect(resolveAmexRevolvingBalance(null).found).toBe(false);
    expect(resolveAmexRevolvingBalance(undefined).found).toBe(false);
  });

  it("ignores inactive cards and loan-type rows", () => {
    const out = resolveAmexRevolvingBalance([
      card("Amex Blue Cash Preferred", "100.00", { status: "paid" }),
      card("Amex Platinum Card", "200.00", { type: "loan" }),
    ]);
    expect(out.found).toBe(false);
    expect(out.total).toBe(0);
  });

  it("treats a bare 'Blue Cash' name as the Preferred card", () => {
    const out = resolveAmexRevolvingBalance([card("Amex Blue Cash", "60.00")]);
    expect(out.blueCash.available).toBe(true);
    expect(out.total).toBeCloseTo(60);
  });
});
