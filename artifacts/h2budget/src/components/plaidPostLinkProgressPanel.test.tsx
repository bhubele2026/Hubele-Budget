import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("@workspace/api-client-react", () => ({
  useCreatePlaidLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  useExchangePlaidPublicToken: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePlaidUpdateLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  useListPlaidItems: () => ({ data: [], isLoading: false }),
  useListPlaidLiabilityAccounts: () => ({ data: [], isLoading: false }),
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  getListPlaidLiabilityAccountsQueryKey: () => ["/api/plaid/liabilities"],
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-plaid-sync", () => ({
  usePlaidSync: () => ({ runSync: vi.fn(), isPending: false }),
  formatPlaidErrorForDisplay: (s: string) => s,
}));
vi.mock("react-plaid-link", () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false }),
}));

import {
  PostLinkProgressPanel,
  formatImportedDateRange,
  type PostLinkStatus,
} from "./plaid-link-button";

function makeStatus(overrides: Partial<PostLinkStatus>): PostLinkStatus {
  return {
    phase: "ready",
    attempt: 3,
    totalAttempts: 3,
    institutionName: "Chase",
    added: 12,
    modified: 0,
    errorMessage: null,
    importedDateRange: null,
    ...overrides,
  };
}

beforeEach(() => {
  // Pin the clock to mid-May 2026 so the "current month" gate is
  // deterministic — the seed scenario this task fixes.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-07T12:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("(#403) formatImportedDateRange", () => {
  it("returns a single date when min === max", () => {
    expect(formatImportedDateRange("2026-04-15", "2026-04-15")).toBe("Apr 15");
  });
  it("returns 'Mon D – Mon D' for a span", () => {
    expect(formatImportedDateRange("2026-03-05", "2026-04-28")).toBe(
      "Mar 5 – Apr 28",
    );
  });
});

describe("(#403) PostLinkProgressPanel — imported date range caption", () => {
  it("renders 'Imported Mar 5 – May 4 from Chase.' on a healthy ready state with a span that reaches the current month", () => {
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "ready",
          added: 80,
          importedDateRange: { min: "2026-03-05", max: "2026-05-04" },
        })}
        onDismiss={() => {}}
      />,
    );
    const detail = screen.getByTestId("text-post-link-detail");
    expect(detail.textContent).toContain("Imported Mar 5 – May 4 from Chase.");
    expect(detail.textContent).not.toContain("Still importing recent activity");
  });

  it("falls back to the generic 'Imported from <bank>.' caption when no date range is known", () => {
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "ready",
          added: 5,
          importedDateRange: null,
        })}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId("text-post-link-detail").textContent).toContain(
      "Imported from Chase.",
    );
  });

  it("shows the 'Still importing recent activity' hint when the newest inserted row is older than today's calendar month", () => {
    // The seed Chase scenario: 95 April rows landed but May (the
    // current month) is empty — exactly what the user reported. The
    // panel must not silently say "Ready" without flagging it.
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "ready",
          added: 95,
          importedDateRange: { min: "2026-04-01", max: "2026-04-30" },
        })}
        onDismiss={() => {}}
      />,
    );
    const detail = screen.getByTestId("text-post-link-detail");
    expect(detail.textContent).toContain(
      "Imported Apr 1 – Apr 30 from Chase. Still importing recent activity",
    );
  });

  it("does NOT show the 'still importing' hint when the inserted window already reaches into the current month", () => {
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "ready",
          added: 100,
          importedDateRange: { min: "2026-04-01", max: "2026-05-06" },
        })}
        onDismiss={() => {}}
      />,
    );
    const detail = screen.getByTestId("text-post-link-detail");
    expect(detail.textContent).toContain("Imported Apr 1 – May 6 from Chase.");
    expect(detail.textContent).not.toContain("Still importing recent activity");
  });

  it("(#408) suppresses the green Ready pill when the linked item still has lastSyncErrorCode set", () => {
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "ready",
          added: 12,
          itemErrorCode: "ITEM_LOGIN_REQUIRED",
        })}
        onDismiss={() => {}}
      />,
    );
    const title = screen.getByTestId("text-post-link-title");
    expect(title.textContent).toContain("Chase still needs reconnecting");
    expect(title.textContent).not.toContain("Ready");
    // Deep-link to imported transactions must be hidden when the
    // user is being told to reconnect — clicking it would lie about
    // the state of the import.
    expect(
      screen.queryByTestId("link-post-link-view-transactions"),
    ).toBeNull();
  });

  it("(#408) suppresses the green Ready pill when itemErrorKind is 'reauth' even with no code", () => {
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "ready",
          added: 5,
          itemErrorKind: "reauth",
        })}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByTestId("text-post-link-title").textContent,
    ).toContain("still needs reconnecting");
  });

  it("(#408) renders 'No new transactions since <date>' when added=0/modified=0 with a known lastBankTxOn", () => {
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "ready",
          added: 0,
          modified: 0,
          lastBankTxOn: "2026-05-04",
        })}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByTestId("text-post-link-title").textContent,
    ).toContain("No new transactions since May 4");
  });

  it("(#408) falls back to 'No new transactions yet' when nothing added and no lastBankTxOn is known", () => {
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "ready",
          added: 0,
          modified: 0,
        })}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByTestId("text-post-link-title").textContent,
    ).toContain("No new transactions yet");
  });

  it("does NOT show the 'still importing' hint on non-ready phases (preparing / polling)", () => {
    // The hint is only meaningful as a qualifier on a successful
    // import — during polling the user already sees the spinner.
    render(
      <PostLinkProgressPanel
        status={makeStatus({
          phase: "polling",
          attempt: 2,
          added: 0,
          importedDateRange: { min: "2026-04-01", max: "2026-04-30" },
        })}
        onDismiss={() => {}}
      />,
    );
    const detail = screen.getByTestId("text-post-link-detail");
    expect(detail.textContent).not.toContain("Still importing recent activity");
  });
});
