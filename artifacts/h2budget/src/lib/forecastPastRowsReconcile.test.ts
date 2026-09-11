import { describe, it, expect } from "vitest";
import {
  buildLineRegister,
  filterForecastTxns,
  type Transaction,
} from "./forecastMatch";
import { computeBankReconcile } from "./forecastReconcile";
import type { CashEvent } from "./forecast";

// The Review page's "Starting balance vs bank snapshot" check after
// `inForecast` (2026-09-10).
//
// A posted checking row whose forecast flag is off — a transfer to savings
// is the everyday case: Plaid sync keeps a user-flagged transfer's flag off —
// now reaches the register. That is deliberate: the money left checking, and
// the bank snapshot already reflects it. These tests pin what that does to the
// reconcile numbers so the change is visible rather than incidental.

const TODAY = "2026-05-15";
const NO_PLAID_ACCOUNTS = new Set<string>();

function tx(
  id: string,
  occurredOn: string,
  amount: string,
  extra: Partial<Transaction> = {},
): Transaction {
  return {
    id,
    occurredOn,
    description: id,
    amount,
    forecastFlag: true,
    source: "manual",
    ...extra,
  };
}

// $1,000 at the start of May; $200 of groceries and a $300 transfer to
// savings before the snapshot; the bank says $500 on the 15th.
const purchase = tx("groceries", "2026-05-05", "-200.00");
const transferToSavings = tx("to-savings", "2026-05-08", "-300.00", {
  forecastFlag: false,
  isTransfer: true,
});

function reconcile(registerTxns: Transaction[]) {
  const register = buildLineRegister({
    events: [] as CashEvent[],
    txns: registerTxns,
    resolutions: [],
    closedMonths: new Set<string>(),
    startBalance: 500,
    fromISO: "2026-05-01",
    toISO: "2026-05-31",
    today: new Date("2026-05-15"),
  });
  return computeBankReconcile({
    allBank: register.allBank,
    allPlan: register.allPlan,
    bankSnapshot: { at: "2026-05-15T12:00:00.000Z", balance: 500 },
    settingsStartingBalance: 1000,
    fromDate: "2026-05-01",
    monthFilter: "2026-05",
    checkingPlaidAccountIds: NO_PLAID_ACCOUNTS,
  });
}

describe("reconcile with posted flag-off rows in the register", () => {
  it("counts a posted transfer whose flag is off: it is pending review and the starting balance ties to the bank", () => {
    const included = filterForecastTxns(
      [purchase, transferToSavings],
      NO_PLAID_ACCOUNTS,
      TODAY,
    );
    expect(included.map((t) => t.id)).toEqual(["groceries", "to-savings"]);

    const r = reconcile(included);
    expect(r.pending).toBe(2);
    // $1,000 − $200 − $300 = $500 = the bank snapshot.
    expect(r.startingBalanceDelta).toBe(0);
    expect(r.gap).toBe(0);
  });

  it("the old flag-only register left the transfer out and reported it as a $300 gap", () => {
    const flagOnly = [purchase, transferToSavings].filter((t) => t.forecastFlag);

    const r = reconcile(flagOnly);
    expect(r.pending).toBe(1);
    expect(r.startingBalanceDelta).toBe(300);
    expect(r.gap).toBe(300);
  });
});
