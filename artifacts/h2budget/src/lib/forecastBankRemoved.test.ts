import { describe, it, expect } from "vitest";
import {
  buildBucket,
  buildLineRegister,
  monthKey,
  type Resolution,
  type Transaction,
} from "./forecastMatch";
import type { CashEvent } from "./forecast";

// (PR-I, owner decision 14) The server leaves bank-removed markers out of the
// /forecast bundle, and the web register ignores one all the same: a marker
// decides no row, never hides a real decision and adds no bucket entry.

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

const marker = (txnId: string): Resolution => ({
  id: `marker-${txnId}`,
  recurringItemId: null,
  occurrenceDate: null,
  status: "bank_removed",
  matchedTxnId: txnId,
});

describe("(PR-I) a bank-removed marker in the web register", () => {
  it("decides nothing about its row", () => {
    const { allBank } = buildLineRegister({
      ...baseOpts,
      txns: [bankTxn("a", "2026-05-10", "-50.00")],
      resolutions: [marker("a")],
    });
    expect(allBank[0]).toMatchObject({ status: "pending_bank" });
    expect(allBank[0]!.resolutionId).toBeUndefined();
    expect(allBank[0]!.resolutionStatus).toBeUndefined();
  });

  it("never hides the row's real match, in either order", () => {
    const matched: Resolution = {
      id: "r1",
      recurringItemId: "rec-1",
      occurrenceDate: "2026-05-10",
      status: "matched",
      matchedTxnId: "a",
    };
    for (const resolutions of [
      [matched, marker("a")],
      [marker("a"), matched],
    ]) {
      const { allBank } = buildLineRegister({
        ...baseOpts,
        txns: [bankTxn("a", "2026-05-10", "-50.00")],
        resolutions,
      });
      expect(allBank[0]).toMatchObject({ status: "matched", resolutionId: "r1" });
    }
  });

  it("adds no bucket entry", () => {
    const txns = [bankTxn("a", "2026-05-10", "-50.00")];
    const resolutions = [marker("a")];
    const { allPlan, allBank } = buildLineRegister({ ...baseOpts, txns, resolutions });
    expect(
      buildBucket({
        allPlan,
        allBank,
        resolutions,
        closedMonths: new Set(),
        monthFilter: monthKey("2026-05-10"),
      }),
    ).toEqual([]);
  });
});
