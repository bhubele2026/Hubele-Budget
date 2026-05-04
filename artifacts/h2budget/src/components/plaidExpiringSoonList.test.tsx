import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@workspace/api-client-react", () => ({
  useListPlaidItems: () => ({ data: [], isLoading: false }),
  useCreatePlaidUpdateLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
  getListDebtsQueryKey: () => ["/api/debts"],
  getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
  getGetForecastQueryKey: () => ["/api/forecast"],
  getGetDashboardQueryKey: () => ["/api/dashboard"],
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
  PlaidExpiringSoonListView,
  findPlaidItemsExpiringSoon,
  formatExpiringSoonRelative,
  EXPIRING_SOON_WINDOW_DAYS,
} from "./plaid-expiring-soon-list";
import type { PlaidItemDetail } from "@workspace/api-client-react";

function makeItem(
  overrides: Partial<PlaidItemDetail> & { id: string },
): PlaidItemDetail {
  return {
    itemId: `external-${overrides.id}`,
    institutionId: null,
    institutionName: "Chase",
    institutionSlug: "chase",
    lastSyncedAt: null,
    lastSyncError: null,
    lastSyncErrorCode: null,
    stillPreparing: false,
    stillPreparingSince: null,
    consentExpirationAt: null,
    accounts: [],
    ...overrides,
  } as PlaidItemDetail;
}

const NOW = new Date("2026-05-04T12:00:00.000Z");

function renderList(
  items: PlaidItemDetail[] | null | undefined,
  now: Date = NOW,
) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <PlaidExpiringSoonListView items={items} now={now} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
});

describe("(#257) findPlaidItemsExpiringSoon", () => {
  it("returns empty when no item has consentExpirationAt set", () => {
    const out = findPlaidItemsExpiringSoon(
      [makeItem({ id: "i1" }), makeItem({ id: "i2" })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("returns empty for null / undefined input", () => {
    expect(findPlaidItemsExpiringSoon(null, NOW)).toEqual([]);
    expect(findPlaidItemsExpiringSoon(undefined, NOW)).toEqual([]);
  });

  it("includes items whose cutoff is within the next 14 days", () => {
    // 7 days into the future — squarely inside the window.
    const out = findPlaidItemsExpiringSoon(
      [
        makeItem({
          id: "i1",
          consentExpirationAt: "2026-05-11T12:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].item.id).toBe("i1");
    expect(out[0].daysUntil).toBe(7);
  });

  it("excludes items whose cutoff is more than 14 days out", () => {
    // 30 days out — well past the window; alerting now would be noise.
    const out = findPlaidItemsExpiringSoon(
      [
        makeItem({
          id: "i1",
          consentExpirationAt: "2026-06-03T12:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("excludes items whose cutoff is far in the past", () => {
    // 5 days in the past — Plaid would have flipped the item into a
    // re-auth code by now; the page-top reauth banner covers it.
    const out = findPlaidItemsExpiringSoon(
      [
        makeItem({
          id: "i1",
          consentExpirationAt: "2026-04-29T12:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("tolerates a 1-day grace window for cutoffs that just rolled past", () => {
    // 12h past — the item likely has not been flipped into PENDING_DISCONNECT
    // yet, so we still want to alert.
    const out = findPlaidItemsExpiringSoon(
      [
        makeItem({
          id: "i1",
          consentExpirationAt: "2026-05-04T00:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].daysUntil).toBeLessThanOrEqual(0);
  });

  it("excludes items already in a re-auth state (covered by PlaidReauthBanner)", () => {
    // The whole point: don't double-notify the user about the same bank.
    const out = findPlaidItemsExpiringSoon(
      [
        makeItem({
          id: "i1",
          consentExpirationAt: "2026-05-11T12:00:00.000Z",
          lastSyncErrorCode: "PENDING_DISCONNECT",
        }),
        makeItem({
          id: "i2",
          consentExpirationAt: "2026-05-11T12:00:00.000Z",
          lastSyncErrorCode: "PENDING_EXPIRATION",
        }),
        makeItem({
          id: "i3",
          consentExpirationAt: "2026-05-11T12:00:00.000Z",
          lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        }),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("ignores unparseable consentExpirationAt strings", () => {
    const out = findPlaidItemsExpiringSoon(
      [makeItem({ id: "i1", consentExpirationAt: "not-a-date" })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("sorts soonest-first so the most urgent reconnect is at the top", () => {
    const out = findPlaidItemsExpiringSoon(
      [
        makeItem({
          id: "later",
          institutionName: "Bank of America",
          consentExpirationAt: "2026-05-15T12:00:00.000Z",
        }),
        makeItem({
          id: "soonest",
          institutionName: "Chase",
          consentExpirationAt: "2026-05-06T12:00:00.000Z",
        }),
        makeItem({
          id: "middle",
          institutionName: "Amex",
          consentExpirationAt: "2026-05-10T12:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(out.map((e) => e.item.id)).toEqual(["soonest", "middle", "later"]);
  });

  it("breaks ties on identical cutoffs alphabetically by institution name", () => {
    const out = findPlaidItemsExpiringSoon(
      [
        makeItem({
          id: "chase",
          institutionName: "Chase",
          consentExpirationAt: "2026-05-11T12:00:00.000Z",
        }),
        makeItem({
          id: "amex",
          institutionName: "Amex",
          consentExpirationAt: "2026-05-11T12:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(out.map((e) => e.item.institutionName)).toEqual(["Amex", "Chase"]);
  });

  it("respects a custom withinDays window", () => {
    // Tighten to 3 days — the 7-day-out item should now drop off.
    const out = findPlaidItemsExpiringSoon(
      [
        makeItem({
          id: "i1",
          consentExpirationAt: "2026-05-11T12:00:00.000Z",
        }),
        makeItem({
          id: "i2",
          consentExpirationAt: "2026-05-06T12:00:00.000Z",
        }),
      ],
      NOW,
      3,
    );
    expect(out.map((e) => e.item.id)).toEqual(["i2"]);
  });

  it("defaults the window to 14 days", () => {
    expect(EXPIRING_SOON_WINDOW_DAYS).toBe(14);
  });
});

describe("(#257) formatExpiringSoonRelative", () => {
  it("renders 'expired' for past-due rows", () => {
    expect(formatExpiringSoonRelative(-1)).toBe("expired");
  });
  it("renders 'expires today' at zero days", () => {
    expect(formatExpiringSoonRelative(0)).toBe("expires today");
  });
  it("renders 'expires tomorrow' at one day", () => {
    expect(formatExpiringSoonRelative(1)).toBe("expires tomorrow");
  });
  it("renders 'expires in N days' for N > 1", () => {
    expect(formatExpiringSoonRelative(7)).toBe("expires in 7 days");
  });
});

describe("(#257) PlaidExpiringSoonListView", () => {
  it("renders nothing when no item is inside the window", () => {
    renderList([makeItem({ id: "i1" })]);
    expect(screen.queryByTestId("alerts-plaid-expiring-soon")).toBeNull();
  });

  it("renders nothing for a null / undefined item list", () => {
    renderList(undefined);
    expect(screen.queryByTestId("alerts-plaid-expiring-soon")).toBeNull();
  });

  it("renders one row per affected item with name, date, and Reconnect", () => {
    renderList([
      makeItem({
        id: "i-chase",
        institutionName: "Chase",
        consentExpirationAt: "2026-05-11T12:00:00.000Z",
      }),
      makeItem({
        id: "i-boa",
        institutionName: "Bank of America",
        consentExpirationAt: "2026-05-08T12:00:00.000Z",
      }),
    ]);
    const alerts = screen.getByTestId("alerts-plaid-expiring-soon");
    expect(alerts).toBeTruthy();
    expect(
      screen.getByTestId("text-plaid-expiring-soon-headline").textContent,
    ).toContain("2 bank connections");
    expect(screen.getByTestId("row-plaid-expiring-i-chase")).toBeTruthy();
    expect(screen.getByTestId("row-plaid-expiring-i-boa")).toBeTruthy();
    // One Reconnect button per row, each targeting its own item.
    expect(screen.getByTestId("button-plaid-reconnect-i-chase")).toBeTruthy();
    expect(screen.getByTestId("button-plaid-reconnect-i-boa")).toBeTruthy();
  });

  it("uses singular headline when exactly one item is affected", () => {
    renderList([
      makeItem({
        id: "i1",
        institutionName: "Chase",
        consentExpirationAt: "2026-05-11T12:00:00.000Z",
      }),
    ]);
    expect(
      screen.getByTestId("text-plaid-expiring-soon-headline").textContent,
    ).toContain("1 bank connection is about to expire");
  });

  it("includes the dated subline naming the cutoff and relative time", () => {
    renderList([
      makeItem({
        id: "i1",
        institutionName: "Chase",
        consentExpirationAt: "2026-05-11T12:00:00.000Z",
      }),
    ]);
    const subline = screen.getByTestId("text-plaid-expiring-subline-i1");
    // The literal date — not vague "soon" copy — is the whole point.
    expect(subline.textContent).toMatch(/May\s*1[01]/);
    expect(subline.textContent).toContain("expires in 7 days");
  });

  it("falls back to 'Your bank' when institutionName is missing", () => {
    renderList([
      makeItem({
        id: "i1",
        institutionName: null,
        consentExpirationAt: "2026-05-11T12:00:00.000Z",
      }),
    ]);
    const row = screen.getByTestId("row-plaid-expiring-i1");
    expect(row.textContent).toContain("Your bank");
  });

  it("hides itself when the user clicks the dismiss button", () => {
    renderList([
      makeItem({
        id: "i1",
        consentExpirationAt: "2026-05-11T12:00:00.000Z",
      }),
    ]);
    expect(screen.getByTestId("alerts-plaid-expiring-soon")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-plaid-expiring-soon-dismiss"));
    expect(screen.queryByTestId("alerts-plaid-expiring-soon")).toBeNull();
  });

  it("re-shows the alerts when a NEW bank enters the window after dismissal", () => {
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PlaidExpiringSoonListView
          items={[
            makeItem({
              id: "i1",
              consentExpirationAt: "2026-05-11T12:00:00.000Z",
            }),
          ]}
          now={NOW}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("button-plaid-expiring-soon-dismiss"));
    expect(screen.queryByTestId("alerts-plaid-expiring-soon")).toBeNull();

    rerender(
      <QueryClientProvider client={qc}>
        <PlaidExpiringSoonListView
          items={[
            makeItem({
              id: "i1",
              consentExpirationAt: "2026-05-11T12:00:00.000Z",
            }),
            makeItem({
              id: "i2",
              institutionName: "Bank of America",
              consentExpirationAt: "2026-05-13T12:00:00.000Z",
            }),
          ]}
          now={NOW}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("alerts-plaid-expiring-soon")).toBeTruthy();
  });

  it("auto-dismisses when the user re-consents and the cutoff rolls past the threshold", () => {
    // The point of the 'done' criterion: once consentExpirationAt
    // moves past the 14-day window (because the user re-authorized
    // and the daily refresh wrote a fresh, far-future cutoff), the
    // alerts disappear without any user dismissal.
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PlaidExpiringSoonListView
          items={[
            makeItem({
              id: "i1",
              consentExpirationAt: "2026-05-11T12:00:00.000Z",
            }),
          ]}
          now={NOW}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("alerts-plaid-expiring-soon")).toBeTruthy();
    rerender(
      <QueryClientProvider client={qc}>
        <PlaidExpiringSoonListView
          items={[
            makeItem({
              id: "i1",
              // Re-consent pushed the cutoff out 90 days — well past the window.
              consentExpirationAt: "2026-08-04T12:00:00.000Z",
            }),
          ]}
          now={NOW}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("alerts-plaid-expiring-soon")).toBeNull();
  });

  it("excludes items that are already in PlaidReauthBanner territory", () => {
    // PENDING_DISCONNECT items are surfaced by <PlaidReauthBanner>.
    // Surfacing them here too would double-notify on the dashboard.
    renderList([
      makeItem({
        id: "i-already-flagged",
        institutionName: "Chase",
        consentExpirationAt: "2026-05-11T12:00:00.000Z",
        lastSyncErrorCode: "PENDING_DISCONNECT",
      }),
    ]);
    expect(screen.queryByTestId("alerts-plaid-expiring-soon")).toBeNull();
  });
});
