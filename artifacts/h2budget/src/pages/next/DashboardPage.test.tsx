import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

/** (C11, refinement) The dashboard is the landing: its order, lazy slots, refresh banner, version label and skeleton. */

const h = vi.hoisted(() => ({ state: "loaded" as string, refetch: vi.fn(), warm: vi.fn() }));
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ state: h.state, refetch: h.refetch, updatedAt: "2026-10-09T12:00:00Z", isFetching: false, data: undefined }),
}));
vi.mock("@/hooks/useLandingWarmup", () => ({ useLandingWarmup: () => h.warm() }));
vi.mock("./dashboard/DashboardHeader", () => ({ default: () => <div data-testid="stub-Header" /> }));
vi.mock("./dashboard/SummaryRow", () => ({ default: () => <div data-testid="stub-Summary" /> }));
vi.mock("./dashboard/AccountsPanel", () => ({ default: () => <div data-testid="stub-Accounts" /> }));

vi.mock("./dashboard/BelowFold", () => ({
  ForecastRow: () => (
    <>
      <div data-testid="stub-Forecast" />
      <div data-testid="stub-Upcoming" />
    </>
  ),
  LowerRows: () => (
    <>
      {["Spending", "Debt", "Attention", "Activity"].map((n) => (
        <div key={n} data-testid={`stub-${n}`} />
      ))}
    </>
  ),
}));

import DashboardPage from "./Dashboard";
import { DashboardSkeleton } from "./dashboard/DashboardSkeleton";

beforeEach(() => {
  h.state = "loaded";
  h.refetch.mockClear();
  h.warm.mockClear();
});
afterEach(() => cleanup());

describe("Dashboard page (the landing)", () => {
  it("renders the owner's order: header, summary, forecast row, accounts, then the lower rows; version; idle warm-up", async () => {
    render(<DashboardPage />);
    // Eager: header, summary row, accounts. The rest arrives after first paint behind same-size skeletons.
    expect(screen.getByTestId("stub-Header")).toBeTruthy();
    expect(screen.getByTestId("stub-Summary")).toBeTruthy();
    expect(screen.getByTestId("stub-Accounts")).toBeTruthy();
    expect(screen.getByTestId("below-fold-skeleton-forecast")).toBeTruthy();
    expect(screen.getByTestId("below-fold-skeleton-activity")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("stub-Activity")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("stub-Forecast")).toBeTruthy());
    expect(screen.queryByTestId("below-fold-skeleton-forecast")).toBeNull();
    expect(screen.queryByTestId("below-fold-skeleton-activity")).toBeNull();
    const order = Array.from(document.querySelectorAll("[data-testid^='stub-']"), (e) => e.getAttribute("data-testid"));
    expect(order).toEqual([
      "stub-Header", "stub-Summary", "stub-Forecast", "stub-Upcoming", "stub-Accounts",
      "stub-Spending", "stub-Debt", "stub-Attention", "stub-Activity",
    ]);
    expect(screen.getByTestId("dash-version").textContent).toMatch(/^Version /);
    expect(h.warm).toHaveBeenCalled();
    expect(screen.queryByTestId("dash-refresh-banner")).toBeNull();
  });

  it("has no Page wrapper: no second h1 and no doubled padding inside the shell's", () => {
    render(<DashboardPage />);
    const root = screen.getByTestId("page-next-dashboard");
    expect(root.querySelector("h1")).toBeNull(); // the header (stubbed here) carries the page's title
    expect(root.innerHTML).not.toMatch(/px-6 py-8/);
  });

  it("a failed refresh says so, with Retry (the panels would keep the old numbers silently)", () => {
    h.state = "refresh-failed";
    render(<DashboardPage />);
    const b = screen.getByTestId("dash-refresh-banner");
    expect(b).toBeTruthy();
    fireEvent.click(b.querySelector("button")!);
    expect(h.refetch).toHaveBeenCalled();
  });

  it("the skeleton has the layout's shapes and no numbers at all", () => {
    render(<DashboardSkeleton />);
    const sk = screen.getByTestId("dashboard-skeleton");
    expect(sk.querySelectorAll(".panel").length).toBeGreaterThanOrEqual(4);
    expect(sk.querySelector(".kpi-grid")).toBeTruthy();
    expect(sk.textContent).toBe("");
  });
});

describe("below-the-fold skeletons are the panels' size", () => {
  it("each skeleton carries the same span and minimum height as its panel (one constant feeds both)", async () => {
    const { BELOW_FOLD, slotKeys } = await import("./dashboard/belowFoldSizes");
    const { BelowFoldSkeleton } = await import("./dashboard/BelowFoldSkeleton");
    expect(slotKeys("forecast")).toEqual(["forecast", "upcoming"]);
    expect(slotKeys("lower")).toEqual(["spending", "debt", "attention", "activity"]);
    render(<><BelowFoldSkeleton slot="forecast" /><BelowFoldSkeleton slot="lower" /></>);
    for (const [k, v] of Object.entries(BELOW_FOLD)) {
      const sk = screen.getByTestId(`below-fold-skeleton-${k}`);
      expect(sk.className).toContain(`span-${v.span}`);
      expect(sk.className).toContain(v.minH);
    }
  });
});
