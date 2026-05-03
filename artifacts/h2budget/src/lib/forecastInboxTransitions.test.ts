import { describe, it, expect } from "vitest";
import {
  buildLineRegister,
  type Resolution,
  type Transaction,
} from "./forecastMatch";
import type { CashEvent } from "./forecast";

const baseOpts = {
  events: [] as CashEvent[],
  closedMonths: new Set<string>(),
  startBalance: 1000,
  fromISO: "2026-05-01",
  toISO: "2026-05-31",
  today: new Date("2026-05-15"),
};

function bankTxn(id: string, date: string, amount: string): Transaction {
  return {
    id,
    occurredOn: date,
    description: `tx-${id}`,
    amount,
    forecastFlag: true,
    plaidAccountId: "chase-acct",
  };
}

describe("Forecast inbox state transitions", () => {
  it("treats a freshly sent bank txn as pending_bank", () => {
    const txns = [bankTxn("a", "2026-05-10", "-50.00")];
    const { allBank } = buildLineRegister({
      ...baseOpts,
      txns,
      resolutions: [],
    });
    expect(allBank).toHaveLength(1);
    expect(allBank[0].status).toBe("pending_bank");
  });

  it("transitions pending_bank → matched when a resolution links it", () => {
    const txns = [bankTxn("a", "2026-05-10", "-50.00")];
    const resolutions: Resolution[] = [
      {
        id: "r1",
        recurringItemId: "rec-1",
        occurrenceDate: "2026-05-10",
        status: "matched",
        matchedTxnId: "a",
      },
    ];
    const { allBank } = buildLineRegister({ ...baseOpts, txns, resolutions });
    expect(allBank[0].status).toBe("matched");
  });

  it("transitions pending_bank → ignored_unforecasted when marked unplanned", () => {
    const txns = [bankTxn("a", "2026-05-10", "-50.00")];
    const resolutions: Resolution[] = [
      {
        id: "r1",
        recurringItemId: null,
        occurrenceDate: null,
        status: "ignored_unforecasted",
        matchedTxnId: "a",
      },
    ];
    const { allBank } = buildLineRegister({ ...baseOpts, txns, resolutions });
    expect(allBank[0].status).toBe("ignored_unforecasted");
  });

  it("running balance stays consistent across send/match transitions", () => {
    // Three bank txns; none, then one matched. Balance must be identical.
    const txns = [
      bankTxn("a", "2026-05-05", "-100.00"),
      bankTxn("b", "2026-05-10", "-25.00"),
      bankTxn("c", "2026-05-12", "1000.00"),
    ];
    const before = buildLineRegister({
      ...baseOpts,
      txns,
      resolutions: [],
    });
    const after = buildLineRegister({
      ...baseOpts,
      txns,
      resolutions: [
        {
          id: "r1",
          recurringItemId: "rec-x",
          occurrenceDate: "2026-05-05",
          status: "matched",
          matchedTxnId: "a",
        },
      ],
    });
    // Same total movement → same end balance regardless of resolution state.
    const lastBefore = before.allBank[before.allBank.length - 1];
    const lastAfter = after.allBank[after.allBank.length - 1];
    expect(lastBefore.amount).toBe(lastAfter.amount);
    // Visible rows (which feed Forecast End math) shrink when matched.
    const visibleBefore = before.rows.filter((r) => r.kind === "bank");
    const visibleAfter = after.rows.filter((r) => r.kind === "bank");
    expect(visibleBefore.length).toBe(3);
    expect(visibleAfter.length).toBe(2);
    // End-balance reconciliation: anchored running balance on the most
    // recent visible bank row must equal startBalance + sum(amounts) of
    // every bank movement that actually cleared, regardless of whether
    // any of those rows have been matched to a planned bill.
    const expectedEnd =
      baseOpts.startBalance +
      txns.reduce((s, t) => s + Number(t.amount), 0);
    const lastVisibleBefore = visibleBefore[visibleBefore.length - 1];
    expect(lastVisibleBefore.runningBalance).toBeCloseTo(expectedEnd, 2);
    // After matching one row, the projection still reflects the same
    // cleared balance — matching is bookkeeping, not a cash event.
    const allBankAfter = after.allBank;
    const sumAfter =
      baseOpts.startBalance +
      allBankAfter.reduce((s, b) => s + b.amount, 0);
    expect(sumAfter).toBeCloseTo(expectedEnd, 2);
  });
});
