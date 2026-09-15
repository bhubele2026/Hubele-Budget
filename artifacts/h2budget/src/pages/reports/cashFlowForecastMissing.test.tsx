import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * (Owner decision 16) Reports → Cash flow, the forecast-balance card.
 *
 * The card used to roll its own balance forward from the settings row's
 * starting balance plus `forecast.events`. That was a different, unanchored
 * number from the bank-snapshot-anchored curve the Forecast page and the spine
 * show, and it could disagree with them for the same date. The card now reads
 * the SAME signal (`GET /forecast/cash-signal`, i.e.
 * `computeCashSignal().daily[]`) under the SAME query key as Forecast Overview,
 * the prefetch and the Forecast page's 90-day tab. It titles itself from that
 * response's own `account` (PR-K round 2).
 *
 * All names, masks and amounts here are synthetic.
 */

const q = vi.hoisted(() => ({
  cashSignal: undefined as unknown,
  cashSignalFetching: false,
  cashSignalLoadingError: false,
  cashSignalRefetchError: false,
  cashSignalPlaceholder: false,
  cashSignalUpdatedAt: 0,
  /** Every params object the page passed to `useGetForecastCashSignal`. */
  cashSignalParams: [] as unknown[],
  /** How many times the page asked for the `/forecast` bundle. */
  forecastBundleCalls: 0,
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
  useGetForecast: () => {
    q.forecastBundleCalls += 1;
    return { data: undefined };
  },
  useGetForecastCashSignal: (params: unknown) => {
    q.cashSignalParams.push(params);
    return {
      data: q.cashSignal,
      isFetching: q.cashSignalFetching,
      isLoadingError: q.cashSignalLoadingError,
      isRefetchError: q.cashSignalRefetchError,
      isPlaceholderData: q.cashSignalPlaceholder,
      dataUpdatedAt: q.cashSignalUpdatedAt,
      refetch: q.refetch,
    };
  },
  useGetDashboard: () => ({ data: undefined }),
  useListDebts: () => ({ data: [] }),
  useListPlaidLiabilityAccounts: () => ({ data: [] }),
}));

import CashFlowPage, {
  cashFlowForecastSeries,
  cashFlowCardTitle,
} from "./CashFlowPage";

const HORIZON = 90;
const EMPTY_TEXT = "Set a bank balance on Forecast to draw this chart";
const CHECKING = {
  name: "Test Bank",
  mask: "0001",
  subtype: "checking",
  via: "pointer",
} as const;

/** `daily[0..n]`: `n + 1` points, matching `computeCashSignal`'s inclusive window. */
function buildDaily(n: number, start = 1000): Array<{ date: string; balance: string }> {
  const out: Array<{ date: string; balance: string }> = [];
  for (let i = 0; i <= n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    out.push({ date: d.toISOString().slice(0, 10), balance: (start + i * 10).toFixed(2) });
  }
  return out;
}

function readySignal(over: Record<string, unknown> = {}) {
  return {
    bankToday: "5000.00",
    lowestProjected: "5000.00",
    lowestDate: null,
    cashBuffer: "500.00",
    status: "ready",
    maxSafeExtra: "4500.00",
    snapshotAt: "2026-01-01T00:00:00.000Z",
    snapshotSource: "plaid",
    account: CHECKING,
    daily: buildDaily(HORIZON, 5000),
    ...over,
  };
}

/**
 * What the server really sends without a bank snapshot: `no_data`, and still a
 * FULL 91-point curve rolled forward from an implicit $0. An empty `daily`
 * would never exercise the gate that keeps this curve off the card.
 */
function noDataSignal(over: Record<string, unknown> = {}) {
  return readySignal({
    bankToday: "0.00",
    lowestProjected: "0.00",
    status: "no_data",
    maxSafeExtra: "0.00",
    snapshotAt: null,
    snapshotSource: null,
    account: { name: null, mask: null, subtype: null, via: "unresolved" },
    daily: buildDaily(HORIZON, 0),
    ...over,
  });
}

function forecastCard(): HTMLElement {
  const card = document.querySelector<HTMLElement>("[data-testid='cashflow-forecast-card']");
  if (!card) throw new Error("the forecast card did not render");
  return card;
}

/** Recharts' own wrapper: present exactly when the card renders its chart. */
function chartIn(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>(".recharts-responsive-container");
}

function bannerIn(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>("[data-testid='cashflow-forecast-refresh-banner']");
}

/** The kit head's title: the card's first span. */
function titleOf(card: HTMLElement): string {
  return card.querySelector("span")?.textContent ?? "";
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
  q.cashSignal = undefined;
  q.cashSignalFetching = false;
  q.cashSignalLoadingError = false;
  q.cashSignalRefetchError = false;
  q.cashSignalPlaceholder = false;
  q.cashSignalUpdatedAt = 0;
  q.cashSignalParams = [];
  q.forecastBundleCalls = 0;
  q.refetch = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("cashFlowForecastSeries — the card's series is the cash signal's daily[], untouched", () => {
  it("first and last points equal daily[0] and daily[90]", () => {
    const daily = buildDaily(HORIZON, 5000);
    const series = cashFlowForecastSeries(daily);
    expect(series).toHaveLength(91);
    expect(series[0]).toEqual({ date: daily[0].date, balance: Number(daily[0].balance) });
    expect(series[90]).toEqual({ date: daily[90].date, balance: Number(daily[90].balance) });
  });

  it("returns nothing for a missing daily series, never a fabricated curve", () => {
    expect(cashFlowForecastSeries(undefined)).toEqual([]);
    expect(cashFlowForecastSeries(null)).toEqual([]);
  });

  it("(round 2, NIT) drops a blank or missing balance instead of plotting a $0 point; a real 0.00 still plots", () => {
    const series = cashFlowForecastSeries([
      { date: "2026-01-01", balance: "" },
      { date: "2026-01-02", balance: "   " },
      { date: "2026-01-03", balance: null as unknown as string },
      { date: "2026-01-04", balance: "12.34" },
      { date: "2026-01-05", balance: "0.00" },
    ]);
    expect(series).toEqual([
      { date: "2026-01-04", balance: 12.34 },
      { date: "2026-01-05", balance: 0 },
    ]);
  });
});

describe("cashFlowCardTitle — the scope comes from the cash signal's own account (round 2, L1)", () => {
  it("names the account, its mask and its own subtype", () => {
    expect(cashFlowCardTitle({ status: "ready", account: CHECKING }, HORIZON)).toBe(
      "Forecast · Test Bank ••0001 checking · next 90 days",
    );
  });

  it("doesn't double the kind word when the account's name already says it", () => {
    expect(
      cashFlowCardTitle(
        { status: "ready", account: { ...CHECKING, name: "Everyday Checking" } },
        HORIZON,
      ),
    ).toBe("Forecast · Everyday Checking ••0001 · next 90 days");
  });

  it("never calls a savings account checking", () => {
    const title = cashFlowCardTitle(
      {
        status: "ready",
        account: { name: "Test Bank", mask: "0002", subtype: "savings", via: "sole depository" },
      },
      HORIZON,
    );
    expect(title).toBe("Forecast · Test Bank ••0002 savings · next 90 days");
    expect(title).not.toMatch(/checking/i);
  });

  it("adds no kind word when the account has no subtype", () => {
    expect(
      cashFlowCardTitle(
        {
          status: "ready",
          account: { name: "Test Bank", mask: "0003", subtype: null, via: "sole depository" },
        },
        HORIZON,
      ),
    ).toBe("Forecast · Test Bank ••0003 · next 90 days");
  });

  it("names no account when none was resolved (the balance stays at the raw snapshot)", () => {
    expect(
      cashFlowCardTitle(
        {
          status: "ready",
          account: { name: null, mask: null, subtype: null, via: "unresolved" },
        },
        HORIZON,
      ),
    ).toBe("Forecast · bank account not identified · next 90 days");
  });

  it("says plainly when no bank balance is set, and keeps the horizon", () => {
    expect(cashFlowCardTitle({ status: "no_data", account: CHECKING }, HORIZON)).toBe(
      "Forecast · no bank balance set · next 90 days",
    );
  });

  it("before the signal answers: a neutral title that claims no scope", () => {
    expect(cashFlowCardTitle(undefined, HORIZON)).toBe("Forecast balance · next 90 days");
    expect(cashFlowCardTitle(null, HORIZON)).toBe("Forecast balance · next 90 days");
  });
});

describe("Cash flow — the forecast-balance card (owner decision 16)", () => {
  it("(round 2, M1) asks for exactly { horizonDays: 90 }, the key Forecast Overview, the prefetch and the Forecast page's 90-day tab share", () => {
    q.cashSignal = readySignal();
    renderPage();
    expect(q.cashSignalParams.length).toBeGreaterThan(0);
    for (const params of q.cashSignalParams) {
      // toStrictEqual: a `fromDate: undefined` key would fail too.
      expect(params).toStrictEqual({ horizonDays: 90 });
    }
  });

  it("(round 2, L2) never fetches the /forecast bundle", () => {
    q.cashSignal = readySignal();
    renderPage();
    expect(q.forecastBundleCalls).toBe(0);
  });

  it("(round 2, L1) titles itself from the cash signal's own account", () => {
    q.cashSignal = readySignal();
    renderPage();
    expect(titleOf(forecastCard())).toBe("Forecast · Test Bank ••0001 checking · next 90 days");
  });

  it("(round 2, M2) draws the curve when the signal is ready, with no empty text", () => {
    q.cashSignal = readySignal();
    renderPage();
    const card = forecastCard();
    expect(chartIn(card)).not.toBeNull();
    expect(card.textContent).not.toContain(EMPTY_TEXT);
  });

  it("(round 2, M2) no_data with a full 91-point curve: the empty text, no chart, no dollar figure", () => {
    q.cashSignal = noDataSignal();
    renderPage();
    const card = forecastCard();
    expect(card.textContent).toContain(EMPTY_TEXT);
    expect(chartIn(card)).toBeNull();
    expect(card.textContent).not.toMatch(/\$\d/);
  });

  it("shows no $0 while still loading (cold)", () => {
    // q.cashSignal stays undefined → dataState() === "cold"
    renderPage();
    const card = forecastCard();
    expect(card.textContent).not.toMatch(/\$\d/);
    expect(card.querySelector("[data-testid='cashflow-forecast-loading']")).not.toBeNull();
    expect(chartIn(card)).toBeNull();
  });

  it("shows a retry banner and no $0 when the first load fails outright", () => {
    q.cashSignalLoadingError = true;
    renderPage();
    const card = forecastCard();
    expect(card.textContent).not.toMatch(/\$\d/);
    const banner = bannerIn(card);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Couldn't load these numbers.");
    expect(within(banner!).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("(round 2, NIT) a Retry in flight after a failed first load says Refreshing…, not another Retry", () => {
    q.cashSignalLoadingError = true;
    q.cashSignalFetching = true;
    renderPage();
    const banner = bannerIn(forecastCard());
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Refreshing…");
    expect(within(banner!).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("(round 2, L3) a later refetch failure keeps the curve and puts its banner OUTSIDE the fixed-height chart box", () => {
    q.cashSignal = readySignal();
    q.cashSignalRefetchError = true;
    q.cashSignalUpdatedAt = Date.now();
    renderPage();
    const card = forecastCard();
    const chart = chartIn(card);
    const banner = bannerIn(card);
    expect(chart).not.toBeNull();
    expect(banner).not.toBeNull();
    // The kit's fixed 320px box that the chart fills. Anything else inside it
    // takes height from the chart, whose bottom the card then clips.
    const box = chart!.closest<HTMLElement>("[style*='height: 320px']");
    expect(box).not.toBeNull();
    expect(box!.contains(banner)).toBe(false);
    expect(card.contains(banner)).toBe(true);
  });

  it("(round 2, L3) a refetch failure over the no-data empty state still shows its banner", () => {
    q.cashSignal = noDataSignal();
    q.cashSignalRefetchError = true;
    q.cashSignalUpdatedAt = Date.now();
    renderPage();
    const card = forecastCard();
    expect(card.textContent).toContain(EMPTY_TEXT);
    expect(bannerIn(card)).not.toBeNull();
    expect(chartIn(card)).toBeNull();
  });
});

/** Comments may still explain, in prose, why the code doesn't read the field
 * anymore — only the CODE itself must never reference it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the card no longer reads the settings row's starting balance", () => {
  it("(round 2, NIT) the code never reads settings.startingBalance (CashSignal.startingBalance is a different, allowed field)", () => {
    // Runs from the package dir under vitest, from the repo root under some IDEs.
    const path = [
      resolve(process.cwd(), "src/pages/reports/CashFlowPage.tsx"),
      resolve(process.cwd(), "artifacts/h2budget/src/pages/reports/CashFlowPage.tsx"),
    ].find(existsSync);
    expect(path).toBeTruthy();
    const src = readFileSync(path!, "utf8");
    expect(stripComments(src)).not.toMatch(/settings\s*\??\.\s*startingBalance/);
  });
});
