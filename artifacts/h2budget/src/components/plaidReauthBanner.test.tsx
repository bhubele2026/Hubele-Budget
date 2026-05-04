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
  PlaidReauthBannerView,
  findPlaidItemsNeedingReauth,
} from "./plaid-reauth-banner";
import {
  plaidReauthReason,
  formatPlaidConsentExpirationDate,
} from "./plaid-reconnect-button";
import type { PlaidItemDetail } from "@workspace/api-client-react";

function makeItem(overrides: Partial<PlaidItemDetail> & { id: string }): PlaidItemDetail {
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
    accounts: [],
    ...overrides,
  } as PlaidItemDetail;
}

function renderBanner(items: PlaidItemDetail[] | null | undefined) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <PlaidReauthBannerView items={items} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
});

describe("(#228) plaidReauthReason", () => {
  it("returns the expired-login copy for ITEM_LOGIN_REQUIRED", () => {
    expect(plaidReauthReason("ITEM_LOGIN_REQUIRED")).toMatch(/saved login expired/i);
  });
  it("returns the about-to-expire copy for PENDING_EXPIRATION", () => {
    expect(plaidReauthReason("PENDING_EXPIRATION")).toMatch(/about to expire/i);
  });
  it("returns the disconnect copy for PENDING_DISCONNECT", () => {
    expect(plaidReauthReason("PENDING_DISCONNECT")).toMatch(/disconnect/i);
  });
  it("falls back to a generic re-authorize message for unknown / null codes", () => {
    expect(plaidReauthReason(null)).toMatch(/re-authorize/i);
    expect(plaidReauthReason(undefined)).toMatch(/re-authorize/i);
    expect(plaidReauthReason("SOMETHING_NEW")).toMatch(/re-authorize/i);
  });
});

describe("(#238) plaidReauthReason — dated PENDING_* copy", () => {
  it("inlines the cutoff date and institution for PENDING_DISCONNECT", () => {
    // The date in the message must literally name the day the bank
    // dies — that's the whole point of #238 (no more vague 'soon').
    const out = plaidReauthReason("PENDING_DISCONNECT", {
      consentExpirationAt: "2026-05-21T15:30:00.000Z",
      institutionName: "Chase",
    });
    expect(out).toContain("Chase will disconnect on");
    expect(out).toMatch(/May\s*21/);
    expect(out).toContain("reconnect now");
    // The vague pre-#238 fallback copy must not leak through when we
    // have a real date — otherwise the user sees both.
    expect(out).not.toContain("soon");
  });

  it("inlines the cutoff date for PENDING_EXPIRATION (verb 'expire' not 'disconnect')", () => {
    const out = plaidReauthReason("PENDING_EXPIRATION", {
      consentExpirationAt: "2026-06-04T00:00:00.000Z",
      institutionName: "Bank of America",
    });
    expect(out).toContain("Bank of America will expire on");
    expect(out).toMatch(/Jun\s*[34]/); // Tolerate UTC→local day shift in CI tz.
    expect(out).not.toContain("about to expire");
  });

  it("falls back to 'This bank' when institutionName is empty", () => {
    const out = plaidReauthReason("PENDING_DISCONNECT", {
      consentExpirationAt: "2026-05-21T15:30:00.000Z",
      institutionName: null,
    });
    expect(out).toContain("This bank will disconnect on");
  });

  it("falls back to the date-less per-code copy when consentExpirationAt is missing", () => {
    // The whole point of the fallback: not every Plaid item has a
    // consent_expiration_time (most non-OAuth banks). The pre-#238 vague
    // copy is what the user must see when we have no date.
    const out = plaidReauthReason("PENDING_DISCONNECT", {
      consentExpirationAt: null,
      institutionName: "Chase",
    });
    expect(out).toMatch(/disconnect this bank soon/i);
    expect(out).not.toMatch(/will disconnect on/i);
  });

  it("falls back to date-less copy when consentExpirationAt is unparseable", () => {
    const out = plaidReauthReason("PENDING_EXPIRATION", {
      consentExpirationAt: "not-a-date",
      institutionName: "Chase",
    });
    expect(out).toMatch(/about to expire/i);
  });

  it("ignores consentExpirationAt for non-dated codes (e.g. ITEM_LOGIN_REQUIRED)", () => {
    // ITEM_LOGIN_REQUIRED is unrelated to the consent cutoff — passing a
    // date through must NOT switch the copy to "will disconnect on".
    const out = plaidReauthReason("ITEM_LOGIN_REQUIRED", {
      consentExpirationAt: "2026-05-21T15:30:00.000Z",
      institutionName: "Chase",
    });
    expect(out).toMatch(/saved login expired/i);
    expect(out).not.toMatch(/will disconnect on/i);
  });
});

describe("(#238) formatPlaidConsentExpirationDate", () => {
  it("returns null for null / undefined / empty / unparseable input so callers can fall back", () => {
    expect(formatPlaidConsentExpirationDate(null)).toBeNull();
    expect(formatPlaidConsentExpirationDate(undefined)).toBeNull();
    expect(formatPlaidConsentExpirationDate("")).toBeNull();
    expect(formatPlaidConsentExpirationDate("not-a-date")).toBeNull();
  });

  it("omits the year when the cutoff is in the same calendar year as 'now'", () => {
    const out = formatPlaidConsentExpirationDate(
      "2026-05-21T15:30:00.000Z",
      new Date("2026-05-04T00:00:00.000Z"),
    );
    expect(out).toMatch(/May\s*2[01]/);
    // No year noise when same year → keeps the banner copy short.
    expect(out).not.toMatch(/2026/);
  });

  it("includes the year when the cutoff falls in a later calendar year", () => {
    // A year-out cutoff would be ambiguous without "2027" — the user
    // could read "May 21" as next month otherwise.
    const out = formatPlaidConsentExpirationDate(
      "2027-05-21T15:30:00.000Z",
      new Date("2026-05-04T00:00:00.000Z"),
    );
    expect(out).toMatch(/2027/);
  });
});

describe("(#217) findPlaidItemsNeedingReauth", () => {
  it("returns empty when no item has a re-auth code", () => {
    const summary = findPlaidItemsNeedingReauth([
      makeItem({ id: "i1" }),
      makeItem({ id: "i2", lastSyncErrorCode: "RATE_LIMIT_EXCEEDED" }),
    ]);
    expect(summary.items).toEqual([]);
    expect(summary.worst).toBeNull();
  });

  it("includes any item whose lastSyncErrorCode is a Plaid re-auth code", () => {
    const summary = findPlaidItemsNeedingReauth([
      makeItem({ id: "i1", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
      makeItem({
        id: "i2",
        institutionName: "Bank of America",
        lastSyncErrorCode: "PENDING_EXPIRATION",
      }),
      makeItem({
        id: "i3",
        institutionName: "Amex",
        lastSyncErrorCode: "PENDING_DISCONNECT",
      }),
    ]);
    expect(summary.items).toHaveLength(3);
    // Sorted alphabetically by institution name → Amex first.
    expect(summary.worst?.id).toBe("i3");
    expect(summary.items.map((i) => i.institutionName)).toEqual([
      "Amex",
      "Bank of America",
      "Chase",
    ]);
  });

  it("treats null / undefined item lists as empty", () => {
    expect(findPlaidItemsNeedingReauth(null).worst).toBeNull();
    expect(findPlaidItemsNeedingReauth(undefined).items).toEqual([]);
  });
});

describe("(#217) PlaidReauthBannerView", () => {
  it("renders nothing when no item is in re-auth", () => {
    renderBanner([makeItem({ id: "i1" })]);
    expect(screen.queryByTestId("banner-plaid-reauth")).toBeNull();
  });

  it("renders nothing for an empty / undefined item list", () => {
    renderBanner(undefined);
    expect(screen.queryByTestId("banner-plaid-reauth")).toBeNull();
  });

  it("does NOT depend on the item being tied to a debt — works for plain checking items too", () => {
    // The item below has no debt linkage at all (it's a checking account).
    // The earlier <DebtReauthBanner> would have ignored this; the new
    // banner is exactly here so the user notices.
    renderBanner([
      makeItem({
        id: "i-checking",
        institutionName: "Chase",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        accounts: [
          {
            id: "a1",
            accountId: "ext-a1",
            name: "Chase Checking",
            officialName: null,
            mask: "1234",
            type: "depository",
            subtype: "checking",
          },
        ],
      }),
    ]);
    const banner = screen.getByTestId("banner-plaid-reauth");
    expect(banner.textContent).toContain("Chase needs reconnecting");
    expect(
      screen.getByTestId("button-plaid-reconnect-i-checking"),
    ).toBeTruthy();
  });

  it("uses 'and N more banks' wording when several institutions are failing", () => {
    renderBanner([
      makeItem({ id: "i1", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
      makeItem({
        id: "i2",
        institutionName: "Bank of America",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
      makeItem({
        id: "i3",
        institutionName: "Amex",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
    ]);
    const banner = screen.getByTestId("banner-plaid-reauth");
    expect(banner.textContent).toContain(
      "Amex and 2 more banks need reconnecting",
    );
    // Reconnect button targets the alphabetically-first institution (Amex).
    expect(screen.getByTestId("button-plaid-reconnect-i3")).toBeTruthy();
    expect(screen.queryByTestId("button-plaid-reconnect-i1")).toBeNull();
  });

  it("falls back to 'Your bank' when institutionName is missing", () => {
    renderBanner([
      makeItem({
        id: "i1",
        institutionName: null,
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
    ]);
    const banner = screen.getByTestId("banner-plaid-reauth");
    expect(banner.textContent).toContain("Your bank needs reconnecting");
  });

  it("hides itself when the user clicks the dismiss button", () => {
    renderBanner([
      makeItem({ id: "i1", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
    ]);
    expect(screen.getByTestId("banner-plaid-reauth")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-plaid-reauth-dismiss"));
    expect(screen.queryByTestId("banner-plaid-reauth")).toBeNull();
  });

  it("re-shows the banner when a NEW institution starts failing after dismissal", () => {
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PlaidReauthBannerView
          items={[
            makeItem({ id: "i1", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
          ]}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("button-plaid-reauth-dismiss"));
    expect(screen.queryByTestId("banner-plaid-reauth")).toBeNull();

    // A second institution starts failing — banner reappears even though
    // the user dismissed the earlier snapshot.
    rerender(
      <QueryClientProvider client={qc}>
        <PlaidReauthBannerView
          items={[
            makeItem({ id: "i1", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
            makeItem({
              id: "i2",
              institutionName: "Bank of America",
              lastSyncErrorCode: "PENDING_EXPIRATION",
            }),
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("banner-plaid-reauth")).toBeTruthy();
  });

  it("(#228) shows the per-code reason in the subline so the user knows why a reconnect is needed", () => {
    renderBanner([
      makeItem({
        id: "i-login",
        institutionName: "Chase",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
    ]);
    const subline = screen.getByTestId("text-plaid-reauth-subline");
    expect(subline.textContent).toContain("Your saved login expired");
    // Generic "may be out of date" copy from the pre-#228 banner is gone.
    expect(subline.textContent).not.toContain("may be out of date");
  });

  it("(#228) uses the worst item's code (alphabetical pick) for the subline when several items are failing", () => {
    renderBanner([
      makeItem({
        id: "i-chase",
        institutionName: "Chase",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
      // Amex sorts first, so its PENDING_DISCONNECT reason wins the subline.
      makeItem({
        id: "i-amex",
        institutionName: "Amex",
        lastSyncErrorCode: "PENDING_DISCONNECT",
      }),
    ]);
    const subline = screen.getByTestId("text-plaid-reauth-subline");
    expect(subline.textContent).toContain(plaidReauthReason("PENDING_DISCONNECT"));
    expect(subline.textContent).not.toContain(plaidReauthReason("ITEM_LOGIN_REQUIRED"));
  });

  it("(#228) shows the PENDING_EXPIRATION reason when consent is about to lapse", () => {
    renderBanner([
      makeItem({
        id: "i-pending",
        institutionName: "Chase",
        lastSyncErrorCode: "PENDING_EXPIRATION",
      }),
    ]);
    const subline = screen.getByTestId("text-plaid-reauth-subline");
    expect(subline.textContent).toContain("about to expire");
  });

  it("(#238) shows the dated PENDING_DISCONNECT cutoff in the subline when the item has consentExpirationAt", () => {
    // The whole point of #238: when Plaid actually told us the cutoff,
    // the user must see the literal day ("Chase will disconnect on
    // May 21") instead of the vague pre-#238 copy.
    renderBanner([
      makeItem({
        id: "i-pending-dc",
        institutionName: "Chase",
        lastSyncErrorCode: "PENDING_DISCONNECT",
        consentExpirationAt: "2026-05-21T15:30:00.000Z",
      }),
    ]);
    const subline = screen.getByTestId("text-plaid-reauth-subline");
    expect(subline.textContent).toContain("Chase will disconnect on");
    expect(subline.textContent).toMatch(/May\s*2[01]/);
    // The vague pre-#238 fallback must not also be rendered.
    expect(subline.textContent).not.toContain(
      "Plaid will disconnect this bank soon",
    );
  });

  it("(#238) keeps the date-less fallback when consentExpirationAt is null (Plaid didn't provide a date)", () => {
    renderBanner([
      makeItem({
        id: "i-pending-undated",
        institutionName: "Chase",
        lastSyncErrorCode: "PENDING_DISCONNECT",
        consentExpirationAt: null,
      }),
    ]);
    const subline = screen.getByTestId("text-plaid-reauth-subline");
    expect(subline.textContent).toContain("disconnect this bank soon");
    expect(subline.textContent).not.toMatch(/will disconnect on/i);
  });

  it("disappears once the items list reports everything healthy again", () => {
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PlaidReauthBannerView
          items={[
            makeItem({ id: "i1", lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("banner-plaid-reauth")).toBeTruthy();
    rerender(
      <QueryClientProvider client={qc}>
        <PlaidReauthBannerView
          items={[makeItem({ id: "i1", lastSyncErrorCode: null })]}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("banner-plaid-reauth")).toBeNull();
  });
});
