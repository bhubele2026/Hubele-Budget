import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

/** (C11, refinement) The dashboard is the landing: its order, lazy slots, refresh banner, version label and skeleton. */

const h = vi.hoisted(() => ({ state: "loaded" as string, refetch: vi.fn(), warm: vi.fn(), items: [{ id: "a", institutionSlug: "chase", accounts: [] }] as unknown }));
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ state: h.state, refetch: h.refetch, updatedAt: "2026-10-09T12:00:00Z", isFetching: false, data: undefined }),
}));
vi.mock("@/hooks/useLandingWarmup", () => ({ useLandingWarmup: () => h.warm() }));
vi.mock("./dashboard/queries", () => ({ usePlaidItemsQ: () => ({ data: h.items }) }));
vi.mock("./dashboard/DashboardHeader", () => ({ default: () => <div data-testid="stub-Header" /> }));
vi.mock("./dashboard/FourNumbers", () => ({ default: () => <div data-testid="stub-Four" /> }));
vi.mock("./dashboard/AvalancheWeekBox", () => ({ default: () => <div data-testid="stub-Pay" /> }));
vi.mock("./dashboard/MoreDrawer", () => ({ default: () => <div data-testid="stub-More" /> }));

vi.mock("./dashboard/BelowFold", () => ({
  ForecastRow: () => <div data-testid="stub-Forecast" />,
}));

import DashboardPage from "./Dashboard";
import { DashboardSkeleton } from "./dashboard/DashboardSkeleton";

beforeEach(() => {
  h.items = [{ id: "a", institutionSlug: "chase", accounts: [] }];
  h.state = "loaded";
  h.refetch.mockClear();
  h.warm.mockClear();
});
afterEach(() => cleanup());

describe("Dashboard page (the landing)", () => {
  it("renders header, what to pay this week, the four numbers, More, then the lazy forecast; version; idle warm-up", async () => {
    render(<DashboardPage />);
    expect(screen.getByTestId("stub-Header")).toBeTruthy();
    expect(screen.getByTestId("stub-Four")).toBeTruthy();
    // The three lazy parts stand behind their own same-size skeletons first, already in the page's final order.
    // (This is the file's first render: a chunk that has loaded once renders at once afterwards.)
    const ids = Array.from(screen.getByTestId("page-next-dashboard").querySelectorAll("[data-testid]"), (e) => e.getAttribute("data-testid"));
    expect(ids.filter((i) => /^(stub-|below-fold-skeleton-|dash-more-skeleton)/.test(i ?? ""))).toEqual([
      "stub-Header", "below-fold-skeleton-avalanche", "stub-Four", "dash-more-skeleton", "below-fold-skeleton-forecast",
    ]);
    await waitFor(() => expect(screen.getByTestId("stub-Forecast")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("stub-Pay")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("stub-More")).toBeTruthy());
    expect(screen.queryByTestId("below-fold-skeleton-forecast")).toBeNull();
    expect(screen.queryByTestId("below-fold-skeleton-avalanche")).toBeNull();
    expect(screen.queryByTestId("dash-more-skeleton")).toBeNull();
    const order = Array.from(document.querySelectorAll("[data-testid^='stub-']"), (e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["stub-Header", "stub-Pay", "stub-Four", "stub-More", "stub-Forecast"]);
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
    expect(sk.querySelectorAll("[data-testid='dashboard-skeleton-tile']").length).toBe(4);
    expect(sk.textContent).toBe("");
  });

  it("(review #3) the pre-Clerk skeleton is the page's own skeleton: same slots, spans and minimum heights, in page order", async () => {
    const { BELOW_FOLD } = await import("./dashboard/belowFoldSizes");
    render(<DashboardSkeleton />);
    const sk = screen.getByTestId("dashboard-skeleton");
    for (const [k, v] of Object.entries(BELOW_FOLD).filter(([, v]) => v.slot === "pay" || v.slot === "forecast")) {
      const slot = sk.querySelector<HTMLElement>(`[data-testid='below-fold-skeleton-${k}']`);
      expect(slot, k).toBeTruthy();
      expect(slot!.className, k).toContain(`span-${v.span}`);
      if (v.minH) expect(slot!.className, k).toContain(v.minH);
    }
    const order = Array.from(sk.querySelectorAll("[data-testid^='below-fold-skeleton-']"), (e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["below-fold-skeleton-avalanche", "below-fold-skeleton-forecast"]);
    // …and the page, before its lazy chunk lands, draws exactly the same slot skeletons.
    // (The pay slot's chunk has loaded by now, so the page shows the box itself; the first test saw its skeleton.)
    cleanup();
    render(<DashboardPage />);
    for (const [k, v] of Object.entries(BELOW_FOLD).filter(([, v]) => v.slot === "forecast")) {
      const pageSlot = screen.getByTestId(`below-fold-skeleton-${k}`);
      expect(pageSlot.className, k).toContain(`span-${v.span}`);
      if (v.minH) expect(pageSlot.className, k).toContain(v.minH);
    }
  });
});

describe("no bank linked: the lazy panels drop their fixed heights together", () => {
  it("skeletons carry no minimum height in the compact page, and the page says it is compact", async () => {
    h.items = [];
    render(<DashboardPage />);
    expect(screen.getByTestId("page-next-dashboard").getAttribute("data-compact")).toBe("true");
    const { BELOW_FOLD } = await import("./dashboard/belowFoldSizes");
    expect(screen.getByTestId("below-fold-skeleton-forecast").className).not.toContain(BELOW_FOLD.forecast.minH);
    // The pay slot's skeleton reads the same switch (its chunk has loaded by now, so it is drawn here on its own).
    const { BelowFoldSkeleton } = await import("./dashboard/BelowFoldSkeleton");
    const { CompactFold } = await import("./dashboard/foldDensity");
    render(<CompactFold.Provider value><BelowFoldSkeleton slot="pay" /></CompactFold.Provider>);
    expect(screen.getByTestId("below-fold-skeleton-avalanche").className).not.toContain(BELOW_FOLD.avalanche.minH);
  });
});

describe("below-the-fold skeletons are the panels' size", () => {
  it("each skeleton carries the same span and minimum height as its panel (one constant feeds both)", async () => {
    const { BELOW_FOLD, slotKeys } = await import("./dashboard/belowFoldSizes");
    const { BelowFoldSkeleton } = await import("./dashboard/BelowFoldSkeleton");
    expect(slotKeys("pay")).toEqual(["avalanche"]);
    expect(slotKeys("forecast")).toEqual(["forecast"]);
    render(<><BelowFoldSkeleton slot="pay" /><BelowFoldSkeleton slot="forecast" /></>);
    for (const [k, v] of Object.entries(BELOW_FOLD).filter(([, v]) => v.slot === "pay" || v.slot === "forecast")) {
      const sk = screen.getByTestId(`below-fold-skeleton-${k}`);
      expect(sk.className).toContain(`span-${v.span}`);
      expect(sk.className).toContain(v.minH);
    }
  });
});
