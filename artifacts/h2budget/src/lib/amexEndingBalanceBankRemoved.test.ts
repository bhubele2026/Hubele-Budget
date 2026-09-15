import { describe, it, expect } from "vitest";
import { makeAmexBalanceAtEndOf, type AmexTxnInput } from "./amexEndingBalance";
import { monthKeyFromISO } from "@/components/account-page";

// (PR-I, owner decision 14) A charge the bank removed moves no Amex balance —
// not in the anchor month, and not in the months the balance rolls through.

describe("makeAmexBalanceAtEndOf skips a row the bank removed", () => {
  const anchor = { balance: 100, asOf: "2026-09-10" };
  const kept: AmexTxnInput[] = [
    { occurredOn: "2026-09-15", amount: "20.00" },
    { occurredOn: "2026-10-02", amount: "5.00" },
  ];
  const removed: AmexTxnInput[] = [
    { occurredOn: "2026-09-16", amount: "40.00", bankRemoved: true },
    { occurredOn: "2026-10-03", amount: "7.00", bankRemoved: true },
  ];
  const sep = monthKeyFromISO("2026-09-01");
  const oct = monthKeyFromISO("2026-10-01");

  it("ends each month exactly where it would with the removed rows gone", () => {
    const withRemoved = makeAmexBalanceAtEndOf({ anchor, amexTransactions: [...kept, ...removed] });
    const withoutRemoved = makeAmexBalanceAtEndOf({ anchor, amexTransactions: kept });
    expect(withRemoved(sep)).toBeCloseTo(withoutRemoved(sep)!, 2);
    expect(withRemoved(oct)).toBeCloseTo(withoutRemoved(oct)!, 2);
    expect(withRemoved(oct)).toBeCloseTo(125, 2);
  });

  it("not vacuous: the same rows, not removed, do move it", () => {
    const counted = makeAmexBalanceAtEndOf({
      anchor,
      amexTransactions: [...kept, ...removed.map((t) => ({ ...t, bankRemoved: false }))],
    });
    expect(counted(oct)).toBeCloseTo(172, 2);
  });
});
