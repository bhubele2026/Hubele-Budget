import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { FreshnessLine, RefreshBanner, moneyFace } from "./data-state";

const NOW = new Date("2026-09-11T17:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

  it("a failed refresh says so, in the alarm colour, from the bank's last contact", () => {
    // Balance re-read 3 days ago, rows synced an hour ago: the bank last spoke an
    // hour ago, which is what the server judges by.
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(3 * DAY), source: "plaid", lastContactAt: ago(HOUR), stale: true, staleReason: "refresh_failed" }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("text-bank-freshness-stale").textContent).toBe(
      "Refresh failed · last updated 1 hour ago",
    );
    expect(screen.getByText("Refresh failed").className).toContain("text-bad");
    expect(screen.queryByTestId("text-bank-snapshot-freshness")).toBeNull();
  });

  it("a quiet feed says when the bank last updated, once, without the alarm colour", () => {
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(5 * DAY), source: "plaid", lastContactAt: ago(50 * HOUR), stale: true, staleReason: "old" }}
        now={NOW}
      />,
    );
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toBe("Bank last updated 2 days ago");
    expect(line.getAttribute("data-reason")).toBe("old");
    expect(line.innerHTML).not.toContain("text-bad");
  });

  it("an old typed-in balance says it needs an update, stating its age once", () => {
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(9 * DAY), source: "manual", lastContactAt: null, stale: true, staleReason: "manual_old" }}
        now={NOW}
      />,
    );
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toBe("Set manually 1 week ago · needs an update");
    expect(line.getAttribute("data-reason")).toBe("manual_old");
  });

  it("a stale reason it does not know says 'May be out of date', never another reason's words", () => {
    render(
      <FreshnessLine
        bank={{ asOfDate: ago(3 * HOUR), source: "manual", lastContactAt: null, stale: true, staleReason: null }}
        now={NOW}
      />,
    );
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toBe("May be out of date · last updated 3 hours ago");
    expect(line.textContent).not.toContain("Set manually");
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

  it("while a Retry is in flight, says Refreshing… instead of offering another Retry", () => {
    render(
      <RefreshBanner state="refresh-failed" updatedAt={ago(5 * MIN)} onRetry={() => {}} refreshing now={NOW} />,
    );
    expect(screen.getByTestId("refresh-banner").textContent).toContain("Refreshing…");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the age moving while the page is open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<RefreshBanner state="refresh-failed" updatedAt={ago(5 * MIN)} onRetry={() => {}} />);
    expect(screen.getByTestId("refresh-banner").textContent).toContain("5 minutes ago");
    act(() => {
      vi.advanceTimersByTime(60 * 1000);
    });
    expect(screen.getByTestId("refresh-banner").textContent).toContain("6 minutes ago");
  });

  it("runs the minute timer only while it shows an age", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const minuteTimers = () =>
        setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60 * 1000).length;
      render(<RefreshBanner state="loaded" updatedAt={ago(5 * MIN)} onRetry={() => {}} />);
      render(<RefreshBanner state="failed" updatedAt={null} onRetry={() => {}} />);
      expect(minuteTimers()).toBe(0);
      render(<RefreshBanner state="refresh-failed" updatedAt={ago(5 * MIN)} onRetry={() => {}} />);
      expect(minuteTimers()).toBe(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

describe("moneyFace", () => {
  it("shows a dash for a figure that has not arrived, never $0.00", () => {
    expect(moneyFace(undefined)).toBe("—");
    expect(moneyFace(null)).toBe("—");
    expect(moneyFace("")).toBe("—");
    expect(moneyFace("not a number")).toBe("—");
  });

  it("formats a real figure, including a real zero", () => {
    expect(moneyFace("1234.5")).toBe("$1,234.50");
    expect(moneyFace(0)).toBe("$0.00");
  });
});
