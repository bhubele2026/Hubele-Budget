import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { ForecastDateBalance } from "./forecast-date-balance";
import type { CashSignal } from "@workspace/api-client-react";
afterEach(cleanup);
const signal = {
  status: "ready",
  cashBuffer: "500",
  daily: [
    { date: "2026-09-10", balance: "1000.10" },
    { date: "2026-09-11", balance: "275.55" },
  ],
} as CashSignal;
describe("future date cash lookup", () => {
  it("reads exact balances for the chosen day from the server curve", () => {
    render(<ForecastDateBalance signal={signal} />);
    expect(screen.getByText("$275.55")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("How much will we have?"), {
      target: { value: "2026-09-10" },
    });
    expect(screen.getByText("$1,000.10")).toBeTruthy();
  });
  it("does not invent balances outside the window or before a snapshot exists", () => {
    const { rerender } = render(<ForecastDateBalance signal={signal} />);
    fireEvent.change(screen.getByLabelText("How much will we have?"), {
      target: { value: "2026-10-10" },
    });
    expect(screen.getByText("—")).toBeTruthy();
    rerender(<ForecastDateBalance signal={{ ...signal, status: "no_data" }} />);
    expect(screen.queryByText("$275.55")).toBeNull();
  });
});
