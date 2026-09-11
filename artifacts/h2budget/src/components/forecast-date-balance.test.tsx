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

describe("future date cash lookup — says why there is no answer", () => {
  it("while the forecast loads, says so rather than asking for a bank balance", () => {
    render(<ForecastDateBalance signal={undefined} state="cold" />);
    const tile = screen.getByTestId("forecast-date-balance");
    expect(tile.textContent).toContain("Loading the forecast…");
    expect(tile.textContent).not.toContain("Set a bank balance");
    expect(tile.textContent).not.toContain("$0.00");
  });

  it("when the forecast failed to load, says it could not load", () => {
    render(<ForecastDateBalance signal={undefined} state="failed" />);
    const tile = screen.getByTestId("forecast-date-balance");
    expect(tile.textContent).toContain("Couldn't load the forecast");
    expect(tile.textContent).not.toContain("Set a bank balance");
  });

  it("with no bank balance yet, keeps the setup hint", () => {
    render(<ForecastDateBalance signal={{ ...signal, status: "no_data" }} state="loaded" />);
    expect(screen.getByTestId("forecast-date-balance").textContent).toContain(
      "Set a bank balance and load the forecast",
    );
  });
});
