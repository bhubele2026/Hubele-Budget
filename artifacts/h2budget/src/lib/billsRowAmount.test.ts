import { describe, it, expect } from "vitest";
import { formatBillRowAmount } from "./billsRowAmount";

describe("formatBillRowAmount", () => {
  // (#492) Hint mirrors the API's calendar-expanded monthlyAmount for the
  // viewed month so it always equals the Budget page's "Budgeted" column
  // for the same line. Two- vs three-paycheck months therefore show
  // different hints rather than a smoothed 26/12 multiplier.
  it("biweekly income in a 3-paycheck month uses the calendar-expanded total", () => {
    const r = formatBillRowAmount(4050, "biweekly", "+", 12150);
    expect(r.amountText).toBe("+$4,050.00 biweekly");
    expect(r.monthlyHint).toBe("~$12,150.00/mo");
  });

  it("biweekly income in a 2-paycheck month uses the calendar-expanded total", () => {
    const r = formatBillRowAmount(4050, "biweekly", "+", 8100);
    expect(r.amountText).toBe("+$4,050.00 biweekly");
    expect(r.monthlyHint).toBe("~$8,100.00/mo");
  });

  it("weekly bill uses the calendar-expanded monthly total", () => {
    const r = formatBillRowAmount(100, "weekly", "−", 400);
    expect(r.amountText).toBe("−$100.00 weekly");
    expect(r.monthlyHint).toBe("~$400.00/mo");
  });

  it("semimonthly uses the calendar-expanded monthly total", () => {
    const r = formatBillRowAmount(500, "semimonthly", "+", 1000);
    expect(r.amountText).toBe("+$500.00 semi-monthly");
    expect(r.monthlyHint).toBe("~$1,000.00/mo");
  });

  it("monthly shows no monthly hint (entered amount already is monthly)", () => {
    const r = formatBillRowAmount(120, "monthly", "−", 120);
    expect(r.amountText).toBe("−$120.00 monthly");
    expect(r.monthlyHint).toBeNull();
  });

  it("onetime shows no monthly hint", () => {
    const r = formatBillRowAmount(250, "onetime", "−", 250);
    expect(r.amountText).toBe("−$250.00 one-time");
    expect(r.monthlyHint).toBeNull();
  });

  it("omits the hint when no monthlyAmount is provided", () => {
    const r = formatBillRowAmount(4050, "biweekly", "+");
    expect(r.amountText).toBe("+$4,050.00 biweekly");
    expect(r.monthlyHint).toBeNull();
  });

  it("uses the absolute value so callers control the sign", () => {
    const r = formatBillRowAmount(-4050, "biweekly", "+", 8100);
    expect(r.amountText).toBe("+$4,050.00 biweekly");
    expect(r.monthlyHint).toBe("~$8,100.00/mo");
  });
});
