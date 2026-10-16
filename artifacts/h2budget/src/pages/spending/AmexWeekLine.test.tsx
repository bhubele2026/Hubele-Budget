import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ data: undefined as unknown, params: [] as Array<Record<string, unknown>> }));
vi.mock("@workspace/api-client-react/features", () => ({
  useGetAmexSummary: (p: Record<string, unknown>) => {
    h.params.push(p);
    return { data: h.data };
  },
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
}));

import { AmexWeekLine } from "./AmexWeekLine";

afterEach(() => {
  cleanup();
  h.data = undefined;
  h.params = [];
});

describe("(E5) Spending week: the Amex week line", () => {
  it("says purchases, counted and not counted from the server's own figures, with a link to the breakdown", () => {
    h.data = { purchases: { amount: "425.00" }, householdContribution: { weeklyKnown: "300.00", weeklyUnresolved: "40.00" } };
    const open = vi.fn();
    render(<AmexWeekLine start="2026-10-11" end="2026-10-17" onOpen={open} />);
    expect(screen.getByTestId("sp-amex-week-words").textContent).toBe("Amex purchases $425.00 · counted $300.00 · not counted $40.00");
    expect(h.params[0]).toEqual({ accountId: "all", from: "2026-10-11", to: "2026-10-17" });
    fireEvent.click(screen.getByTestId("sp-amex-week-link"));
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("draws nothing without an answer (never $0.00)", () => {
    const { container } = render(<AmexWeekLine start="2026-10-11" end="2026-10-17" onOpen={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
