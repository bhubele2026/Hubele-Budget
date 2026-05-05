import { describe, it, expect } from "vitest";
import {
  rankPlansForBank,
  type BankLine,
  type PlanLine,
  type Transaction,
} from "./forecastMatch";

function plan(
  itemId: string,
  date: string,
  amount: number,
  label = "",
): PlanLine {
  return {
    kind: "plan",
    date,
    itemId,
    label,
    amount,
    status: "pending_plan",
  };
}

function bank(
  date: string,
  amount: number,
  description = "",
): BankLine {
  const txn: Transaction = {
    id: "t1",
    occurredOn: date,
    description,
    amount: String(amount),
    forecastFlag: true,
    plaidAccountId: "chase",
  };
  return { kind: "bank", date, txn, amount, status: "pending_bank" };
}

describe("rankPlansForBank (#26)", () => {
  it("puts the same-amount, same-date plan first regardless of original order", () => {
    const plans = [
      plan("rent", "2026-05-01", -1500),
      plan("netflix", "2026-05-10", -15.99),
      plan("electric", "2026-05-09", -120.45),
    ];
    const ranked = rankPlansForBank(bank("2026-05-10", -120.45, "PG&E"), plans);
    expect(ranked[0].itemId).toBe("electric");
  });

  it("breaks ties by date proximity when amounts are equal", () => {
    const plans = [
      plan("a", "2026-05-20", -50),
      plan("b", "2026-05-13", -50),
      plan("c", "2026-05-09", -50),
    ];
    const ranked = rankPlansForBank(bank("2026-05-10", -50), plans);
    expect(ranked.map((p) => p.itemId)).toEqual(["c", "b", "a"]);
  });

  it("ranks opposite-sign plans last so they don't drown out real candidates", () => {
    const plans = [
      plan("refund", "2026-05-10", 100), // wrong sign vs a debit
      plan("close-amount", "2026-05-12", -110),
      plan("exact-amount", "2026-05-15", -100),
    ];
    const ranked = rankPlansForBank(bank("2026-05-10", -100), plans);
    expect(ranked[0].itemId).toBe("exact-amount");
    expect(ranked[1].itemId).toBe("close-amount");
    expect(ranked[2].itemId).toBe("refund");
  });

  it("nudges label-token matches above an equal-score sibling", () => {
    // Two plans with identical amount+date distance; the one whose label
    // appears in the bank description should win the tie.
    const plans = [
      plan("a", "2026-05-12", -50, "Generic"),
      plan("b", "2026-05-12", -50, "Comcast Internet"),
    ];
    const ranked = rankPlansForBank(
      bank("2026-05-10", -50, "COMCAST CABLE BILL"),
      plans,
    );
    expect(ranked[0].itemId).toBe("b");
  });

  it("returns a stable copy when there is nothing to differentiate", () => {
    const plans = [
      plan("a", "2026-05-10", -50),
      plan("b", "2026-05-10", -50),
    ];
    const ranked = rankPlansForBank(bank("2026-05-10", -50), plans);
    expect(ranked.map((p) => p.itemId)).toEqual(["a", "b"]);
    expect(ranked).not.toBe(plans);
  });
});
