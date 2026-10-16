import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ data: undefined as unknown, params: [] as Array<Record<string, unknown>> }));
vi.mock("@workspace/api-client-react/features", () => ({
  useGetAmexSummary: (p: Record<string, unknown>) => {
    h.params.push(p);
    return { data: h.data };
  },
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
}));

import AmexWeekCharges from "./AmexWeekCharges";

afterEach(() => {
  cleanup();
  h.data = undefined;
  h.params = [];
});

describe("Amex tile — Amex purchases · this week (W4)", () => {
  it("shows the server's purchases for every card, this week", () => {
    h.data = { purchases: { amount: "425.00", count: 7 } };
    render(<AmexWeekCharges />);
    expect(screen.getByTestId("tile-amex-purchases-week").textContent).toContain("Amex purchases · this week");
    expect(screen.getByTestId("tile-amex-purchases-week").textContent).toContain("$425.00");
    expect(h.params[0]!.accountId).toBe("all");
  });
  it("shows nothing while there is no answer (never $0)", () => {
    const { container } = render(<AmexWeekCharges />);
    expect(container.innerHTML).toBe("");
  });
});
