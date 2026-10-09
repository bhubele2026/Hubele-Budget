import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

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

vi.mock("./dashboard/BelowFold", () => ({
  default: () => (
    <>
      {["Forecast", "Debt", "Activity", "Review"].map((n) => (
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
  it("renders every panel in order, the Afford launcher and the build version, and starts the idle warm-up", async () => {
    render(<DashboardPage />);
    // The first screen is eager; the four below it arrive after first paint, behind same-size skeletons.
    expect(screen.getByTestId("stub-Cash")).toBeTruthy();
    expect(screen.getByTestId("below-fold-skeleton-forecast")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("stub-Review")).toBeTruthy());
    expect(screen.queryByTestId("below-fold-skeleton-forecast")).toBeNull();
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

describe("below-the-fold skeletons are the panels' size", () => {
  it("each skeleton carries the same span and minimum height as its panel (one constant feeds both)", async () => {
    const { BELOW_FOLD } = await import("./dashboard/belowFoldSizes");
    const { BelowFoldSkeleton } = await import("./dashboard/BelowFoldSkeleton");
    render(<BelowFoldSkeleton />);
    for (const [k, v] of Object.entries(BELOW_FOLD)) {
      const sk = screen.getByTestId(`below-fold-skeleton-${k}`);
      expect(sk.className).toContain(`span-${v.span}`);
      expect(sk.className).toContain(v.minH);
    }
  });
});
