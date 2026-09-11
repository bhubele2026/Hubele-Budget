import { describe, expect, it } from "vitest";
import {
  labelEvidence,
  matchPlansToRows,
  type MatchPlan,
  type MatchRow,
} from "@workspace/avalanche-core";

const plan = (key: string, date: string, amount: number, label: string): MatchPlan => ({
  key: `${key}|${date}`,
  itemId: key,
  occurrenceDate: date,
  date,
  amount,
  label,
});
const row = (txnId: string, occurredOn: string, amount: number, description: string): MatchRow => ({
  txnId,
  occurredOn,
  amount,
  description,
});

describe("labelEvidence", () => {
  it("finds a distinctive label word in the description, ignoring stop-words", () => {
    expect(labelEvidence("Netflix", "NETFLIX.COM 866-579")).toBe(true);
    expect(labelEvidence("Chase Sapphire minimum", "CHASE CREDIT CRD AUTOPAY")).toBe(true);
    expect(labelEvidence("Avalanche extra payment", "ONLINE ACH PAYMENT")).toBe(false);
    expect(labelEvidence("Discover minimum", "CITI CARD ONLINE PAYMENT")).toBe(false);
  });

  it("treats Amex and American Express as the same payee", () => {
    expect(labelEvidence("Amex payoff", "AMERICAN EXPRESS ACH PMT")).toBe(true);
    expect(labelEvidence("American Express Blue", "AMEX EPAYMENT")).toBe(true);
  });
});

describe("matchPlansToRows", () => {
  it("$150 plan, $150 paid on the day with the payee's name → one high-confidence match", () => {
    const [m, ...rest] = matchPlansToRows([plan("water", "2026-05-10", -150, "City Water")], [
      row("t1", "2026-05-10", -150, "CITY OF SPRINGFIELD WATER"),
    ]);
    expect(rest).toHaveLength(0);
    expect(m).toMatchObject({ planKey: "water|2026-05-10", txnId: "t1", difference: 0, dayDelta: 0, confidence: "high", ambiguous: false });
  });

  it("$150 plan, $173 paid → matched with difference +23 (the row counts once; the plan leaves the curve)", () => {
    const [m] = matchPlansToRows([plan("water", "2026-05-10", -150, "City Water")], [
      row("t1", "2026-05-11", -173, "CITY WATER UTIL"),
    ]);
    expect(m).toMatchObject({ txnId: "t1", planAmount: -150, txnAmount: -173, difference: 23, dayDelta: 1, confidence: "medium" });
  });

  it("paid 6 days early and 5 days late both match with the payee's name; 11 early and 15 late do not", () => {
    const p = [plan("rent", "2026-05-15", -1200, "Oak Street Rent")];
    expect(matchPlansToRows(p, [row("t", "2026-05-09", -1200, "OAK STREET PROPERTIES")])[0]?.dayDelta).toBe(-6);
    expect(matchPlansToRows(p, [row("t", "2026-05-20", -1200, "OAK STREET PROPERTIES")])[0]?.dayDelta).toBe(5);
    expect(matchPlansToRows(p, [row("t", "2026-05-04", -1200, "OAK STREET PROPERTIES")])).toHaveLength(0);
    expect(matchPlansToRows(p, [row("t", "2026-05-30", -1200, "OAK STREET PROPERTIES")])).toHaveLength(0);
  });

  it("without the payee's name: exact within 3 days matches; $23 off or 4 days away does not", () => {
    const p = [plan("gym", "2026-05-10", -150, "Gym")];
    expect(matchPlansToRows(p, [row("t", "2026-05-12", -150, "POS 4411")])[0]?.confidence).toBe("medium");
    expect(matchPlansToRows(p, [row("t", "2026-05-11", -173, "POS 4411")])).toHaveLength(0);
    expect(matchPlansToRows(p, [row("t", "2026-05-14", -150, "POS 4411")])).toHaveLength(0);
  });

  it("two −$50 rows and one −$100 plan: no match, so the plan stays and never counts as −$200", () => {
    const out = matchPlansToRows([plan("util", "2026-05-10", -100, "Utility")], [
      row("a", "2026-05-10", -50, "UTILITY CO"),
      row("b", "2026-05-11", -50, "UTILITY CO"),
    ]);
    expect(out).toHaveLength(0);
  });

  it("a stop-word never counts as evidence: 'ACH PAYMENT' does not match the avalanche plan off by $40", () => {
    expect(
      matchPlansToRows([plan("avalanche:extra", "2026-05-31", -400, "Avalanche extra payment")], [
        row("t", "2026-05-30", -440, "ONLINE ACH PAYMENT"),
      ]),
    ).toHaveLength(0);
  });

  it("a card payment matches a debt minimum by the card's name", () => {
    const [m] = matchPlansToRows([plan("debt:sapphire", "2026-05-20", -95, "Chase Sapphire minimum")], [
      row("t", "2026-05-19", -95, "CHASE CREDIT CRD AUTOPAY"),
    ]);
    expect(m).toMatchObject({ planItemId: "debt:sapphire", txnId: "t", confidence: "high" });
  });

  it("never pairs opposite signs", () => {
    expect(matchPlansToRows([plan("pay", "2026-05-10", 2000, "Paycheck")], [row("t", "2026-05-10", -2000, "PAYCHECK")])).toHaveLength(0);
  });

  it("one to one: the better row wins, and a close runner-up marks the pair ambiguous", () => {
    const out = matchPlansToRows([plan("water", "2026-05-10", -150, "City Water")], [
      row("near", "2026-05-10", -150, "CITY WATER"),
      row("close", "2026-05-11", -150, "CITY WATER"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ txnId: "near", ambiguous: true });
  });

  it("a rejected pair ('Not this') never returns, and another row can still match", () => {
    const plans = [plan("water", "2026-05-10", -150, "City Water")];
    const rows = [row("wrong", "2026-05-10", -150, "CITY WATER"), row("right", "2026-05-12", -151, "CITY WATER")];
    const out = matchPlansToRows(plans, rows, new Set(["water|2026-05-10#wrong"]));
    expect(out.map((m) => m.txnId)).toEqual(["right"]);
  });

  it("income: a deposit of the exact amount within three days matches a paycheck plan", () => {
    const [m] = matchPlansToRows([plan("pay-a", "2026-10-09", 2000, "Paycheck A")], [
      row("t", "2026-10-09", 2000, "ACME PAYROLL DIRECT DEP"),
    ]);
    expect(m).toMatchObject({ txnId: "t", confidence: "medium" });
  });
});
