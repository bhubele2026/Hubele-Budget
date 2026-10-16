import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { MONEY_RETURN_MS, isMoneyKey, useRefetchMoneyOnReturn } from "./useRefetchMoneyOnReturn";

/**
 * (T1, H9) A balance update in another tab: back on this one, the money reads
 * older than a minute are asked again; a quick switch costs nothing. Synthetic.
 */
const SPINE = ["/api/spine"];
const BUNDLE = ["/api/forecast", { days: 90 }];
const SIGNAL = ["/api/forecast/cash-signal", { horizonDays: 30 }];
const REVIEW = ["/api/banking/review", { from: "2026-10-01", to: "2026-10-15" }];
const BALANCES = ["/api/transactions/balances", { dates: "2026-10-15" }];
const LEDGER_LIST = ["infinite", "/api/transactions/ledger", { limit: 50 }];
const UNRELATED = ["/api/debts"];

function Mount() {
  useRefetchMoneyOnReturn();
  return null;
}

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const k of [SPINE, BUNDLE, SIGNAL, REVIEW, BALANCES, LEDGER_LIST, UNRELATED]) qc.setQueryData(k, { seeded: true });
  render(
    <QueryClientProvider client={qc}>
      <Mount />
    </QueryClientProvider>,
  );
  return qc;
}
const stale = (qc: QueryClient, k: readonly unknown[]) => qc.getQueryState(k)?.isInvalidated ?? false;
const returnToTab = () =>
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T14:00:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useRefetchMoneyOnReturn", () => {
  it("the money keys: spine, the forecast family, the banking review, the register's balances — not its list pages", () => {
    for (const k of [SPINE, BUNDLE, SIGNAL, REVIEW, BALANCES]) expect(isMoneyKey(k)).toBe(true);
    for (const k of [LEDGER_LIST, UNRELATED, ["/api/transactions", {}]]) expect(isMoneyKey(k)).toBe(false);
  });

  it("⭐ back after more than a minute: the money reads are marked stale (and refetched when on screen)", () => {
    const qc = seeded();
    vi.setSystemTime(new Date(Date.now() + MONEY_RETURN_MS + 1_000));
    returnToTab();
    for (const k of [SPINE, BUNDLE, SIGNAL, REVIEW, BALANCES]) expect(stale(qc, k)).toBe(true);
    expect(stale(qc, LEDGER_LIST)).toBe(false);
    expect(stale(qc, UNRELATED)).toBe(false);
  });

  it("a quick switch (10 s) costs nothing", () => {
    const qc = seeded();
    vi.setSystemTime(new Date(Date.now() + 10_000));
    returnToTab();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    for (const k of [SPINE, BUNDLE, SIGNAL, REVIEW, BALANCES]) expect(stale(qc, k)).toBe(false);
  });

  it("window focus works the same way", () => {
    const qc = seeded();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(stale(qc, SPINE)).toBe(true);
  });
});
