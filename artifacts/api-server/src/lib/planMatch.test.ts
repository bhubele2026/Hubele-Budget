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

  it("(PR5 review) matches whole words, never a word inside another word", () => {
    expect(labelEvidence("Rent", "ZELLE TO PARENTS")).toBe(false);
    expect(labelEvidence("Water", "WATERFORD CROSSING")).toBe(false);
    expect(labelEvidence("Home Insurance", "HOMEGOODS 0412")).toBe(false);
  });

  it("(PR5 review) generic words name no one: city, insurance, loan, service, home", () => {
    expect(labelEvidence("City Water", "CITY OF SPRINGFIELD PARKING")).toBe(false);
    expect(labelEvidence("Car Insurance", "INSURANCE BROKERS LLC")).toBe(false);
    expect(labelEvidence("Student Loan", "LOAN DEPOT")).toBe(false);
  });

  it("treats Amex and American Express as the same payee, but 'American' alone is not evidence", () => {
    expect(labelEvidence("Amex payoff", "AMERICAN EXPRESS ACH PMT")).toBe(true);
    expect(labelEvidence("American Express Blue", "AMEX EPAYMENT")).toBe(true);
    expect(labelEvidence("American Water", "AMERICAN EXPRESS ACH PMT")).toBe(false);
  });
});

describe("matchPlansToRows", () => {
  it("$150 plan, $150 paid on the day with the payee's name → high, off the curve", () => {
    const [m, ...rest] = matchPlansToRows([plan("water", "2026-05-10", -150, "City Water")], [
      row("t1", "2026-05-10", -150, "CITY OF SPRINGFIELD WATER"),
    ]);
    expect(rest).toHaveLength(0);
    expect(m).toMatchObject({ planKey: "water|2026-05-10", txnId: "t1", difference: 0, dayDelta: 0, confidence: "high", ambiguous: false, offCurve: true });
  });

  it("$150 plan, $173 paid with the payee's name → medium, difference +23, off the curve (within $25)", () => {
    const [m] = matchPlansToRows([plan("water", "2026-05-10", -150, "City Water")], [
      row("t1", "2026-05-11", -173, "CITY WATER UTIL"),
    ]);
    expect(m).toMatchObject({ txnId: "t1", planAmount: -150, txnAmount: -173, difference: 23, dayDelta: 1, confidence: "medium", offCurve: true });
  });

  it("(PR5 review) a named pair beyond max($25, 10%) is a suggestion only: $1,500 rent vs a $1,200 payment", () => {
    const [m] = matchPlansToRows([plan("rent", "2026-05-20", -1500, "Oak Street Rent")], [
      row("t1", "2026-05-18", -1200, "OAK STREET PROPERTIES"),
    ]);
    expect(m).toMatchObject({ difference: -300, confidence: "low", offCurve: false });
  });

  it("(PR5 review) an underpaid named bill stays on the curve: $38 plan, $20 row → a suggestion only", () => {
    const [m] = matchPlansToRows([plan("debt:card", "2026-05-10", -38, "Golden Card minimum")], [
      row("t", "2026-05-12", -20, "GOLDEN CARD EPAY"),
    ]);
    expect(m).toMatchObject({ difference: -18, confidence: "medium", ambiguous: false, offCurve: false });
    const [close] = matchPlansToRows([plan("water", "2026-05-10", -150, "City Water")], [
      row("t", "2026-05-10", -149.25, "CITY WATER"),
    ]);
    expect(close).toMatchObject({ confidence: "high", offCurve: true });
  });

  it("(PR5 second review) a different bill from the same payee never leaves the curve; the full name does", () => {
    const [fios] = matchPlansToRows([plan("vzw", "2026-05-20", -120, "Verizon Wireless")], [
      row("t", "2026-05-12", -130, "VERIZON FIOS"),
    ]);
    expect(fios).toMatchObject({ confidence: "medium", ambiguous: false, offCurve: false });
    const [mktpl] = matchPlansToRows([plan("prime", "2026-05-15", -14.99, "Amazon Prime")], [
      row("t", "2026-05-13", -29.99, "AMAZON MKTPL US"),
    ]);
    expect(mktpl).toMatchObject({ confidence: "medium", offCurve: false });
    const [full] = matchPlansToRows([plan("vzw", "2026-05-20", -120, "Verizon Wireless")], [
      row("t", "2026-05-18", -130, "VERIZON WIRELESS PAYMENTS"),
    ]);
    expect(full).toMatchObject({ confidence: "medium", offCurve: true });
  });

  it("paid 6 days early and 5 days late both match with the payee's name; 11 early and 15 late do not", () => {
    const p = [plan("rent", "2026-05-15", -1200, "Oak Street Rent")];
    expect(matchPlansToRows(p, [row("t", "2026-05-09", -1200, "OAK STREET PROPERTIES")])[0]?.dayDelta).toBe(-6);
    expect(matchPlansToRows(p, [row("t", "2026-05-20", -1200, "OAK STREET PROPERTIES")])[0]?.dayDelta).toBe(5);
    expect(matchPlansToRows(p, [row("t", "2026-05-04", -1200, "OAK STREET PROPERTIES")])).toHaveLength(0);
    expect(matchPlansToRows(p, [row("t", "2026-05-30", -1200, "OAK STREET PROPERTIES")])).toHaveLength(0);
  });

  it("(PR5 review) without the payee's name: exact within 3 days is a low suggestion that never leaves the curve", () => {
    const p = [plan("gym", "2026-05-10", -150, "Gym")];
    expect(matchPlansToRows(p, [row("t", "2026-05-12", -150, "POS 4411")])[0]).toMatchObject({ confidence: "low", offCurve: false });
    expect(matchPlansToRows(p, [row("t", "2026-05-11", -173, "POS 4411")])).toHaveLength(0);
    expect(matchPlansToRows(p, [row("t", "2026-05-14", -150, "POS 4411")])).toHaveLength(0);
  });

  it("(PR5 review) a small bill and an unrelated card purchase: a low suggestion, never off the curve", () => {
    const [m] = matchPlansToRows([plan("netflix", "2026-05-15", -15.49, "Netflix")], [
      row("t", "2026-05-13", -15, "CHIPOTLE 2231"),
    ]);
    expect(m).toMatchObject({ confidence: "low", offCurve: false });
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
    expect(m).toMatchObject({ planItemId: "debt:sapphire", txnId: "t", confidence: "high", offCurve: true });
  });

  it("never pairs opposite signs", () => {
    expect(matchPlansToRows([plan("pay", "2026-05-10", 2000, "Paycheck")], [row("t", "2026-05-10", -2000, "PAYCHECK")])).toHaveLength(0);
  });

  it("one to one: the better row wins, and a close runner-up marks the pair ambiguous — which keeps it on the curve", () => {
    const out = matchPlansToRows([plan("water", "2026-05-10", -150, "City Water")], [
      row("near", "2026-05-10", -150, "CITY WATER"),
      row("close", "2026-05-11", -150, "CITY WATER"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ txnId: "near", ambiguous: true, offCurve: false });
  });

  it("a rejected pair ('Not this') never returns, and another row can still match", () => {
    const plans = [plan("water", "2026-05-10", -150, "City Water")];
    const rows = [row("wrong", "2026-05-10", -150, "CITY WATER"), row("right", "2026-05-12", -151, "CITY WATER")];
    const out = matchPlansToRows(plans, rows, new Set(["water|2026-05-10#wrong"]));
    expect(out.map((m) => m.txnId)).toEqual(["right"]);
  });

  it("income: a deposit of the exact amount with no name is a low suggestion only", () => {
    const [m] = matchPlansToRows([plan("pay-a", "2026-10-09", 2000, "Paycheck A")], [
      row("t", "2026-10-09", 2000, "ACME PAYROLL DIRECT DEP"),
    ]);
    expect(m).toMatchObject({ txnId: "t", confidence: "low", offCurve: false });
  });
});
