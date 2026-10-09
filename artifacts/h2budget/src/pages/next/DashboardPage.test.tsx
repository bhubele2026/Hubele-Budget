import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/** (C11) The dashboard is the landing: its refresh banner, version label and skeleton. */

const h = vi.hoisted(() => ({ state: "loaded" as string, refetch: vi.fn(), warm: vi.fn() }));
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ state: h.state, refetch: h.refetch, updatedAt: "2026-10-09T12:00:00Z", isFetching: false, data: undefined }),
}));
vi.mock("@/hooks/useLandingWarmup", () => ({ useLandingWarmup: () => h.warm() }));
vi.mock("@/components/afford/AffordLauncher", () => ({ AffordLauncher: () => <button data-testid="afford-open" /> }));
vi.mock("./dashboard/BriefingPanel", () => ({ default: () => <div data-testid="stub-Briefing" /> }));
vi.mock("./dashboard/AccountsRow", () => ({ default: () => <div data-testid="stub-Accounts" /> }));
vi.mock("./dashboard/CashPanel", () => ({ default: () => <div data-testid="stub-Cash" /> }));
vi.mock("./dashboard/SpendingPanel", () => ({ default: () => <div data-testid="stub-Spending" /> }));
vi.mock("./dashboard/UpcomingPanel", () => ({ default: () => <div data-testid="stub-Upcoming" /> }));
vi.mock("./dashboard/ForecastPanel", () => ({ default: () => <div data-testid="stub-Forecast" /> }));
vi.mock("./dashboard/DebtPanel", () => ({ default: () => <div data-testid="stub-Debt" /> }));
vi.mock("./dashboard/ActivityPanel", () => ({ default: () => <div data-testid="stub-Activity" /> }));
vi.mock("./dashboard/ReviewPanel", () => ({ default: () => <div data-testid="stub-Review" /> }));

import DashboardPage from "./Dashboard";
import { DashboardSkeleton } from "./dashboard/DashboardSkeleton";

beforeEach(() => {
  h.state = "loaded";
  h.refetch.mockClear();
  h.warm.mockClear();
});
afterEach(() => cleanup());

describe("Dashboard page (the landing)", () => {
  it("renders every panel in order, the Afford launcher and the build version, and starts the idle warm-up", () => {
    render(<DashboardPage />);
    expect(screen.getByTestId("page-next-dashboard")).toBeTruthy();
    const order = Array.from(document.querySelectorAll("[data-testid^='stub-']"), (e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["stub-Briefing", "stub-Accounts", "stub-Cash", "stub-Spending", "stub-Upcoming", "stub-Forecast", "stub-Debt", "stub-Activity", "stub-Review"]);
    expect(screen.getByTestId("afford-open")).toBeTruthy();
    expect(screen.getByTestId("dash-version").textContent).toMatch(/^Version /);
    expect(h.warm).toHaveBeenCalled();
    expect(screen.queryByTestId("dash-refresh-banner")).toBeNull();
  });

  it("a failed refresh says so, with Retry (the panels would keep the old numbers silently)", () => {
    h.state = "refresh-failed";
    render(<DashboardPage />);
    const b = screen.getByTestId("dash-refresh-banner");
    expect(b).toBeTruthy();
    fireEvent.click(b.querySelector("button")!);
    expect(h.refetch).toHaveBeenCalled();
  });

  it("the skeleton has the panel grid and no numbers at all", () => {
    render(<DashboardSkeleton />);
    const sk = screen.getByTestId("dashboard-skeleton");
    expect(sk.querySelectorAll(".panel").length).toBeGreaterThanOrEqual(6);
    expect(sk.textContent).toBe("");
  });
});
