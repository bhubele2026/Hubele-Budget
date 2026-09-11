import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FreshnessLine, RefreshBanner } from "./data-state";

const NOW = new Date("2026-09-11T17:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

afterEach(() => cleanup());

describe("FreshnessLine — the server's verdict, in words", () => {
  it("renders nothing without a snapshot", () => {
    const { container } = render(<FreshnessLine bank={undefined} now={NOW} />);
    expect(container.textContent).toBe("");
    const none = render(
      <FreshnessLine
        bank={{ asOfDate: null, source: null, lastContactAt: null, stale: false, staleReason: null }}
        now={NOW}
      />,
    );
    expect(none.container.textContent).toBe("");
  });

  it("a fresh Plaid balance keeps the calm 'Last auto-updated' line", () => {
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(2 * HOUR), source: "plaid", lastContactAt: ago(HOUR), stale: false, staleReason: null }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("text-bank-snapshot-freshness").textContent).toBe(
      "Last auto-updated 2 hours ago",
    );
    expect(screen.queryByTestId("text-bank-freshness-stale")).toBeNull();
  });

  it("a fresh typed-in balance keeps 'Set manually'", () => {
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(3 * HOUR), source: "manual", lastContactAt: null, stale: false, staleReason: null }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("text-bank-snapshot-freshness").textContent).toContain(
      "Set manually",
    );
  });

  it("a failed refresh says so, in the alarm colour, with when the balance is from", () => {
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(2 * HOUR), source: "plaid", lastContactAt: ago(2 * HOUR), stale: true, staleReason: "refresh_failed" }}
        now={NOW}
      />,
    );
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toBe("Refresh failed · last updated 2 hours ago");
    expect(screen.getByText("Refresh failed").className).toContain("text-bad");
    expect(screen.queryByTestId("text-bank-snapshot-freshness")).toBeNull();
  });

  it("a quiet feed says there has been no bank update in 2 days, without the alarm colour", () => {
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(3 * DAY), source: "plaid", lastContactAt: ago(50 * HOUR), stale: true, staleReason: "old" }}
        now={NOW}
      />,
    );
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toContain("No bank update in 2 days");
    expect(line.getAttribute("data-reason")).toBe("old");
    expect(screen.getByText("No bank update in 2 days").className).not.toContain("text-bad");
  });

  it("an old typed-in balance says it is over a week old", () => {
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(9 * DAY), source: "manual", lastContactAt: null, stale: true, staleReason: "manual_old" }}
        now={NOW}
      />,
    );
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toContain("Set manually");
    expect(line.textContent).toContain("over a week old");
    expect(line.getAttribute("data-reason")).toBe("manual_old");
  });
});

describe("RefreshBanner", () => {
  it("renders nothing while the numbers are loading, loaded or refreshing", () => {
    for (const state of ["cold", "loaded", "refreshing"] as const) {
      const { container } = render(
        <RefreshBanner state={state} updatedAt={ago(5 * MIN)} onRetry={() => {}} now={NOW} />,
      );
      expect(container.textContent).toBe("");
      cleanup();
    }
  });

  it("after a failed refresh, keeps the numbers and says how old they are, with a Retry", () => {
    const onRetry = vi.fn();
    render(
      <RefreshBanner state="refresh-failed" updatedAt={ago(5 * MIN)} onRetry={onRetry} now={NOW} />,
    );
    const banner = screen.getByTestId("refresh-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("Couldn't refresh. Showing numbers from 5 minutes ago.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("after a failed first load, says the numbers could not load, with a Retry", () => {
    const onRetry = vi.fn();
    render(<RefreshBanner state="failed" updatedAt={null} onRetry={onRetry} now={NOW} />);
    expect(screen.getByTestId("refresh-banner").textContent).toContain(
      "Couldn't load these numbers.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
