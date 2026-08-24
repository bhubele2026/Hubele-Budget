import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// The landing is a door, not a dashboard. These tests pin the two rules that
// make it one: it reads the shared spine (never its own tile queries), and it
// shows EXACTLY TWO numbers — the review count and % paid. In particular, the
// standing rule that the front door never shows an amount owed is asserted
// here as well as being structurally guaranteed by the /api/spine payload.

const spineData: { current: unknown } = { current: undefined };
vi.mock("@/hooks/useSpine", () => ({
  useSpine: () => ({ data: spineData.current, isLoading: false }),
}));

const warmup = vi.fn();
vi.mock("@/hooks/useLandingWarmup", () => ({
  useLandingWarmup: () => warmup(),
}));

vi.mock("@clerk/react", () => ({
  UserButton: () => <div data-testid="user-button" />,
}));

const prefetchRoute = vi.fn();
vi.mock("@/lib/routePrefetch", () => ({
  prefetchRoute: (h: string) => prefetchRoute(h),
}));

import LandingPage, { LandingSkeleton } from "./landing";

function mount() {
  const { hook } = memoryLocation({ path: "/home" });
  return render(
    <Router hook={hook}>
      <LandingPage />
    </Router>,
  );
}

/**
 * Every digit still on the page once the allowed numbers are cut out of it.
 * The version stamp is always excluded — it is a build id, not a figure about
 * the household's money.
 */
function strayDigits(container: HTMLElement, allowedTestIds: string[]): string {
  const clone = container.cloneNode(true) as HTMLElement;
  const drop = [
    ...allowedTestIds.map((id) => `[data-testid="${id}"]`),
    '[data-testid="landing-version"]',
    // ⚠️ The wordmark is TYPE, so the "2" in "H2" is a literal digit in the
    // DOM. It is the brand, not a figure — strip the lockup (hero + watermark)
    // before counting, or this assertion fails on the logo.
    '[aria-label="H2 Budget"]',
  ];
  for (const sel of drop) {
    for (const node of Array.from(clone.querySelectorAll(sel))) node.remove();
  }
  return (clone.textContent ?? "").replace(/[^0-9]/g, "");
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
  spineData.current = {
    reviewCount: 4,
    debt: { payoffPct: 39.7 },
  };
});

describe("landing — the six-tile door", () => {
  it("renders all six area tiles", () => {
    mount();
    for (const id of [
      "banking",
      "bills",
      "forecast",
      "avalanche",
      "budget",
      "settings",
    ]) {
      expect(screen.getByTestId(`landing-tile-${id}`)).toBeTruthy();
    }
  });

  it("routes each tile to its area", () => {
    mount();
    const href = (id: string) =>
      screen.getByTestId(`landing-tile-${id}`).getAttribute("href");
    expect(href("banking")).toBe("/banking");
    expect(href("bills")).toBe("/bills");
    expect(href("forecast")).toBe("/forecast/overview");
    expect(href("avalanche")).toBe("/avalanche");
    expect(href("budget")).toBe("/budget");
    expect(href("settings")).toBe("/settings");
  });

  it("keeps the secondary destinations in the quiet More row, not a seventh tile", () => {
    mount();
    const more = screen.getByTestId("landing-more");
    expect(more.textContent).toContain("Reports");
    expect(more.textContent).toContain("Allowances");
    // Six loud tiles, and no more.
    expect(screen.getAllByTestId(/^landing-tile-/).length).toBe(6);
  });
});

describe("landing — exactly two numbers, both from the spine", () => {
  it("shows the review count on the bell", () => {
    mount();
    expect(screen.getByTestId("landing-bell-count").textContent).toBe("4");
  });

  it("shows % paid on Future Goal", () => {
    mount();
    expect(screen.getByTestId("landing-payoff-pct").textContent).toBe("40% paid");
  });

  it("⚠️ never renders an amount owed", () => {
    const { container } = mount();
    // No currency anywhere on the front door. The spine cannot supply one (it
    // carries payoffPct and no balances), and the page must not invent one.
    expect(container.textContent).not.toMatch(/\$/);
  });

  it("renders NO numbers beyond those two", () => {
    const { container } = mount();
    // Cut out the bell count and the payoff percentage and there is not a
    // single digit left on the front door.
    expect(
      strayDigits(container, ["landing-bell-count", "landing-payoff-pct"]),
    ).toBe("");
  });

  it("hides both numbers when the spine has not answered yet", () => {
    spineData.current = undefined;
    const { container } = mount();
    expect(screen.queryByTestId("landing-bell-count")).toBeNull();
    expect(screen.queryByTestId("landing-payoff-pct")).toBeNull();
    // Still a complete door — the tiles never wait on data.
    expect(screen.getAllByTestId(/^landing-tile-/).length).toBe(6);
    expect(strayDigits(container, [])).toBe("");
  });

  it("omits % paid when no debt carries an anchor (null, not 0%)", () => {
    spineData.current = { reviewCount: 0, debt: { payoffPct: null } };
    mount();
    expect(screen.queryByTestId("landing-payoff-pct")).toBeNull();
    // A zero count is not a badge — an empty inbox shows nothing at all.
    expect(screen.queryByTestId("landing-bell-count")).toBeNull();
  });
});

describe("landing — the pre-Clerk skeleton", () => {
  it("paints the six-tile frame with zero numbers", () => {
    const { container } = render(<LandingSkeleton />);
    expect(screen.getByTestId("landing-skeleton")).toBeTruthy();
    // Nothing sensitive can paint before Clerk resolves, because there is
    // nothing to paint: the skeleton reads no query at all.
    expect(strayDigits(container, [])).toBe("");
    expect(container.textContent).not.toMatch(/\$|%/);
  });
});
