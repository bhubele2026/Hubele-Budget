import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { BankSnapshotFreshness } from "./forecast";
import { formatRelativeTime } from "@/lib/utils";

// Task #285: the Forecast bank-snapshot card should reassure users that
// the hourly Plaid auto-refresh is actually running by surfacing a
// relative "last updated" timestamp, and should distinguish that from a
// manual override the user typed in themselves.

describe("formatRelativeTime — relative 'X ago' helper", () => {
  const now = new Date("2026-05-05T12:00:00.000Z");

  it("returns 'just now' for sub-30s and future-skew timestamps", () => {
    expect(formatRelativeTime("2026-05-05T11:59:50.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-05-05T12:00:30.000Z", now)).toBe("just now");
  });

  it("formats minute / hour / day / week / month / year buckets", () => {
    expect(formatRelativeTime("2026-05-05T11:48:00.000Z", now)).toBe(
      "12 minutes ago",
    );
    expect(formatRelativeTime("2026-05-05T11:59:00.000Z", now)).toBe(
      "1 minute ago",
    );
    expect(formatRelativeTime("2026-05-05T09:00:00.000Z", now)).toBe(
      "3 hours ago",
    );
    expect(formatRelativeTime("2026-05-04T12:00:00.000Z", now)).toBe("yesterday");
    expect(formatRelativeTime("2026-05-02T12:00:00.000Z", now)).toBe("3 days ago");
    expect(formatRelativeTime("2026-04-21T12:00:00.000Z", now)).toBe("2 weeks ago");
    expect(formatRelativeTime("2026-02-04T12:00:00.000Z", now)).toBe("3 months ago");
    expect(formatRelativeTime("2025-05-05T12:00:00.000Z", now)).toBe("1 year ago");
  });

  it("handles missing / invalid input safely", () => {
    expect(formatRelativeTime(null, now)).toBe("");
    expect(formatRelativeTime(undefined, now)).toBe("");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});

describe("BankSnapshotFreshness — bank balance freshness label (#285)", () => {
  afterEach(() => cleanup());
  const now = new Date("2026-05-05T12:00:00.000Z");

  it("labels Plaid auto-refreshed snapshots as auto-updated", () => {
    render(
      <BankSnapshotFreshness
        source="plaid"
        at="2026-05-05T11:48:00.000Z"
        now={now}
      />,
    );
    expect(
      screen.getByTestId("text-bank-snapshot-freshness").textContent,
    ).toBe("Last auto-updated 12 minutes ago");
  });

  it("labels user-set snapshots as manual so they aren't mistaken for auto-refresh", () => {
    render(
      <BankSnapshotFreshness
        source="manual"
        at="2026-05-05T09:00:00.000Z"
        now={now}
      />,
    );
    expect(
      screen.getByTestId("text-bank-snapshot-freshness").textContent,
    ).toBe("Set manually 3 hours ago");
  });

  it("ticks the label up roughly once a minute while mounted (#332)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:30.000Z"));
    try {
      const { unmount } = render(
        <BankSnapshotFreshness
          source="plaid"
          at="2026-05-05T11:48:00.000Z"
        />,
      );
      expect(
        screen.getByTestId("text-bank-snapshot-freshness").textContent,
      ).toBe("Last auto-updated 12 minutes ago");

      // advanceTimersByTime also moves the mocked system clock forward,
      // so 12:00:30 + 60s = 12:01:30 → 13 minutes since 11:48:00.
      act(() => {
        vi.advanceTimersByTime(60 * 1000);
      });
      expect(
        screen.getByTestId("text-bank-snapshot-freshness").textContent,
      ).toBe("Last auto-updated 13 minutes ago");

      // Unmount must clear the interval so we don't keep ticking forever.
      const before = vi.getTimerCount();
      unmount();
      expect(vi.getTimerCount()).toBe(before - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders a fresher 'just now' label after a Plaid refresh updates `at`", () => {
    const { rerender } = render(
      <BankSnapshotFreshness
        source="plaid"
        at="2026-05-05T11:00:00.000Z"
        now={now}
      />,
    );
    expect(
      screen.getByTestId("text-bank-snapshot-freshness").textContent,
    ).toBe("Last auto-updated 1 hour ago");

    // Simulate the cron tick / manual refresh writing a fresh
    // bankSnapshotAt — the card should immediately reflect it.
    rerender(
      <BankSnapshotFreshness
        source="plaid"
        at="2026-05-05T11:59:55.000Z"
        now={now}
      />,
    );
    expect(
      screen.getByTestId("text-bank-snapshot-freshness").textContent,
    ).toBe("Last auto-updated just now");
  });
});
