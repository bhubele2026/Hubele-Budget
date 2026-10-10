import { describe, it, expect } from "vitest";
import { remainingDebtTotal } from "./debtBalance";
import {
  CARD_WORDS, asOfWords, cardHasFigures, cardOwedView, creditorLabel, debtForAccount, needsLiability, pendingWords,
} from "./cardBalance";

/**
 * (WP3) The one card model. The live case from the audit: Amex Platinum
 * reported $3,842.98 with $2,615.71 of tagged payments not posted yet, so it
 * read "Owed $1,227.27" on the dashboard and "Current balance $3,842.98" on its
 * own page. Both figures are right; this model names each one, once.
 */
const live = {
  balance: "3842.98",
  originalBalance: "3842.98", // GET /debts anchors every debt it returns
  status: "active",
  minPayment: "0",
  dueDay: 22,
  plaidAccountId: "row-plat",
  balanceSource: "plaid",
  lastBalanceUpdate: "2026-10-08T11:00:00Z",
  plaidLastSyncedAt: "2026-10-08T11:00:05Z",
  pendingPaymentTotal: "2615.71",
  pendingPaymentCount: 2,
};

describe("debtForAccount: the internal row id only", () => {
  const debts = [
    { id: "a", plaidAccountId: "row-1" },
    { id: "b", plaidAccountId: "ext-2" },
    { id: "c", plaidAccountId: null },
  ];
  it("matches the account's internal id", () => {
    expect(debtForAccount(debts, { id: "row-1" })?.id).toBe("a");
  });
  it("never matches Plaid's external account_id (debts.plaid_account_id is a uuid FK to plaid_accounts.id)", () => {
    // An account whose EXTERNAL id happens to be "ext-2" is not debt b's account
    // unless its internal row id is "ext-2".
    expect(debtForAccount(debts, { id: "row-2" })).toBeNull();
  });
  it("a debt with no link matches nothing, not even an empty id", () => {
    expect(debtForAccount(debts, { id: "" })).toBeNull();
    expect(debtForAccount(undefined, { id: "row-1" })).toBeNull();
  });
  it("returns an archived row too — the view says what it is", () => {
    expect(debtForAccount([{ id: "z", plaidAccountId: "r", status: "archived" }], { id: "r" })?.id).toBe("z");
  });
});

describe("cardOwedView", () => {
  it("the live case: Owed is netted, the creditor's own figure and the pending payments are named", () => {
    const v = cardOwedView({ debt: live });
    expect(v.state).toBe("on_plan");
    expect(v.owed).toBeCloseTo(1227.27, 2);
    expect(v.creditorCurrent).toEqual({ balance: 3842.98, asOf: "2026-10-08T11:00:00Z", source: "plaid" });
    // Plaid-sourced: pending counts from the creditor's last report (plaidLastSyncedAt).
    expect(v.pending).toEqual({ total: 2615.71, count: 2, since: "2026-10-08T11:00:05Z" });
    expect(v.minPayment).toBeNull(); // "0" = not reported
    expect(v.dueDay).toBe(22);
    expect(v.status).toBe(CARD_WORDS.onPlan);
    // The one total agrees with the row: Owed is what remainingDebtTotal sums.
    expect(remainingDebtTotal([{ ...live, id: "p", name: "Platinum" } as never])).toBeCloseTo(v.owed!, 2);
  });
  it("prefers the API's liabilityAsOf (WP2) for the as-of and the pending cutoff when it is sent", () => {
    const v = cardOwedView({ debt: { ...live, liabilityAsOf: "2026-10-08T09:00:00Z" } });
    expect(v.creditorCurrent?.asOf).toBe("2026-10-08T09:00:00Z");
    expect(v.pending?.since).toBe("2026-10-08T09:00:00Z");
  });
  it("a manual balance counts pending from lastBalanceUpdate", () => {
    const v = cardOwedView({ debt: { ...live, balanceSource: "manual" } });
    expect(v.pending?.since).toBe("2026-10-08T11:00:00Z");
    expect(v.creditorCurrent?.source).toBe("manual");
  });
  it("a real zero is a figure: $0 owed and $0 reported, never null", () => {
    const v = cardOwedView({ debt: { balance: "0.00", status: "active", minPayment: "25" } });
    expect(v.owed).toBe(0);
    expect(v.creditorCurrent?.balance).toBe(0);
    expect(v.minPayment).toBe(25);
    expect(v.pending).toBeNull();
    expect(cardHasFigures(v)).toBe(true);
  });
  it("archived: 'Paid off · not on the payoff plan' — never Owed", () => {
    const v = cardOwedView({ debt: { ...live, status: "archived" } });
    expect(v.state).toBe("archived");
    expect(v.archived).toBe(true);
    expect(v.owed).toBeNull();
    expect(v.status).toBe("Paid off · not on the payoff plan");
    // Its own figure is still told, named as the card's.
    expect(v.creditorCurrent?.balance).toBe(3842.98);
    // …and it never reaches the one total.
    expect(remainingDebtTotal([{ ...live, status: "archived", id: "p", name: "Platinum" } as never])).toBe(0);
  });
  it("archived and manual: the row's old balance never poses as the card's — Plaid's stored figure does, when there is one", () => {
    // Archived at $0.00 by hand the day it was paid off; the card is in use again.
    const row = { balance: "0.00", status: "archived", balanceSource: "manual", dueDay: 22, lastBalanceUpdate: "2026-09-19T12:00:00Z" };
    const none = cardOwedView({ debt: row });
    expect(none.state).toBe("archived");
    expect(none.creditorCurrent).toBeNull(); // not $0.00: that is when it was archived, not now
    const v = cardOwedView({ debt: row, liability: { balance: "1940.00", minPayment: "40.00", lastFetchedAt: "2026-10-09T13:00:00Z", suggestedDebt: null } });
    expect(v.state).toBe("archived");
    expect(v.status).toBe("Paid off · not on the payoff plan");
    expect(v.owed).toBeNull();
    expect(v.creditorCurrent).toEqual({ balance: 1940, asOf: "2026-10-09T13:00:00Z", source: "plaid" });
    expect(v.minPayment).toBe(40);
    expect(v.dueDay).toBe(22); // the liability list sends no due day for a linked card; the row's stands
  });
  it("needsLiability: no debt row, or an archived one", () => {
    expect(needsLiability(null)).toBe(true);
    expect(needsLiability({ status: "archived" })).toBe(true);
    expect(needsLiability({ status: "active" })).toBe(false);
  });
  it("off the plan (no debt row): Plaid's stored liability figures as the card's own, 'Not on the payoff plan'", () => {
    const v = cardOwedView({
      liability: { balance: "684.12", minPayment: "40.00", lastFetchedAt: "2026-10-08T10:00:00Z", suggestedDebt: { dueDay: 14 } },
    });
    expect(v.state).toBe("off_plan");
    expect(v.owed).toBeNull();
    expect(v.creditorCurrent).toEqual({ balance: 684.12, asOf: "2026-10-08T10:00:00Z", source: "plaid" });
    expect(v.minPayment).toBe(40);
    expect(v.dueDay).toBe(14);
    expect(v.status).toBe("Not on the payoff plan");
  });
  it("nothing known: every field null, words not zeros", () => {
    const v = cardOwedView({ liability: { balance: null, minPayment: null } });
    expect(v.creditorCurrent).toBeNull();
    expect(v.minPayment).toBeNull();
    expect(v.dueDay).toBeNull();
    expect(cardHasFigures(v)).toBe(false);
    expect(cardHasFigures(cardOwedView({}))).toBe(false);
  });
  it("a real statement (WP2's `statement`) is read as one; absent, it is null — never the current balance", () => {
    expect(cardOwedView({ debt: live }).statement).toBeNull();
    const v = cardOwedView({ debt: { ...live, statement: { date: "2026-09-28", balance: "2911.40", minPayment: "40.00", dueDate: "2026-10-23" } } });
    expect(v.statement).toEqual({ date: "2026-09-28", balance: 2911.4, minPayment: 40, dueDate: "2026-10-23" });
  });
});

describe("the words", () => {
  it("names the creditor's figure as the card's or the loan's", () => {
    expect(creditorLabel()).toBe("Card's current balance");
    expect(creditorLabel(true)).toBe("Loan's current balance");
  });
  it("as-of and pending words on the household calendar", () => {
    // 03:00 UTC on Oct 9 is still Oct 8 in Chicago.
    expect(asOfWords("2026-10-09T03:00:00Z")).toBe("as of Oct 8");
    expect(asOfWords(null)).toBeNull();
    expect(pendingWords({ total: 1, count: 1, since: "2026-10-08T11:00:00Z" })).toBe("1 payment since Oct 8");
    expect(pendingWords({ total: 1, count: 2, since: null })).toBe("2 payments");
  });
});
