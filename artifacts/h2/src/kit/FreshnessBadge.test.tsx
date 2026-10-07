import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FreshnessBadge, type BankFreshness } from "./FreshnessBadge";

afterEach(cleanup);

const NOW = new Date("2026-10-07T14:00:00Z");
const fresh: BankFreshness = {
  source: "plaid",
  asOfDate: "2026-10-07T13:48:00Z",
  lastContactAt: null,
  stale: false,
  staleReason: null,
};

function badge() {
  return screen.getByTestId("freshness-badge");
}

describe("FreshnessBadge — a word for how fresh the bank is, always", () => {
  it("fresh from a sync", () => {
    render(<FreshnessBadge bank={fresh} now={NOW} />);
    expect(badge().textContent).toBe("Synced 12 minutes ago");
  });

  it("fresh by hand", () => {
    render(<FreshnessBadge bank={{ ...fresh, source: "manual" }} now={NOW} />);
    expect(badge().textContent).toBe("Set by hand 12 minutes ago");
  });

  it("each stale reason has its own words, and the last time the bank answered", () => {
    const cases: Array<[BankFreshness["staleReason"], RegExp]> = [
      ["refresh_failed", /Refresh failed.*last updated 3 days ago/],
      ["old", /Out of date.*last updated 3 days ago/],
      ["manual_old", /Needs an update.*set by hand 3 days ago/],
    ];
    for (const [reason, words] of cases) {
      render(
        <FreshnessBadge
          bank={{ ...fresh, asOfDate: "2026-10-04T13:00:00Z", stale: true, staleReason: reason }}
          now={NOW}
        />,
      );
      expect(badge().textContent).toMatch(words);
      expect(badge().getAttribute("data-reason")).toBe(reason);
      cleanup();
    }
  });

  it("'last updated' is the later of the snapshot and the last contact", () => {
    render(
      <FreshnessBadge
        bank={{ ...fresh, asOfDate: "2026-10-01T13:00:00Z", lastContactAt: "2026-10-06T13:00:00Z", stale: true, staleReason: "old" }}
        now={NOW}
      />,
    );
    expect(badge().textContent).toContain("last updated yesterday");
  });

  it("an unknown reason never borrows another reason's words", () => {
    render(
      <FreshnessBadge
        bank={{ ...fresh, stale: true, staleReason: "new_reason" as BankFreshness["staleReason"] }}
        now={NOW}
      />,
    );
    expect(badge().textContent).toMatch(/^May be out of date/);
  });

  it("says Updating while a newer copy is on its way", () => {
    render(<FreshnessBadge bank={fresh} state="refreshing" now={NOW} />);
    expect(badge().textContent).toBe("Updating");
  });

  it("no bank yet, and a failed load, are said plainly", () => {
    render(<FreshnessBadge bank={{ ...fresh, source: null, asOfDate: null }} now={NOW} />);
    expect(badge().textContent).toBe("No bank balance yet");
    cleanup();
    render(<FreshnessBadge bank={undefined} state="failed" now={NOW} />);
    expect(badge().textContent).toBe("Not loaded");
  });
});
