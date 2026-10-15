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
  const plaid = (stale: boolean, staleReason: "refresh_failed" | "old" | "manual_old" | null) => ({ source: "plaid" as const, stale, staleReason });

  it("renders nothing without a snapshot", () => {
    const { container } = render(<FreshnessLine bank={undefined} fetchedAt={null} now={NOW} />);
    expect(container.textContent).toBe("");
    const none = render(<FreshnessLine bank={{ source: null, stale: false, staleReason: null }} fetchedAt={null} now={NOW} />);
    expect(none.container.textContent).toBe("");
  });

  it("fresh: 'Updated' is the server's instant, in the header line's own words", () => {
    render(<FreshnessLine bank={plaid(false, null)} fetchedAt={ago(2 * HOUR)} now={NOW} />);
    expect(screen.getByTestId("text-bank-snapshot-freshness").textContent).toBe("Updated 2 h ago");
    expect(screen.queryByTestId("text-bank-freshness-stale")).toBeNull();
  });

  it("(A) a webhook sync after the balance read: says the server's instant, not the older balance time", () => {
    // Server fetchedAt = the later of the balance read (07:00) and the sync (11:00): 1 h ago. The tile has no other time.
    render(<FreshnessLine bank={plaid(false, null)} fetchedAt={ago(HOUR)} now={NOW} />);
    expect(screen.getByTestId("text-bank-snapshot-freshness").textContent).toBe("Updated 1 h ago");
  });

  it("(B) a typed balance with a later failed sync: the typed balance's own old time, never a browser 'later of'", () => {
    render(<FreshnessLine bank={plaid(true, "refresh_failed")} fetchedAt={ago(10 * DAY)} now={NOW} />);
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toBe("Last sync failed · Updated 10 d ago");
    expect(screen.getByText("Last sync failed").className).toContain("text-bad");
  });

  it("a quiet feed says 'Out of date' without the alarm colour", () => {
    render(<FreshnessLine bank={plaid(true, "old")} fetchedAt={ago(2 * DAY)} now={NOW} />);
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toBe("Out of date · Updated 2 d ago");
    expect(line.getAttribute("data-reason")).toBe("old");
    expect(line.innerHTML).not.toContain("text-bad");
  });

  it("an old typed-in balance says it needs an update", () => {
    render(<FreshnessLine bank={{ source: "manual", stale: true, staleReason: "manual_old" }} fetchedAt={ago(9 * DAY)} now={NOW} />);
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toBe("Needs an update · Updated 9 d ago");
    expect(line.getAttribute("data-reason")).toBe("manual_old");
  });

  it("a stale reason it does not know says 'Out of date', never another reason's words", () => {
    render(<FreshnessLine bank={{ source: "manual", stale: true, staleReason: null }} fetchedAt={ago(3 * HOUR)} now={NOW} />);
    const line = screen.getByTestId("text-bank-freshness-stale");
    expect(line.textContent).toBe("Out of date · Updated 3 h ago");
    expect(line.getAttribute("data-reason")).toBe("unknown");
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
