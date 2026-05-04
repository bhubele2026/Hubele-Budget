import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

type Item = {
  id: string;
  institutionName: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastSyncErrorCode?: string | null;
};

let plaidItems: Item[] | undefined = [];

vi.mock("@workspace/api-client-react", () => ({
  useListPlaidItems: () => ({ data: plaidItems }),
}));

// wouter's <Link> renders an <a>; we don't need real routing for these tests
// but we do need to mount the component without crashing.
vi.mock("wouter", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { DashboardReconnectBanner } from "./dashboard-reconnect-banner";

beforeEach(() => {
  cleanup();
  plaidItems = [];
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("DashboardReconnectBanner", () => {
  it("renders nothing when there are no Plaid items", () => {
    plaidItems = [];
    const { container } = render(<DashboardReconnectBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when all items are healthy", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: null,
        lastSyncErrorCode: null,
      },
    ];
    const { container } = render(<DashboardReconnectBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for non-reauth errors (e.g. RATE_LIMIT_EXCEEDED)", () => {
    plaidItems = [
      {
        id: "i-rate",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "rate limit",
        lastSyncErrorCode: "RATE_LIMIT_EXCEEDED",
      },
    ];
    const { container } = render(<DashboardReconnectBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a singular heading with the bank name when one item needs reconnect", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "login changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
    ];
    render(<DashboardReconnectBanner />);
    expect(screen.getByTestId("banner-reconnect-needed")).toBeTruthy();
    expect(screen.getByTestId("text-reconnect-heading").textContent).toBe(
      "1 bank needs reconnecting: Chase",
    );
  });

  it("shows a plural heading with comma-separated names when multiple items need reconnect", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "login changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
      {
        id: "i-2",
        institutionName: "Amex",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "expiring",
        lastSyncErrorCode: "PENDING_EXPIRATION",
      },
      {
        id: "i-3",
        institutionName: "Wells Fargo",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "disconnect pending",
        lastSyncErrorCode: "PENDING_DISCONNECT",
      },
    ];
    render(<DashboardReconnectBanner />);
    expect(screen.getByTestId("text-reconnect-heading").textContent).toBe(
      "3 banks need reconnecting: Chase, Amex, Wells Fargo",
    );
  });

  it("falls back to a generic name when the institutionName is missing", () => {
    plaidItems = [
      {
        id: "i-noname",
        institutionName: null,
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "login changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
    ];
    render(<DashboardReconnectBanner />);
    expect(screen.getByTestId("text-reconnect-heading").textContent).toBe(
      "1 bank needs reconnecting: Linked institution",
    );
  });

  it("links to the Settings page so the user can fix it there", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "login changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
    ];
    render(<DashboardReconnectBanner />);
    const link = screen.getByTestId("link-reconnect-settings") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/settings");
  });

  it("hides the banner after dismiss for the same set of broken items", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "login changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
    ];
    const { container } = render(<DashboardReconnectBanner />);
    fireEvent.click(screen.getByTestId("button-dismiss-reconnect-banner"));
    expect(container.firstChild).toBeNull();

    // A fresh mount with the same broken set should also stay dismissed
    // (signature persisted to sessionStorage).
    cleanup();
    const remount = render(<DashboardReconnectBanner />);
    expect(remount.container.firstChild).toBeNull();
  });

  it("re-shows the banner if a NEW bank breaks after a prior dismiss", () => {
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "login changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
    ];
    render(<DashboardReconnectBanner />);
    fireEvent.click(screen.getByTestId("button-dismiss-reconnect-banner"));
    cleanup();

    // Now Amex also breaks → different signature → banner returns.
    plaidItems = [
      {
        id: "i-1",
        institutionName: "Chase",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "login changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      },
      {
        id: "i-2",
        institutionName: "Amex",
        lastSyncedAt: new Date().toISOString(),
        lastSyncError: "expiring",
        lastSyncErrorCode: "PENDING_EXPIRATION",
      },
    ];
    render(<DashboardReconnectBanner />);
    expect(screen.getByTestId("banner-reconnect-needed")).toBeTruthy();
    expect(screen.getByTestId("text-reconnect-heading").textContent).toBe(
      "2 banks need reconnecting: Chase, Amex",
    );
  });
});
