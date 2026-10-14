import { describe, it, expect } from "vitest";
import { evidenceWords, paymentWords, suggestionWords, whyNotCounted } from "./evidenceWords";

const ev = (reason: string, suggestion: unknown = null) => ({ class: "unresolved", reason, items: [], suggestion }) as never;

describe("evidenceWords", () => {
  it("says what the bank or the forecast said, in a few words", () => {
    expect(evidenceWords(ev("loan_payment"))).toBe("bank says loan payment");
    expect(evidenceWords(ev("transfer_evidence", { kind: "transfer", detail: "savings", target: null }))).toBe("bank says a transfer to savings");
    expect(evidenceWords(ev("income_evidence"))).toBe("bank says income");
    expect(evidenceWords(ev("bill_suggestion", { kind: "bill", detail: null, target: { label: "Shieldline Life" } }))).toBe("may be the Shieldline Life bill");
    expect(evidenceWords(ev("credit_in_expense_category"))).toBe("money in filed under an expense category");
    expect(evidenceWords(ev("debit_in_income_category"))).toBe("money out filed under an income category");
    expect(evidenceWords(null)).toBe("");
  });

  it("whyNotCounted is one line; suggestion is what H2 thinks it is", () => {
    expect(whyNotCounted(ev("loan_payment"))).toBe("Not counted yet: bank says loan payment.");
    expect(whyNotCounted(null)).toBe("Not counted yet.");
    expect(suggestionWords(ev("loan_payment", { kind: "loan_payment", detail: null, target: null }))).toBe("Probably a loan payment");
    expect(suggestionWords(ev("x"))).toBe("");
  });

  it("a payment says why it is not spending", () => {
    expect(paymentWords({ class: "confirmed_payment", reason: "card_payment", items: [], suggestion: null } as never)).toBe("Card payment");
    expect(paymentWords({ class: "confirmed_payment", reason: "bill_match", items: [], suggestion: null } as never)).toBe("Matched to a bill");
    expect(paymentWords(null)).toBe("");
  });
});
