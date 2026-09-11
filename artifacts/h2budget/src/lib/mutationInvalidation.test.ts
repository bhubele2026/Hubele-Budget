import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  getGetSpineQueryKey,
  getGetForecastBankBalanceExplainQueryKey,
  getGetTransactionsBalancesQueryKey,
  getGetTransactionsLedgerInfiniteQueryKey,
} from "@workspace/api-client-react";
import { invalidateAfterWrite } from "./mutationInvalidation";

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
