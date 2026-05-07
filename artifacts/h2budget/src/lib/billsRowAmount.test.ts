import { describe, it, expect } from "vitest";
import { formatBillRowAmount } from "./billsRowAmount";

describe("formatBillRowAmount", () => {
  it("biweekly income shows per-event amount and ~26/12 monthly hint", () => {
    const r = formatBillRowAmount(4050, "biweekly", "+");
    expect(r.amountText).toBe("+$4,050.00 biweekly");
    expect(r.monthlyHint).toBe("~$8,775.00/mo");
  });

  it("weekly bill shows per-event amount and ~52/12 monthly hint", () => {
    const r = formatBillRowAmount(100, "weekly", "−");
    expect(r.amountText).toBe("−$100.00 weekly");
    expect(r.monthlyHint).toBe("~$433.33/mo");
  });

  it("semimonthly shows per-event amount and 2x monthly hint", () => {
    const r = formatBillRowAmount(500, "semimonthly", "+");
    expect(r.amountText).toBe("+$500.00 semi-monthly");
    expect(r.monthlyHint).toBe("~$1,000.00/mo");
  });

  it("monthly shows no monthly hint (entered amount already is monthly)", () => {
    const r = formatBillRowAmount(120, "monthly", "−");
    expect(r.amountText).toBe("−$120.00 monthly");
    expect(r.monthlyHint).toBeNull();
  });

  it("onetime shows no monthly hint", () => {
    const r = formatBillRowAmount(250, "onetime", "−");
    expect(r.amountText).toBe("−$250.00 one-time");
    expect(r.monthlyHint).toBeNull();
  });

  it("uses the absolute value so callers control the sign", () => {
    const r = formatBillRowAmount(-4050, "biweekly", "+");
    expect(r.amountText).toBe("+$4,050.00 biweekly");
  });
});
