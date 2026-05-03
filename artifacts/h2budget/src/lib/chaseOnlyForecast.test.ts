import { describe, it, expect } from "vitest";
import {
  buildLineRegister,
  filterForecastTxns,
  type Transaction,
} from "./forecastMatch";
import type { CashEvent } from "./forecast";

// Exercises the shared `filterForecastTxns` helper used by the Forecast
// page (artifacts/h2budget/src/pages/forecast.tsx) before it hands txns to
// `buildLineRegister`. These tests pin the rule that ONLY the configured
// Chase checking account's transactions can ever reach inbox / register /
// running balance, regardless of forecastFlag. A future refactor of
// buildLineRegister or the page memo must not silently let Amex / other
// depository accounts back in.

const CHASE_ACCT = "chase-checking-acct-id";
const AMEX_ACCT = "amex-card-acct-id";

const baseOpts = {
  events: [] as CashEvent[],
  closedMonths: new Set<string>(),
  startBalance: 1000,
  fromISO: "2026-05-01",
  toISO: "2026-05-31",
  today: new Date("2026-05-15"),
};

function txn(
  id: string,
  date: string,
  amount: string,
  opts: {
    forecastFlag?: boolean;
    plaidAccountId?: string | null;
    source?: string;
  } = {},
): Transaction {
  return {
    id,
    occurredOn: date,
    description: `tx-${id}`,
    amount,
    forecastFlag: opts.forecastFlag ?? true,
    plaidAccountId: opts.plaidAccountId ?? null,
    source: opts.source,
  };
}

describe("Forecast Chase-only filter", () => {
  const checking = new Set<string>([CHASE_ACCT]);

  it("excludes a non-checking (Amex) txn even when forecastFlag = true", () => {
    const all = [
      txn("amex-1", "2026-05-10", "-50.00", {
        forecastFlag: true,
        plaidAccountId: AMEX_ACCT,
        source: "plaid:amex",
      }),
    ];
    const filtered = filterForecastTxns(all, checking);
    expect(filtered).toHaveLength(0);

    const { rows, allBank } = buildLineRegister({
      ...baseOpts,
      txns: filtered,
      resolutions: [],
    });
    expect(allBank).toHaveLength(0);
    expect(rows.filter((r) => r.kind === "bank")).toHaveLength(0);
  });

  it("includes a Chase checking txn with forecastFlag = true", () => {
    const all = [
      txn("chase-1", "2026-05-10", "-75.00", {
        forecastFlag: true,
        plaidAccountId: CHASE_ACCT,
        source: "plaid:chase",
      }),
    ];
    const filtered = filterForecastTxns(all, checking);
    expect(filtered.map((t) => t.id)).toEqual(["chase-1"]);

    const { rows, allBank } = buildLineRegister({
      ...baseOpts,
      txns: filtered,
      resolutions: [],
    });
    expect(allBank).toHaveLength(1);
    expect(allBank[0].txn.id).toBe("chase-1");
    expect(allBank[0].status).toBe("pending_bank");

    const visibleBank = rows.filter((r) => r.kind === "bank");
    expect(visibleBank).toHaveLength(1);
    // Running balance reflects only the Chase row.
    expect(visibleBank[0].runningBalance).toBeCloseTo(1000 - 75, 2);
  });

  it("excludes Amex and includes Chase when both are present", () => {
    const all = [
      txn("amex-1", "2026-05-08", "-200.00", {
        forecastFlag: true,
        plaidAccountId: AMEX_ACCT,
        source: "plaid:amex",
      }),
      txn("chase-1", "2026-05-10", "-75.00", {
        forecastFlag: true,
        plaidAccountId: CHASE_ACCT,
        source: "plaid:chase",
      }),
      txn("chase-2", "2026-05-12", "500.00", {
        forecastFlag: true,
        plaidAccountId: CHASE_ACCT,
        source: "plaid:chase",
      }),
    ];
    const filtered = filterForecastTxns(all, checking);
    expect(filtered.map((t) => t.id).sort()).toEqual(["chase-1", "chase-2"]);

    const { rows, allBank } = buildLineRegister({
      ...baseOpts,
      txns: filtered,
      resolutions: [],
    });
    // Amex never reaches the register.
    expect(allBank.map((b) => b.txn.id).sort()).toEqual(["chase-1", "chase-2"]);

    const visibleBank = rows.filter((r) => r.kind === "bank");
    expect(visibleBank.map((r) => (r as { txn: Transaction }).txn.id)).toEqual([
      "chase-1",
      "chase-2",
    ]);
    // Running balance excludes Amex movement entirely.
    const last = visibleBank[visibleBank.length - 1];
    expect(last.runningBalance).toBeCloseTo(1000 - 75 + 500, 2);
  });

  it("excludes a non-checking depository txn whose accountId is not the configured Chase one", () => {
    const all = [
      txn("other-checking", "2026-05-10", "-40.00", {
        forecastFlag: true,
        plaidAccountId: "some-other-depository-acct",
        source: "plaid:chase",
      }),
    ];
    const filtered = filterForecastTxns(all, checking);
    expect(filtered).toHaveLength(0);

    const { allBank } = buildLineRegister({
      ...baseOpts,
      txns: filtered,
      resolutions: [],
    });
    expect(allBank).toHaveLength(0);
  });

  it("inbox-style pending list excludes Amex even with forecastFlag = true", () => {
    const all = [
      txn("amex-pending", "2026-05-09", "-30.00", {
        forecastFlag: true,
        plaidAccountId: AMEX_ACCT,
        source: "plaid:amex",
      }),
      txn("chase-pending", "2026-05-11", "-22.00", {
        forecastFlag: true,
        plaidAccountId: CHASE_ACCT,
        source: "plaid:chase",
      }),
    ];
    const filtered = filterForecastTxns(all, checking);
    const { allBank } = buildLineRegister({
      ...baseOpts,
      txns: filtered,
      resolutions: [],
    });
    const inbox = allBank
      .filter((b) => b.status === "pending_bank")
      .map((b) => b.txn.id);
    expect(inbox).toEqual(["chase-pending"]);
  });
});
