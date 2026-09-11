import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  getGetSpineQueryKey,
  getGetForecastBankBalanceExplainQueryKey,
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

function seeded() {
  const qc = new QueryClient();
  for (const key of [SPINE, EXPLAIN, REPORTS, UNRELATED]) qc.setQueryData(key, { seeded: true });
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

  it("leaves unrelated queries alone", () => {
    const qc = seeded();
    invalidateAfterWrite(qc);
    expect(invalidated(qc, UNRELATED)).toBe(false);
  });
});
