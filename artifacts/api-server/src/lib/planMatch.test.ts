import { describe, expect, it } from "vitest";
import {
  labelEvidence,
  matchPlansToRows,
  plansPaidInFullByName,
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

// ⭐ PR6 review (HIGH 1, R4) — a card's overdue minimum is paid by a payment that
// names the card and pays at least the minimum. Overdue evidence only.
describe("plansPaidInFullByName", () => {
  const capOne = plan("debt:cap1", "2026-05-01", -40, "Capital One Platinum minimum");
  const discover = plan("debt:disc", "2026-05-03", -38, "Discover It minimum");

  it("pays each minimum with the payment naming its card, at least the minimum", () => {
    const out = plansPaidInFullByName(
      [capOne, discover],
      [
        row("t-cap", "2026-05-01", -812.4, "CAPITAL ONE MOBILE PYMT"),
        row("t-disc", "2026-05-02", -400, "DISCOVER E-PAYMENT 4411"),
      ],
    );
    expect(out).toEqual([
      { planKey: "debt:cap1|2026-05-01", txnId: "t-cap", txnAmount: -812.4, evidence: "card_payment" },
      { planKey: "debt:disc|2026-05-03", txnId: "t-disc", txnAmount: -400, evidence: "card_payment" },
    ]);
  });

  it("the matcher itself finds no pair for these (a named row is capped at max($25, 25%) off)", () => {
    expect(
      matchPlansToRows([capOne], [row("t-cap", "2026-05-01", -812.4, "CAPITAL ONE MOBILE PYMT")]),
    ).toEqual([]);
  });

  it("never pays with less than the minimum, another card's name, no name, or the wrong sign", () => {
    const rows = [
      row("under", "2026-05-01", -39.99, "CAPITAL ONE MOBILE PYMT"),
      row("other", "2026-05-01", -812.4, "DISCOVER E-PAYMENT"),
      row("noname", "2026-05-01", -812.4, "ONLINE PAYMENT THANK YOU"),
      row("refund", "2026-05-01", 812.4, "CAPITAL ONE MOBILE PYMT"),
    ];
    expect(plansPaidInFullByName([capOne], rows)).toEqual([]);
  });

  it("only inside the matching window: 10 days before to 14 days after", () => {
    const at = (d: string) => plansPaidInFullByName([capOne], [row("t", d, -100, "CAPITAL ONE ONLINE PYMT")]);
    expect(at("2026-04-21")).toHaveLength(1);
    expect(at("2026-05-15")).toHaveLength(1);
    expect(at("2026-04-20")).toEqual([]);
    expect(at("2026-05-16")).toEqual([]);
  });

  it("one row pays one minimum (nearest date first), and a rejected pair never counts", () => {
    // Both minimums are inside the row's window (8 and 2 days away); the nearer one takes it.
    const earlier = plan("debt:cap1", "2026-04-10", -40, "Capital One Platinum minimum");
    const may = plan("debt:cap1", "2026-04-20", -40, "Capital One Platinum minimum");
    const pay = row("t", "2026-04-18", -500, "CAPITAL ONE MOBILE PYMT");
    expect(plansPaidInFullByName([earlier, may], [pay])).toEqual([
      { planKey: "debt:cap1|2026-04-20", txnId: "t", txnAmount: -500, evidence: "card_payment" },
    ]);
    expect(plansPaidInFullByName([may], [pay], new Set(["debt:cap1|2026-04-20#t"]))).toEqual([]);
  });
});

// ⭐ PR6 second review — only a real CARD PAYMENT (PR7's rule) pays a card's
// minimum. A shared name word is not enough: probe E6 found a store purchase, an
// Apple Store receipt and a car-loan payment each paying a card's minimum.
describe("plansPaidInFullByName — the row must be a card payment", () => {
  const target = plan("debt:red", "2026-05-01", -35, "Target RedCard minimum");
  const apple = plan("debt:apple", "2026-05-02", -25, "Apple Card minimum");
  const capOne = plan("debt:cap1", "2026-05-03", -38, "Capital One Platinum minimum");
  const discover = plan("debt:disc", "2026-05-04", -40, "Discover It minimum");

  it("E6: a Target purchase, an Apple Store receipt and a Capital One car-loan payment pay nothing", () => {
    expect(plansPaidInFullByName([target], [row("p1", "2026-05-01", -84.12, "TARGET T-2331")])).toEqual([]);
    expect(plansPaidInFullByName([apple], [row("p2", "2026-05-02", -1299, "APPLE STORE")])).toEqual([]);
    expect(plansPaidInFullByName([capOne], [row("p3", "2026-05-03", -452, "CAPITAL ONE AUTO CARPAY")])).toEqual([]);
  });

  it("a refund naming the card never pays (wrong sign, and not a payment)", () => {
    expect(plansPaidInFullByName([discover], [row("r", "2026-05-04", 40, "DISCOVER CASHBACK")])).toEqual([]);
  });

  it("the issuers' own payment descriptions do pay", () => {
    expect(
      plansPaidInFullByName(
        [target, apple, discover],
        [
          row("t", "2026-05-01", -120, "TARGET CARD SRVC PAYMENT"),
          row("a", "2026-05-02", -300, "GOLDMAN SACHS APPLE CARD PAYMENT"),
          row("d", "2026-05-04", -200, "DISCOVER E-PAYMENT 4411"),
        ],
      ),
    ).toEqual([
      { planKey: "debt:apple|2026-05-02", txnId: "a", txnAmount: -300, evidence: "card_payment" },
      { planKey: "debt:disc|2026-05-04", txnId: "d", txnAmount: -200, evidence: "card_payment" },
      { planKey: "debt:red|2026-05-01", txnId: "t", txnAmount: -120, evidence: "card_payment" },
    ]);
  });

  it("a card payment that doesn't name the card as a word pays nothing ('APPLECARD GSBANK' has no word 'apple')", () => {
    expect(plansPaidInFullByName([apple], [row("a", "2026-05-02", -300, "APPLECARD GSBANK PAYMENT 260502")])).toEqual([]);
  });

  it("a row the user flagged as a card payment, or Plaid calls one, pays — with the card's name", () => {
    const flagged: MatchRow = { ...row("f", "2026-05-03", -100, "CAPITAL ONE XFER 88"), isExternalCardPayment: true };
    const plaid: MatchRow = { ...row("q", "2026-05-03", -100, "CAPITAL ONE 88"), pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" };
    expect(plansPaidInFullByName([capOne], [flagged])).toEqual([{ planKey: "debt:cap1|2026-05-03", txnId: "f", txnAmount: -100, evidence: "card_payment" }]);
    expect(plansPaidInFullByName([capOne], [plaid])).toEqual([{ planKey: "debt:cap1|2026-05-03", txnId: "q", txnAmount: -100, evidence: "card_payment" }]);
    // Still needs the name: a flagged Discover payment never pays Capital One.
    const otherCard: MatchRow = { ...row("o", "2026-05-03", -100, "DISCOVER E-PAYMENT"), isExternalCardPayment: true };
    expect(plansPaidInFullByName([capOne], [otherCard])).toEqual([]);
  });
});

// ⭐ PR6 third look, LOW 2 — a row the user TAGGED to a debt (PR7 rule 2) pays
// that debt's overdue minimum. The tag is the strongest evidence: no name and no
// card-payment phrase is needed. Overdue evidence only.
describe("plansPaidInFullByName — a row tagged to the debt", () => {
  const minimum = (debtId: string, date: string, amount: number, label: string): MatchPlan => ({
    ...plan(`debt:${debtId}`, date, amount, label),
    debtId,
  });
  const tagged = (txnId: string, occurredOn: string, amount: number, description: string, debtId: string): MatchRow => ({
    ...row(txnId, occurredOn, amount, description),
    debtId,
  });
  const sapphire = minimum("sapphire", "2026-05-01", -40, "Chase Sapphire minimum");
  const freedom = minimum("freedom", "2026-05-03", -30, "Chase Freedom minimum");

  it("C5: 'CHASE ONLINE PAYMENT' −600 tagged to Chase Sapphire pays its $40 minimum (not a card payment by PR7's phrases)", () => {
    const pay = tagged("t", "2026-05-01", -600, "CHASE ONLINE PAYMENT", "sapphire");
    expect(plansPaidInFullByName([sapphire], [{ ...pay, debtId: null }])).toEqual([]); // untagged: nothing
    expect(plansPaidInFullByName([sapphire], [pay])).toEqual([
      { planKey: "debt:sapphire|2026-05-01", txnId: "t", txnAmount: -600, evidence: "debt_tag" },
    ]);
    // No name needed either.
    expect(plansPaidInFullByName([sapphire], [tagged("z", "2026-05-01", -60, "ZELLE 88213", "sapphire")])).toEqual([
      { planKey: "debt:sapphire|2026-05-01", txnId: "z", txnAmount: -60, evidence: "debt_tag" },
    ]);
  });

  it("never pays another debt's minimum — not by tag, and not by name or card-payment phrase either", () => {
    expect(plansPaidInFullByName([sapphire], [tagged("t", "2026-05-01", -600, "CHASE ONLINE PAYMENT", "freedom")])).toEqual([]);
    // A card payment naming the card, but tagged to another debt: the tag wins.
    const flagged: MatchRow = { ...tagged("f", "2026-05-01", -600, "CHASE SAPPHIRE PAYMENT", "freedom"), isExternalCardPayment: true };
    expect(plansPaidInFullByName([sapphire], [flagged])).toEqual([]);
    // Both minimums in the window: the tagged row goes to its own debt only.
    expect(plansPaidInFullByName([sapphire, freedom], [tagged("t", "2026-05-02", -600, "CHASE ONLINE PAYMENT", "freedom")])).toEqual([
      { planKey: "debt:freedom|2026-05-03", txnId: "t", txnAmount: -600, evidence: "debt_tag" },
    ]);
    // A plan that doesn't say which debt it is never takes a tagged row.
    expect(plansPaidInFullByName([plan("debt:sapphire", "2026-05-01", -40, "Chase Sapphire minimum")], [tagged("t", "2026-05-01", -600, "CHASE ONLINE PAYMENT", "sapphire")])).toEqual([]);
  });

  it("an amount below the minimum pays nothing; exactly the minimum pays", () => {
    expect(plansPaidInFullByName([sapphire], [tagged("u", "2026-05-01", -39.99, "CHASE ONLINE PAYMENT", "sapphire")])).toEqual([]);
    expect(plansPaidInFullByName([sapphire], [tagged("e", "2026-05-01", -40, "CHASE ONLINE PAYMENT", "sapphire")])).toHaveLength(1);
  });

  it("the wrong sign pays nothing (a refund or credit tagged to the debt)", () => {
    expect(plansPaidInFullByName([sapphire], [tagged("r", "2026-05-01", 600, "CHASE ONLINE PAYMENT", "sapphire")])).toEqual([]);
  });

  it("only inside the window: 10 days before to 14 days after the minimum", () => {
    const at = (d: string) => plansPaidInFullByName([sapphire], [tagged("t", d, -600, "CHASE ONLINE PAYMENT", "sapphire")]);
    expect(at("2026-04-21")).toHaveLength(1);
    expect(at("2026-05-15")).toHaveLength(1);
    expect(at("2026-04-20")).toEqual([]);
    expect(at("2026-05-16")).toEqual([]);
  });

  it("one tagged row pays one occurrence, even inside two occurrences' windows and big enough for both", () => {
    const earlier = minimum("sapphire", "2026-04-24", -40, "Chase Sapphire minimum");
    const later = minimum("sapphire", "2026-05-01", -40, "Chase Sapphire minimum");
    const pay = tagged("t", "2026-04-30", -600, "CHASE ONLINE PAYMENT", "sapphire");
    expect(plansPaidInFullByName([earlier, later], [pay])).toEqual([
      { planKey: "debt:sapphire|2026-05-01", txnId: "t", txnAmount: -600, evidence: "debt_tag" },
    ]);
    // A second tagged row pays the other occurrence.
    expect(
      plansPaidInFullByName([earlier, later], [pay, tagged("t2", "2026-04-25", -40, "CHASE ONLINE PAYMENT", "sapphire")]),
    ).toEqual([
      { planKey: "debt:sapphire|2026-04-24", txnId: "t2", txnAmount: -40, evidence: "debt_tag" },
      { planKey: "debt:sapphire|2026-05-01", txnId: "t", txnAmount: -600, evidence: "debt_tag" },
    ]);
    // A rejected pair ("Not this") never counts.
    expect(plansPaidInFullByName([later], [pay], new Set(["debt:sapphire|2026-05-01#t"]))).toEqual([]);
  });

  it("a tagged pair is taken before a nearer name pair, so one issuer's two payments land on the right cards", () => {
    // "CHASE CREDIT CRD" names both Chase cards; Plaid calls it a card payment. It is nearer to Sapphire,
    // but the tagged row is Sapphire's; the named row then pays Freedom.
    const named: MatchRow = { ...row("n", "2026-05-01", -300, "CHASE CREDIT CRD 4411"), pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" };
    const tag = tagged("t", "2026-05-04", -600, "ONLINE PAYMENT 88", "sapphire");
    expect(plansPaidInFullByName([sapphire, freedom], [named, tag])).toEqual([
      { planKey: "debt:sapphire|2026-05-01", txnId: "t", txnAmount: -600, evidence: "debt_tag" },
      { planKey: "debt:freedom|2026-05-03", txnId: "n", txnAmount: -300, evidence: "card_payment" },
    ]);
  });
});
