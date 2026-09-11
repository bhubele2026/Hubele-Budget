import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/**
 * (PR3 follow-up) Reports → Cash flow, "Forecast balance · next 90 days".
 *
 * A forecast without a starting balance used to fall back to $0 and draw the
 * whole projection from zero, which reads as a real forecast. Missing now shows
 * the kit's empty state; a real starting balance of 0 still draws.
 */

const q = vi.hoisted(() => ({ forecast: undefined as unknown }));

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
  useGetDashboard: () => ({ data: undefined }),
  useListDebts: () => ({ data: [] }),
  useListPlaidLiabilityAccounts: () => ({ data: [] }),
}));

import CashFlowPage from "./CashFlowPage";

const TITLE = "Forecast balance · next 90 days";
const EVENTS = [
  { date: "2026-09-20", amount: "-100.00", name: "Rent" },
  { date: "2026-09-25", amount: "2000.00", name: "Paycheck" },
];

function forecastCard(): HTMLElement | null {
  const title = screen.queryByText(TITLE);
  return (title?.closest("[data-testid='cashflow-forecast-card']") as HTMLElement | null) ??
    (title?.parentElement?.parentElement as HTMLElement | null) ??
    null;
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
});

afterEach(() => {
  cleanup();
});

describe("Cash flow — the 90-day forecast card", () => {
  it("shows the empty state, not a curve from $0, when the starting balance is missing", () => {
    q.forecast = { settings: { daysAhead: 90 }, events: EVENTS };
    renderPage();
    const card = forecastCard();
    // Old: the card drew the projection from $0 and said nothing.
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("No starting balance set on Forecast");
  });

  it("treats a blank starting balance as missing too", () => {
    q.forecast = { settings: { daysAhead: 90, startingBalance: "" }, events: EVENTS };
    renderPage();
    expect(forecastCard()!.textContent).toContain("No starting balance set on Forecast");
  });

  it("still draws a real starting balance of 0", () => {
    q.forecast = { settings: { daysAhead: 90, startingBalance: "0" }, events: EVENTS };
    renderPage();
    const card = forecastCard();
    expect(card).not.toBeNull();
    expect(card!.textContent).not.toContain("No starting balance");
    expect(card!.textContent).not.toContain("No forecast data yet");
  });
});
