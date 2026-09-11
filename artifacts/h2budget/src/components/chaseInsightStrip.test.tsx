import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

/**
 * The spending strip compares this window with the one before it. The previous
 * window is its own request, and it used to have no error handling: when it
 * failed, the strip read "Loading comparison…" forever.
 */

const facts = vi.hoisted(() => ({
  cur: undefined as unknown,
  prev: undefined as unknown,
  prevError: false,
}));

// The current window is the range the strip is given; anything else is the
// window before it.
vi.mock("@workspace/api-client-react", () => ({
  useGetReportsSpendingFacts: (params: { from: string; to: string }) =>
    params.from === "2026-09-01"
      ? { data: facts.cur, isError: false, refetch: vi.fn() }
      : { data: facts.prev, isError: facts.prevError, refetch: vi.fn() },
  getGetReportsSpendingFactsQueryKey: (p: unknown) => ["/api/reports/spending-facts", p],
}));

import { ChaseInsightStrip } from "./chase-insight-strip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RANGE = { mode: "mo", from: "2026-09-01", to: "2026-09-30", label: "September" } as any;

beforeEach(() => {
  facts.cur = { householdSpend: { total: 250 }, byCategory: [] };
  facts.prev = undefined;
  facts.prevError = false;
});
afterEach(() => cleanup());

describe("ChaseInsightStrip — the comparison says what it knows", () => {
  it("says 'Loading comparison…' while the previous window is on its way", () => {
    render(<ChaseInsightStrip range={RANGE} />);
    expect(screen.getByTestId("strip-comparison").textContent).toBe("Loading comparison…");
  });

  it("says 'Comparison unavailable' when the previous window failed, not 'Loading' forever", () => {
    facts.prevError = true;
    render(<ChaseInsightStrip range={RANGE} />);
    expect(screen.getByTestId("strip-comparison").textContent).toBe("Comparison unavailable");
  });

  it("compares against the previous window once it arrives", () => {
    facts.prev = { householdSpend: { total: 200 }, byCategory: [] };
    render(<ChaseInsightStrip range={RANGE} />);
    expect(screen.getByTestId("strip-comparison").textContent).toContain("vs $200.00 last");
  });
});
