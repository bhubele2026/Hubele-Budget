import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { memoryLocation } from "wouter/memory-location";

/**
 * (F4) The dashboard's This week tile on the KNOWN figure. Synthetic fixtures
 * only; every figure is the period breakdown's string.
 */
const h = vi.hoisted(() => ({ bd: undefined as unknown }));
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useGetPeriodBreakdown: () => ({ data: h.bd, isError: false, isLoading: false }),
}));
vi.mock("./queries", () => ({ useMoneyPositionQ: () => ({ data: { spentWeekDiscretionary: "999.00", weekCap: "300.00" }, isError: false }) }));
vi.mock("@/hooks/useSpine", () => ({ useSpine: () => ({ data: undefined, state: "loaded", refetch: () => {} }) }));

import WeekKnownTile from "./WeekKnownTile";

const spine = { position: { withinPlan: "yes" } } as never;
const bd = (o: Record<string, unknown> = {}) => ({
  plan: { status: "set", amount: "300.00" }, known: "324.50", actual: "1509.69", remaining: "-24.50", over: "24.50", provisional: false,
  unresolved: { amount: "1150.40" }, ...o,
});
const mountTile = () => {
  const mem = memoryLocation({ path: "/home", record: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Router hook={mem.hook}>
        <WeekKnownTile s={spine} base={<div data-testid="base-tile">base</div>} />
      </Router>
    </QueryClientProvider>,
  );
};
beforeEach(() => { h.bd = bd(); });
afterEach(() => cleanup());

describe("This week tile — known figure", () => {
  it("until the breakdown arrives, the spine-based tile stays", () => {
    h.bd = undefined;
    mountTile();
    expect(screen.getByTestId("base-tile")).toBeTruthy();
  });

  it("headline is the known figure, not the cautious one", async () => {
    mountTile();
    await waitFor(() => expect(screen.getByTestId("tile-week")).toBeTruthy());
    expect(screen.getByTestId("tile-week-spent").textContent).toBe("$324.50");
    expect(screen.getByTestId("tile-week-plan").textContent).toBe("$300.00");
    expect(screen.getByTestId("tile-week-left").textContent).toBe("Over $24.50");
    expect(screen.getByTestId("tile-week-status").textContent).toBe("Over");
    expect(screen.queryByTestId("tile-week-provisional")).toBeNull();
  });

  it("provisional: the chip says Provisional, the line says 'Over $X so far · provisional', never a bare Over", async () => {
    h.bd = bd({ provisional: true });
    mountTile();
    await waitFor(() => expect(screen.getByTestId("tile-week")).toBeTruthy());
    expect(screen.getByTestId("tile-week-status").textContent).toBe("Provisional");
    expect(screen.getByTestId("tile-week-left").textContent).toBe("Over $24.50 so far · provisional");
    expect(screen.getByTestId("tile-week-left").className).not.toContain("text-bad-ink");
    expect(screen.getByTestId("tile-week-provisional").textContent).toBe("Unconfirmed $1,150.40 may change this");
    expect(screen.getByTestId("tile-week").textContent).not.toMatch(/Over\s*$/);
  });

  it("within the plan and provisional: 'left so far · provisional'", async () => {
    h.bd = bd({ provisional: true, remaining: "75.50", over: "0.00", known: "224.50" });
    mountTile();
    await waitFor(() => expect(screen.getByTestId("tile-week")).toBeTruthy());
    expect(screen.getByTestId("tile-week-left").textContent).toBe("$75.50 left so far · provisional");
  });

  it("no plan: Plan not set, never $0 or Over", async () => {
    h.bd = bd({ plan: { status: "not_set", amount: null }, remaining: null, over: null });
    mountTile();
    await waitFor(() => expect(screen.getByTestId("tile-week")).toBeTruthy());
    expect(screen.getByTestId("tile-week-status").textContent).toBe("Plan not set");
    expect(screen.queryByTestId("tile-week-left")).toBeNull();
    // provisional with no plan: the marker is still there, beside the unconfirmed line
    h.bd = bd({ plan: { status: "not_set", amount: null }, remaining: null, over: null, provisional: true });
    cleanup();
    mountTile();
    expect(screen.getByTestId("tile-week-provisional").textContent).toBe("ProvisionalUnconfirmed $1,150.40 may change this");
  });
});
