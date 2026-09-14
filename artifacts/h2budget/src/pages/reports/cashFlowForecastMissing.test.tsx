import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * (Owner decision 16) Reports → Cash flow, the forecast-balance card.
 *
 * The card used to roll its own balance forward from
 * `forecast.settings.startingBalance` + `forecast.events` — a different
 * (unanchored) number than the bank-snapshot-anchored curve the Forecast
 * page and the spine show, and one that could disagree with it for the same
 * date. It now reads the SAME signal the Forecast page reads
 * (`GET /forecast/cash-signal`, i.e. `computeCashSignal().daily[]`) at the
 * same 90-day horizon, and is titled from the same bank snapshot
 * (`forecast.bankSnapshot.name`/`.mask`) rather than a figure it built
 * itself.
 */

const q = vi.hoisted(() => ({
  forecast: undefined as unknown,
  cashSignal: undefined as unknown,
  cashSignalFetching: false,
  cashSignalLoadingError: false,
  cashSignalRefetchError: false,
  cashSignalPlaceholder: false,
  cashSignalUpdatedAt: 0,
  refetch: vi.fn(),
}));

vi.mock("wouter", () => ({
  Link: ({
    children,
    href,
    ...rest
  }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({
    data: undefined,
    state: "cold",
    isLoading: false,
    updatedAt: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListTransactions: () => ({ data: [], isLoading: false }),
  useListCategories: () => ({ data: [] }),
  useListRecurringItems: () => ({ data: [] }),
  useGetForecast: () => ({ data: q.forecast }),
  useGetForecastCashSignal: () => ({
    data: q.cashSignal,
    isFetching: q.cashSignalFetching,
    isLoadingError: q.cashSignalLoadingError,
    isRefetchError: q.cashSignalRefetchError,
    isPlaceholderData: q.cashSignalPlaceholder,
    dataUpdatedAt: q.cashSignalUpdatedAt,
    refetch: q.refetch,
  }),
  useGetDashboard: () => ({ data: undefined }),
  useListDebts: () => ({ data: [] }),
  useListPlaidLiabilityAccounts: () => ({ data: [] }),
}));

import CashFlowPage, {
  cashFlowForecastSeries,
  cashFlowCardTitle,
} from "./CashFlowPage";

/** `daily[0..n]` — `n + 1` points, matching `computeCashSignal`'s inclusive window. */
function buildDaily(n: number, start = 1000): Array<{ date: string; balance: string }> {
  const out: Array<{ date: string; balance: string }> = [];
  for (let i = 0; i <= n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    out.push({ date: d.toISOString().slice(0, 10), balance: (start + i * 10).toFixed(2) });
  }
  return out;
}

function forecastCard(): HTMLElement | null {
  return document.querySelector("[data-testid='cashflow-forecast-card']");
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CashFlowPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  q.forecast = undefined;
  q.cashSignal = undefined;
  q.cashSignalFetching = false;
  q.cashSignalLoadingError = false;
  q.cashSignalRefetchError = false;
  q.cashSignalPlaceholder = false;
  q.cashSignalUpdatedAt = 0;
  q.refetch = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("cashFlowForecastSeries — the card's series is the cash signal's daily[], untouched", () => {
  it("first and last points equal daily[0] and daily[90]", () => {
    const daily = buildDaily(90, 5000);
    const series = cashFlowForecastSeries(daily);
    expect(series).toHaveLength(91);
    expect(series[0]).toEqual({ date: daily[0].date, balance: Number(daily[0].balance) });
    expect(series[90]).toEqual({ date: daily[90].date, balance: Number(daily[90].balance) });
  });

  it("returns nothing for a missing daily series, never a fabricated curve", () => {
    expect(cashFlowForecastSeries(undefined)).toEqual([]);
    expect(cashFlowForecastSeries(null)).toEqual([]);
  });
});

describe("cashFlowCardTitle — names the scope from the bank snapshot, never settings.startingBalance", () => {
  it('names the account and mask, e.g. "Chase ••1234 checking"', () => {
    expect(cashFlowCardTitle({ name: "Chase", mask: "1234" }, 90)).toBe(
      "Chase ••1234 checking · next 90 days",
    );
  });

  it("doesn't double the word 'checking' when the account's own name already says it", () => {
    expect(
      cashFlowCardTitle({ name: "Chase Total Checking", mask: "1234" }, 90),
    ).toBe("Chase Total Checking ••1234 · next 90 days");
  });

  it("says plainly when no bank snapshot has ever been set", () => {
    expect(cashFlowCardTitle(null, 90)).toBe("Checking (no bank balance set)");
  });

  it("shows a neutral placeholder — never 'no bank balance set' — while the bundle is still loading", () => {
    expect(cashFlowCardTitle(undefined, 90)).toBe("Checking · next 90 days");
  });
});

describe("Cash flow — the forecast-balance card (owner decision 16)", () => {
  it("titles itself from the bank snapshot and draws the cash-signal curve", () => {
    const daily = buildDaily(90, 5000);
    q.forecast = {
      bankSnapshot: {
        name: "Chase",
        mask: "1234",
        balance: "5000.00",
        at: "2026-01-01T00:00:00.000Z",
        source: "plaid",
      },
    };
    q.cashSignal = {
      bankToday: "5000.00",
      status: "ready",
      daily,
      cashBuffer: "500.00",
      lowestProjected: "4000.00",
      lowestDate: null,
      maxSafeExtra: "0.00",
    };
    renderPage();
    const card = forecastCard();
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Chase ••1234 checking · next 90 days");
  });

  it("says 'no bank balance set' with no snapshot — never a startingBalance figure, never $0", () => {
    q.forecast = { bankSnapshot: null };
    q.cashSignal = {
      bankToday: "0.00",
      status: "no_data",
      daily: [],
      cashBuffer: "0.00",
      lowestProjected: "0.00",
      lowestDate: null,
      maxSafeExtra: "0.00",
    };
    renderPage();
    const card = forecastCard();
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Checking (no bank balance set)");
    expect(card!.textContent).not.toContain("$0");
  });

  it("shows no $0 while still loading (cold)", () => {
    // q.cashSignal stays undefined → dataState() === "cold"
    renderPage();
    const card = forecastCard();
    expect(card).not.toBeNull();
    expect(card!.textContent).not.toContain("$0");
    expect(card!.querySelector("[data-testid='cashflow-forecast-loading']")).not.toBeNull();
  });

  it("shows a retry banner and no $0 when the first load fails outright", () => {
    q.cashSignalLoadingError = true;
    renderPage();
    const card = forecastCard();
    expect(card).not.toBeNull();
    expect(card!.textContent).not.toContain("$0");
    expect(card!.textContent).toContain("Couldn't load these numbers.");
    expect(
      card!.querySelector("[data-testid='cashflow-forecast-refresh-banner']"),
    ).not.toBeNull();
  });

  it("keeps showing the last good curve, with a refresh banner, when a later refetch fails", () => {
    const daily = buildDaily(90, 5000);
    q.forecast = { bankSnapshot: { name: "Chase", mask: "1234", balance: "5000.00", at: "2026-01-01T00:00:00.000Z", source: "plaid" } };
    q.cashSignal = {
      bankToday: "5000.00",
      status: "ready",
      daily,
      cashBuffer: "500.00",
      lowestProjected: "4000.00",
      lowestDate: null,
      maxSafeExtra: "0.00",
    };
    q.cashSignalRefetchError = true;
    q.cashSignalUpdatedAt = Date.now();
    renderPage();
    const card = forecastCard();
    expect(card).not.toBeNull();
    expect(
      card!.querySelector("[data-testid='cashflow-forecast-refresh-banner']"),
    ).not.toBeNull();
    expect(card!.textContent).toContain("Chase ••1234 checking · next 90 days");
  });
});

/** Comments may still explain, in prose, why the code doesn't read the field
 * anymore — only the CODE itself must never reference it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the card no longer reads settings.startingBalance", () => {
  it("the source never derives the forecast card's balance from settings.startingBalance", () => {
    // Runs from the package dir under vitest, from the repo root under some IDEs.
    const path = [
      resolve(process.cwd(), "src/pages/reports/CashFlowPage.tsx"),
      resolve(process.cwd(), "artifacts/h2budget/src/pages/reports/CashFlowPage.tsx"),
    ].find(existsSync);
    expect(path).toBeTruthy();
    const src = readFileSync(path!, "utf8");
    expect(stripComments(src)).not.toMatch(/startingBalance/);
  });
});
