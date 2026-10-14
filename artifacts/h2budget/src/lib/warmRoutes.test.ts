import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";

/**
 * (P4) Each section warms ITS real first queries, under the page's own keys.
 * The pages build their requests with the same exported builders `warmRoute`
 * calls, so these tests pin: the warmed key IS the builder's key, the stale
 * warms are gone, and a press (pointer-down / touch-start) warms like a hover.
 */
const pre = vi.hoisted(() => ({ chunks: [] as string[] }));
vi.mock("./routePrefetch", () => ({ prefetchRoute: (h: string) => pre.chunks.push(h) }));

import { getGetBankingReviewQueryKey } from "@workspace/api-client-react/features";
import { getGetPeriodBreakdownQueryKey, getGetAmexSummaryQueryKey } from "@workspace/api-client-react/features";
import { getGetTransactionsLedgerInfiniteQueryKey } from "@workspace/api-client-react/ledger";
import {
  getGetAvalancheExtraQueryKey,
  getGetAvalancheSettingsQueryKey,
  getGetForecastCashSignalQueryKey,
  getGetForecastQueryKey,
  getListDebtsQueryKey,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { warmHandlers, warmRoute } from "./warmRoutes";
import { bankingDefaultSummaryParams } from "@/pages/banking/reviewParams";
import { amexFirstParams } from "@/pages/amexQueries";
import { chaseFirstFilter } from "@/pages/transactions/warm";
import { toLedgerParams } from "@/pages/transactions/chaseLedger";
import { currentPeriodParams } from "@/pages/spending/periodParams";

// Wed 14 Oct 2026, noon in Chicago.
const NOW = new Date("2026-10-14T17:00:00Z");

let qc: QueryClient;
let keys: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  pre.chunks.length = 0;
  qc = new QueryClient();
  keys = [];
  const record = (o: { queryKey: unknown }) => {
    keys.push(JSON.stringify(o.queryKey));
    return Promise.resolve();
  };
  vi.spyOn(qc, "prefetchQuery").mockImplementation(record as never);
  vi.spyOn(qc, "prefetchInfiniteQuery").mockImplementation(record as never);
});
afterEach(() => vi.useRealTimers());

const has = (k: unknown) => keys.includes(JSON.stringify(k));
const settle = () => vi.waitFor(() => expect(keys.length).toBeGreaterThan(0));

describe("warmRoute — each section warms its real first queries", () => {
  it("Banking: the review's first call (summary + first pages) and the Plaid items", async () => {
    warmRoute(qc, "/banking");
    await vi.waitFor(() => expect(keys.length).toBe(2));
    expect(has(getGetBankingReviewQueryKey(bankingDefaultSummaryParams(NOW)))).toBe(true);
    expect(has(getListPlaidItemsQueryKey())).toBe(true);
  });

  it("Banking from a tile that names its account warms that account's review", async () => {
    warmRoute(qc, "/banking?account=c1");
    await vi.waitFor(() => expect(keys.length).toBe(2));
    expect(has(getGetBankingReviewQueryKey(bankingDefaultSummaryParams(NOW, "c1")))).toBe(true);
  });

  it("Chase register: the first ledger page", async () => {
    warmRoute(qc, "/transactions");
    await settle();
    const filter = chaseFirstFilter(NOW, false)!;
    expect(has(getGetTransactionsLedgerInfiniteQueryKey(toLedgerParams(filter)))).toBe(true);
    // The first page is 50 rows, never a 1,000-row three-year read.
    expect(keys.some((k) => k.includes('"limit":1000'))).toBe(false);
  });

  it("Amex: the all-cards summary and the month's rows", async () => {
    warmRoute(qc, "/amex");
    await vi.waitFor(() => expect(keys.length).toBe(2));
    const first = amexFirstParams(NOW);
    expect(has(getGetAmexSummaryQueryKey(first.summary))).toBe(true);
    expect(has(getListTransactionsQueryKey(first.month))).toBe(true);
    expect(first.summary.accountId).toBe("all");
  });

  it("Spending: the current week's and month's period breakdown", async () => {
    warmRoute(qc, "/spending/week");
    await vi.waitFor(() => expect(keys.length).toBe(2));
    expect(has(getGetPeriodBreakdownQueryKey(currentPeriodParams("week", NOW)))).toBe(true);
    keys.length = 0;
    warmRoute(qc, "/spending/month");
    await vi.waitFor(() => expect(keys.length).toBe(2));
    expect(has(getGetPeriodBreakdownQueryKey(currentPeriodParams("month", NOW)))).toBe(true);
    expect(currentPeriodParams("week", NOW).start).toBe("2026-10-11");
    expect(currentPeriodParams("month", NOW).start).toBe("2026-10-01");
  });

  it("Forecast: forecast 90 and cash-signal 90", () => {
    warmRoute(qc, "/forecast/overview");
    expect(has(getGetForecastQueryKey({ days: 90 }))).toBe(true);
    expect(has(getGetForecastCashSignalQueryKey({ horizonDays: 90 }))).toBe(true);
  });

  it("Debt: the debts and the avalanche inputs", () => {
    warmRoute(qc, "/avalanche");
    expect(has(getListDebtsQueryKey())).toBe(true);
    expect(has(getGetAvalancheSettingsQueryKey())).toBe(true);
    expect(has(getGetAvalancheExtraQueryKey())).toBe(true);
  });

  it("the stale warms are gone: no /api/dashboard, no 1,000-row 3-year ledger", async () => {
    for (const href of ["/banking", "/transactions", "/amex", "/forecast", "/avalanche", "/home"]) warmRoute(qc, href);
    await new Promise((r) => setTimeout(r, 0));
    expect(keys.some((k) => k.includes("/api/dashboard"))).toBe(false);
    expect(keys.some((k) => k.includes('"limit":1000') && k.includes('"from":"2024'))).toBe(false);
  });

  it("a link that names a card or a month does not guess the view", () => {
    warmRoute(qc, "/amex?card=ext-1");
    expect(keys).toEqual([]);
    expect(pre.chunks).toContain("/amex");
  });

  it("hover, focus, pointer-down and touch-start all warm", () => {
    const warm = vi.fn();
    const p = warmHandlers(warm, "/amex");
    p.onMouseEnter();
    p.onFocus();
    p.onPointerDown();
    p.onTouchStart();
    expect(warm).toHaveBeenCalledTimes(4);
    expect(warm).toHaveBeenCalledWith("/amex");
  });
});
