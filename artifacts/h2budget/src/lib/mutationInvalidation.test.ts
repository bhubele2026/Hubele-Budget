import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  getGetSpineQueryKey,
  getGetForecastBankBalanceExplainQueryKey,
} from "@workspace/api-client-react";
import {
  getGetTransactionsBalancesQueryKey,
  getGetTransactionsLedgerInfiniteQueryKey,
} from "@workspace/api-client-react/ledger";
import {
  OWN_INVALIDATION,
  invalidateAfterWrite,
  invalidateBankLedgerLists,
  onWriteSuccess,
  shouldInvalidateAfterWrite,
} from "./mutationInvalidation";

/**
 * The rule `App.tsx`'s `mutationCache` applies after every successful write.
 * Each key it must mark stale is pinned here, so dropping one fails a test.
 */

const SPINE = getGetSpineQueryKey();
const EXPLAIN = getGetForecastBankBalanceExplainQueryKey();
const REPORTS = ["/api/reports/spending-facts", { from: "2026-09-01", to: "2026-09-30" }];
const UNRELATED = ["/api/debts"];
// (PR14) The Chase list's pages and the balances behind its charts.
const LEDGER_PAGES = getGetTransactionsLedgerInfiniteQueryKey({ from: "2026-09-06", to: "2026-09-11", limit: 50 });
const LEDGER_BALANCES = getGetTransactionsBalancesQueryKey({ dates: "2026-09-05,2026-09-11" });

function seeded() {
  const qc = new QueryClient();
  for (const key of [SPINE, EXPLAIN, REPORTS, UNRELATED, LEDGER_PAGES, LEDGER_BALANCES]) {
    qc.setQueryData(key, { seeded: true });
  }
  return qc;
}

const invalidated = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryState(key)?.isInvalidated ?? false;

describe("invalidateAfterWrite", () => {
  it("marks the spine stale", () => {
    const qc = seeded();
    invalidateAfterWrite(qc);
    expect(invalidated(qc, SPINE)).toBe(true);
  });

  it("marks 'Why this number?' stale, so it is never older than the tile", () => {
    const qc = seeded();
    invalidateAfterWrite(qc);
    expect(invalidated(qc, EXPLAIN)).toBe(true);
  });

  it("marks every /api/reports/ aggregate stale", () => {
    const qc = seeded();
    invalidateAfterWrite(qc);
    expect(invalidated(qc, REPORTS)).toBe(true);
  });

  it("(PR14) marks the Chase ledger's pages and balances stale: review counts and balances move with any write", () => {
    const qc = seeded();
    invalidateAfterWrite(qc);
    expect(invalidated(qc, LEDGER_PAGES)).toBe(true);
    expect(invalidated(qc, LEDGER_BALANCES)).toBe(true);
  });

  it("leaves unrelated queries alone", () => {
    const qc = seeded();
    invalidateAfterWrite(qc);
    expect(invalidated(qc, UNRELATED)).toBe(false);
  });
});

describe("(PR14 review M3) writes that invalidate what they move themselves", () => {
  it("OWN_INVALIDATION opts a write out of the rule; any other write runs it", () => {
    expect(shouldInvalidateAfterWrite(undefined)).toBe(true);
    expect(shouldInvalidateAfterWrite({})).toBe(true);
    expect(shouldInvalidateAfterWrite(OWN_INVALIDATION)).toBe(false);
    const skipped = seeded();
    onWriteSuccess(skipped, { meta: OWN_INVALIDATION });
    for (const key of [SPINE, EXPLAIN, REPORTS, LEDGER_PAGES, LEDGER_BALANCES]) {
      expect(invalidated(skipped, key)).toBe(false);
    }
    const ran = seeded();
    onWriteSuccess(ran, {});
    expect(invalidated(ran, SPINE)).toBe(true);
    expect(invalidated(ran, LEDGER_PAGES)).toBe(true);
  });

  it("a review refreshes the Chase list pages only: not balances, the spine or reports", () => {
    const qc = seeded();
    void invalidateBankLedgerLists(qc);
    expect(invalidated(qc, LEDGER_PAGES)).toBe(true);
    for (const key of [LEDGER_BALANCES, SPINE, EXPLAIN, REPORTS, UNRELATED]) {
      expect(invalidated(qc, key)).toBe(false);
    }
  });
});
