// ⭐ (F5) The card's own ledger, pure: one pairing of card payment credits with
// the checking rows that sent them, and the debt minimums a card's payments paid.
// The forecast wiring is pinned by `missedAnswers.integration.test.ts`.

import { describe, expect, it } from "vitest";
import {
  CARD_CREDIT_PAIR_AFTER,
  CARD_CREDIT_PAIR_BEFORE,
  minimumStatementCloseISO,
  minimumsPaidByCardLedger,
  pairCardPaymentCredits,
  paymentNamesCardIssuer,
  shiftMonthsISO,
  type CardLedgerMinimum,
  type CardLedgerPayment,
} from "@workspace/avalanche-core";

describe("pairCardPaymentCredits — a card credit and the checking row that sent it are one payment", () => {
  it("same cents, the checking row 5 days before to 5 days after, the closest first, each row once", () => {
    const pairs = pairCardPaymentCredits(
      [
        { txnId: "cP", accountId: "plat", occurredOn: "2026-09-22", cents: 52000 },
        { txnId: "cB", accountId: "blue", occurredOn: "2026-09-23", cents: 30000 },
        { txnId: "cX", accountId: "plat", occurredOn: "2026-10-02", cents: 5000 },
        { txnId: "c1", accountId: "plat", occurredOn: "2026-10-08", cents: 15000 },
      ],
      [
        { txnId: "o300", occurredOn: "2026-09-22", cents: 30000, namesIssuer: true },
        { txnId: "o520", occurredOn: "2026-09-22", cents: 52000, namesIssuer: true },
        { txnId: "o150a", occurredOn: "2026-09-28", cents: 15000, namesIssuer: true },
        { txnId: "o150b", occurredOn: "2026-10-08", cents: 15000, namesIssuer: true },
      ],
    );
    expect(pairs.map((p) => `${p.credit.txnId}:${p.outflow?.txnId ?? "-"}`)).toEqual(["cP:o520", "cB:o300", "cX:-", "c1:o150b"]);
  });

  it("(F5 round 2) the window is −5..+5 days: a weekend payment whose bank debit lands 3–5 days after the card credit pairs (it used to stop at +2)", () => {
    expect([CARD_CREDIT_PAIR_BEFORE, CARD_CREDIT_PAIR_AFTER]).toEqual([5, 5]);
    const at = (on: string, cents = 1000) =>
      pairCardPaymentCredits([{ txnId: "c", accountId: "a", occurredOn: "2026-10-09", cents: 1000 }], [{ txnId: "o", occurredOn: on, cents, namesIssuer: true }])[0]!.outflow?.txnId ??
      null;
    expect([at("2026-10-03"), at("2026-10-04"), at("2026-10-12"), at("2026-10-14"), at("2026-10-15"), at("2026-10-12", 1001)]).toEqual([
      null,
      "o",
      "o",
      "o",
      null,
      null,
    ]);
  });

  it("⭐ (F5 round 2) the issuer-name guard: a same-amount row that does not name the issuer is not the card's payment; a row tagged to the card's debt is, named or not", () => {
    const credit = { txnId: "c", accountId: "plat", occurredOn: "2026-10-09", cents: 30000, debtIds: ["platDebt"] };
    const pairWith = (o: { namesIssuer?: boolean; debtId?: string | null }) =>
      pairCardPaymentCredits([credit], [{ txnId: "o", occurredOn: "2026-10-10", cents: 30000, ...o }])[0]!.outflow?.txnId ?? null;
    expect(pairWith({ namesIssuer: false })).toBe(null); // "ZELLE TO LANDLORD" −300
    expect(pairWith({ namesIssuer: true })).toBe("o"); // "AMERICAN EXPRESS ACH PMT" −300
    expect(pairWith({ namesIssuer: false, debtId: "platDebt" })).toBe("o"); // "ONLINE TRANSFER" tagged to the card's debt
    // (F5 round 3, deliberate) Round 2 read "tagged to ANOTHER debt never pairs"; then the
    // credit counted as paid from elsewhere AND the row paid the tagged debt: one payment,
    // two obligations. The card's ledger now wins when no credit on the tagged debt's card claims it.
    expect(pairWith({ namesIssuer: true, debtId: "blueDebt" })).toBe("o");
  });

  it("⭐ (F5 round 3) a tag only says yes: a row tagged to another debt pairs with this card's credit only when no credit on the tagged debt's own card claims it", () => {
    const plat = { txnId: "kP", accountId: "plat", occurredOn: "2026-10-08", cents: 15000, debtIds: ["platDebt"] };
    const blue = { txnId: "kB", accountId: "blue", occurredOn: "2026-10-09", cents: 15000, debtIds: ["blueDebt"] };
    const tagged = { txnId: "c3", occurredOn: "2026-10-08", cents: 15000, namesIssuer: true, debtId: "blueDebt" };
    const show = (pairs: ReturnType<typeof pairCardPaymentCredits>) => pairs.map((p) => `${p.credit.txnId}:${p.outflow?.txnId ?? "-"}`);
    // The mis-tag: the money is on Platinum's ledger, nothing on Blue's → Platinum's.
    expect(show(pairCardPaymentCredits([plat], [tagged]))).toEqual(["kP:c3"]);
    // Blue's own ledger shows the same cents: the tag's card claims it first, whatever the order.
    expect(show(pairCardPaymentCredits([plat, blue], [tagged]))).toEqual(["kP:-", "kB:c3"]);
    // A tagged row that does not name the issuer never pairs here (round 4: a filter, not a rank); one that does, does.
    const plain = { txnId: "t", occurredOn: "2026-10-08", cents: 15000, namesIssuer: false, debtId: "carLoan" };
    expect(show(pairCardPaymentCredits([plat], [plain, { ...tagged, occurredOn: "2026-10-11" }]))).toEqual(["kP:c3"]);
    // Never an untagged row that does not name the issuer (the round-2 guard holds).
    expect(show(pairCardPaymentCredits([plat], [{ txnId: "z", occurredOn: "2026-10-08", cents: 15000, namesIssuer: false }]))).toEqual(["kP:-"]);
  });

  it("⭐ (F5 round 4) pass 2 keeps the issuer-name guard: a same-cents loan payment tagged to the loan never pairs as a card's payment (its minimum stays paid)", () => {
    // The review's probe: Platinum +450 on 10/8 paid from an account H2 does not see; "AUTO FINANCE PMT" −450 on 10/9 tagged to the car loan.
    const plat = { txnId: "kPlat", accountId: "plat", occurredOn: "2026-10-08", cents: 45000, debtIds: ["platDebt"] };
    const loan = { txnId: "loanRow", occurredOn: "2026-10-09", cents: 45000, namesIssuer: false, debtId: "carLoan" };
    const show = (pairs: ReturnType<typeof pairCardPaymentCredits>) => pairs.map((p) => `${p.credit.txnId}:${p.outflow?.txnId ?? "-"}`);
    expect(show(pairCardPaymentCredits([plat], [loan]))).toEqual(["kPlat:-"]); // round 3: ["kPlat:loanRow"]
    // The same tag on a row that names the issuer is a mis-tagged card payment: the card's ledger still wins.
    expect(show(pairCardPaymentCredits([plat], [{ ...loan, namesIssuer: true }]))).toEqual(["kPlat:loanRow"]);
    // Absent (an older caller): read as naming it, as in pass 1.
    expect(show(pairCardPaymentCredits([plat], [{ ...loan, namesIssuer: undefined }]))).toEqual(["kPlat:loanRow"]);
  });

  it("⭐ (F5 round 5, both reviews) pass 2: a row tagged to a debt whose card's own ledger H2 reads pairs whatever its text — that card did not receive it; a debt with no ledger still needs the issuer's name", () => {
    // Review probe: Platinum +150 on 10/8; the bank writes Platinum's payment "ONLINE PMT CARD 7101" and the household tagged it to Blue's debt.
    // Blue's ledger (read, no matching credit) is the evidence: round 4 left them apart, the credit paid Platinum's weeks and the row Blue's minimum.
    const plat = { txnId: "kP", accountId: "plat", occurredOn: "2026-10-08", cents: 15000, debtIds: ["platDebt"] };
    const mis = { txnId: "c3", occurredOn: "2026-10-08", cents: 15000, namesIssuer: false, debtId: "blueDebt" };
    const show = (pairs: ReturnType<typeof pairCardPaymentCredits>) => pairs.map((p) => `${p.credit.txnId}:${p.outflow?.txnId ?? "-"}`);
    // (Round 6) Today 10/14: the 10/8 row is older than its own card's window (10/8 ≤ 10/14 − 5).
    const ledgers = { ledgerDebtIds: ["platDebt", "blueDebt"], todayISO: "2026-10-14" };
    expect(show(pairCardPaymentCredits([plat], [mis]))).toEqual(["kP:-"]); // round 4, no ledger list
    expect(show(pairCardPaymentCredits([plat], [mis], ledgers))).toEqual(["kP:c3"]);
    // Blue's own ledger shows the same cents: pass 1 gives it to Blue first, as before.
    const blue = { txnId: "kB", accountId: "blue", occurredOn: "2026-10-09", cents: 15000, debtIds: ["blueDebt"] };
    expect(show(pairCardPaymentCredits([plat, blue], [mis], ledgers))).toEqual(["kP:-", "kB:c3"]);
    // A loan (no card ledger) that does not name the issuer: never (round 4's guard holds).
    const loan = { txnId: "loanRow", occurredOn: "2026-10-09", cents: 15000, namesIssuer: false, debtId: "carLoan" };
    expect(show(pairCardPaymentCredits([plat], [loan], ledgers))).toEqual(["kP:-"]);
    // An untagged row that names nothing: never (the round-2 guard holds).
    expect(show(pairCardPaymentCredits([plat], [{ ...mis, debtId: null }], ledgers))).toEqual(["kP:-"]);
  });

  it("⭐ (F5 round 5, both reviews) the pairing's issuer name takes the bank's abbreviations; a mis-tagged 'AMERICAN EXP CO' on a loan pairs, 'AUTO FINANCE PMT' never", () => {
    for (const d of ["AMERICAN EXPRESS ACH PMT", "AMEX EPAYMENT ACH PMT", "AMEXEPAYMENT 1234", "AMERICAN EXP CO PAYMENT", "AMER EXP PMT", "AmericanExpress", "Amex"]) {
      expect([d, paymentNamesCardIssuer(d)]).toEqual([d, true]);
    }
    for (const d of ["CAMEXICO TACOS", "AMERICAN EXPEDITIONS", "AMERICAN EXPORT SUPPLY", "AUTO FINANCE PMT", "ONLINE PMT CARD 7101", "", null]) {
      expect([d, paymentNamesCardIssuer(d)]).toEqual([d, false]);
    }
    const plat = { txnId: "kP", accountId: "plat", occurredOn: "2026-10-08", cents: 15000, debtIds: ["platDebt"] };
    const row = (desc: string) => ({ txnId: "c", occurredOn: "2026-10-09", cents: 15000, namesIssuer: paymentNamesCardIssuer(desc), debtId: "carLoan" });
    expect(pairCardPaymentCredits([plat], [row("AMERICAN EXP CO PAYMENT")], { ledgerDebtIds: ["platDebt"] })[0]!.outflow?.txnId).toBe("c");
    expect(pairCardPaymentCredits([plat], [row("AUTO FINANCE PMT")], { ledgerDebtIds: ["platDebt"] })[0]!.outflow).toBeNull();
  });
});

describe("shiftMonthsISO", () => {
  it("the same day a month away, clamped to the month's end", () => {
    expect([shiftMonthsISO("2026-10-04", -1), shiftMonthsISO("2026-10-04", 1), shiftMonthsISO("2026-10-31", -1), shiftMonthsISO("2026-01-31", 1), shiftMonthsISO("2026-12-15", 1)]).toEqual([
      "2026-09-04",
      "2026-11-04",
      "2026-09-30",
      "2026-02-28",
      "2027-01-15",
    ]);
  });
});

describe("minimumsPaidByCardLedger — a payment the card's ledger received pays its minimums by billing cycle, oldest first", () => {
  const min = (date: string, cents = 4500, debtId = "blue"): CardLedgerMinimum => ({ key: `debt:${debtId}|${date}`, debtId, dueDate: date, cents });
  const pay = (txnId: string, on: string, cents: number, debtId = "blue"): CardLedgerPayment => ({ txnId, occurredOn: on, cents, debtId });
  const keys = (paid: ReturnType<typeof minimumsPaidByCardLedger>) => paid.map((p) => `${p.key.slice(-10)} ${p.txnId}`);

  it("the cautious statement close is the due date − 20 days", () => {
    expect([minimumStatementCloseISO("2026-10-04"), minimumStatementCloseISO("2026-09-04"), minimumStatementCloseISO("2026-03-10")]).toEqual([
      "2026-09-14",
      "2026-08-15",
      "2026-02-18",
    ]);
  });

  it("⭐ one payment after the 10/4 statement closed pays 9/4 late AND 10/4 early; what it paid toward each is the minimum", () => {
    expect(minimumsPaidByCardLedger([min("2026-09-04"), min("2026-10-04")], [pay("p", "2026-09-23", 30000)])).toEqual([
      { key: "debt:blue|2026-09-04", txnId: "p", paymentCents: 30000, cents: 4500 },
      { key: "debt:blue|2026-10-04", txnId: "p", paymentCents: 30000, cents: 4500 },
    ]);
  });

  it("⭐ (F5 round 2) a late payment made BEFORE the next statement closed never pays the next minimum too (9/6 pays 9/4 only; 10/4's −45 stays on the curve)", () => {
    expect(keys(minimumsPaidByCardLedger([min("2026-09-04"), min("2026-10-04")], [pay("p", "2026-09-06", 30000)]))).toEqual(["2026-09-04 p"]);
    // The earlier minimum not listed (outside the window): its late payment still cannot pay the next one.
    expect(keys(minimumsPaidByCardLedger([min("2026-09-28")], [pay("p", "2026-08-30", 30000)]))).toEqual([]);
    // On the close day itself: not yet after it.
    expect(keys(minimumsPaidByCardLedger([min("2026-10-04")], [pay("p", "2026-09-14", 30000)]))).toEqual([]);
    expect(keys(minimumsPaidByCardLedger([min("2026-10-04")], [pay("p", "2026-09-15", 30000)]))).toEqual(["2026-10-04 p"]);
  });

  it("a payment pays a minimum only from its statement close up to the next due date; a minimum only in full; another debt's never", () => {
    // 11/4 is the next due date of 10/4: it belongs to 11/4's cycle.
    expect(minimumsPaidByCardLedger([min("2026-10-04")], [pay("p", "2026-11-04", 30000)])).toEqual([]);
    expect(minimumsPaidByCardLedger([min("2026-10-04")], [pay("p", "2026-10-30", 30000)])).toHaveLength(1);
    expect(minimumsPaidByCardLedger([min("2026-10-04")], [pay("p", "2026-10-01", 4499)])).toEqual([]);
    expect(minimumsPaidByCardLedger([min("2026-10-04")], [pay("p", "2026-10-01", 30000, "plat")])).toEqual([]);
  });

  it("a small payment pays what it covers, oldest first; the next payment the rest", () => {
    expect(keys(minimumsPaidByCardLedger([min("2026-09-04"), min("2026-10-04")], [pay("a", "2026-09-10", 5000), pay("b", "2026-09-30", 5000)]))).toEqual([
      "2026-09-04 a",
      "2026-10-04 b",
    ]);
  });

  it("⭐ (F5 round 6, review P3 / C) pass 2 takes a row tagged to a ledger card's debt only once that card's window to receive it has closed (dated on or before today − 5): a correctly tagged payment still on its way is never another card's same-cents credit", () => {
    // Probe P3: checking −100 "ONLINE PMT CARD 7101" on 10/13, tagged to Platinum's own debt; Platinum has not received it yet.
    // Blue has +100 on 10/12 paid from an account H2 does not see. Round 5 gave the row to Blue: it paid no Platinum week and
    // was not in flight (H2 held 120 against the 20 Platinum owes).
    const blue = { txnId: "kB", accountId: "blue", occurredOn: "2026-10-12", cents: 10000, debtIds: ["blueDebt"] };
    const row = { txnId: "c5", occurredOn: "2026-10-13", cents: 10000, namesIssuer: false, debtId: "platDebt" };
    const show = (pairs: ReturnType<typeof pairCardPaymentCredits>) => pairs.map((p) => `${p.credit.txnId}:${p.outflow?.txnId ?? "-"}`);
    const opts = (todayISO?: string) => ({ ledgerDebtIds: ["platDebt", "blueDebt"], todayISO });
    expect(show(pairCardPaymentCredits([blue], [row], opts("2026-10-14")))).toEqual(["kB:-"]); // round 5: ["kB:c5"]
    // The issuer-named variant the same (round 4 and 5 paired it).
    expect(show(pairCardPaymentCredits([blue], [{ ...row, namesIssuer: true }], opts("2026-10-14")))).toEqual(["kB:-"]);
    // Probe C: −150 on 10/12 tagged to Platinum, Blue +150 on 10/12 — the same.
    expect(show(pairCardPaymentCredits([{ ...blue, cents: 15000 }], [{ ...row, occurredOn: "2026-10-12", cents: 15000 }], opts("2026-10-14")))).toEqual(["kB:-"]);
    // Once Platinum had its whole window (the row on or before today − 5) and still shows nothing, the row went to Blue.
    expect(show(pairCardPaymentCredits([blue], [row], opts("2026-10-18")))).toEqual(["kB:c5"]);
    expect(show(pairCardPaymentCredits([blue], [row], opts("2026-10-17")))).toEqual(["kB:-"]);
    // No today: never known to be old enough.
    expect(show(pairCardPaymentCredits([blue], [row], opts()))).toEqual(["kB:-"]);
    // Platinum's own credit, when it posts, claims its row in pass 1, whatever today is.
    const plat = { txnId: "kP", accountId: "plat", occurredOn: "2026-10-14", cents: 10000, debtIds: ["platDebt"] };
    expect(show(pairCardPaymentCredits([blue, plat], [row], opts("2026-10-14")))).toEqual(["kB:-", "kP:c5"]);
    // A debt with no ledger here is not gated (its card's credit never shows): a row naming the issuer pairs at once (round 4).
    expect(show(pairCardPaymentCredits([blue], [{ ...row, namesIssuer: true, debtId: "carLoan" }], opts("2026-10-14")))).toEqual(["kB:c5"]);
  });
});
