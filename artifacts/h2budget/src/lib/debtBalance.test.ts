import { describe, it, expect } from "vitest";
import type { Debt } from "@workspace/api-client-react";
import { joinNames, offPlanCards, offPlanWords, remainingDebtScope, remainingDebtTotal } from "./debtBalance";

const d = (o: Partial<Debt> & { id: string }): Debt =>
  ({ name: o.id, balance: "0", apr: "0", minPayment: "0", payment: "0", status: "active", sortOrder: 0,
    balanceSource: "manual", aprSource: "manual", minPaymentSource: "manual", originalBalance: "1000.00", ...o }) as Debt;

describe("(WP4b) the amount left and % paid measure one population: every active debt", () => {
  it("an archived debt is in neither; an active debt anchored at $0.00 is money left, in both (WP4 dropped it)", () => {
    const debts = [
      d({ id: "a", balance: "500.00", pendingPaymentTotal: "100.00" }),
      d({ id: "b", balance: "250.00" }),
      d({ id: "gone", balance: "999.00", status: "archived" }),
      d({ id: "bare", balance: "120.00", originalBalance: "0.00" }),
    ];
    expect(remainingDebtTotal(debts)).toBe(770);
    expect(remainingDebtScope(debts).names).toEqual(["a", "b", "bare"]);
  });
});

describe("(WP4) offPlanCards / offPlanWords", () => {
  const cards = [
    { id: "r-plat", accountId: "e-plat", name: "American Express Platinum Card ••1005" },
    { id: "r-blue", accountId: "e-blue", name: "American Express Blue Cash Preferred ••1001" },
    { id: "r-citi", accountId: "e-citi", name: "Citi Double Cash ••4411" },
  ];
  const liabilities = [
    { id: "r-plat", balance: "3842.98" },
    { id: "r-blue", balance: "0.00" },
    { id: "r-citi", balance: null },
  ];
  it("a card with no debt row or an archived one is off the plan; one on the plan never is", () => {
    const debts = [d({ id: "blue", plaidAccountId: "r-blue", balance: "250.00" })];
    const off = offPlanCards(cards, debts, { liabilities, weeklyAccountIds: new Set(["e-plat"]) });
    expect(off).toEqual([
      { id: "r-plat", name: "American Express Platinum Card ••1005", weekly: true },
      { id: "r-citi", name: "Citi Double Cash ••4411", weekly: false },
    ]);
  });
  it("leaves out a card off the plan whose own balance is $0.00, keeps one whose balance is unknown", () => {
    const off = offPlanCards(cards, [], { liabilities });
    expect(off.map((c) => c.id)).toEqual(["r-plat", "r-citi"]);
  });
  it("an archived row typed at $0.00 does not hide a card Plaid says carries a balance", () => {
    const debts = [d({ id: "x", plaidAccountId: "r-plat", balance: "0.00", status: "archived" })];
    expect(offPlanCards(cards.slice(0, 1), debts, { liabilities }).map((c) => c.id)).toEqual(["r-plat"]);
  });
  it("the words: 'paid in full weekly' only when every named card is billed weekly; singular and plural", () => {
    expect(offPlanWords([])).toBeNull();
    expect(offPlanWords([{ id: "1", name: "A ••1", weekly: true }])).toEqual({
      text: "A ••1 is paid in full weekly, not on the plan", link: "Put it on the plan",
    });
    expect(offPlanWords([{ id: "1", name: "A", weekly: true }, { id: "2", name: "B", weekly: false }])).toEqual({
      text: "A and B are not on the plan", link: "Put them on the plan",
    });
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });
});
