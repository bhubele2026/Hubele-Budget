import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@workspace/api-client-react", () => ({
  useListPlaidLiabilityAccounts: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  useLinkDebtToPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useUnlinkDebtFromPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshDebtFromPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePlaidUpdateLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePlaidLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  useExchangePlaidPublicToken: () => ({ mutate: vi.fn(), isPending: false }),
  getListDebtsQueryKey: () => ["/api/debts"],
  getListPlaidLiabilityAccountsQueryKey: () => ["/api/plaid/liability-accounts"],
  getGetBillsSummaryQueryKey: () => ["/api/bills/summary"],
  getGetForecastQueryKey: () => ["/api/forecast"],
  getGetDashboardQueryKey: () => ["/api/dashboard"],
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
  listPlaidLiabilityAccounts: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-plaid-sync", () => ({
  usePlaidSync: () => ({ runSync: vi.fn(), isPending: false }),
  formatPlaidErrorForDisplay: (s: string) => s,
}));
vi.mock("react-plaid-link", () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false }),
}));
vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));

import { DebtReauthBanner, findDebtsNeedingReauth } from "./debt-plaid-link";
import type { Debt } from "@workspace/api-client-react";

function makeDebt(overrides: Partial<Debt> & { id: string }): Debt {
  return {
    name: "Visa",
    balance: "1000",
    apr: "0.25",
    minPayment: "30",
    payment: "30",
    status: "active",
    sortOrder: 1,
    balanceSource: "plaid",
    aprSource: "plaid",
    minPaymentSource: "plaid",
    plaidAccountId: "acct-1",
    plaidLastSyncedAt: null,
    plaidLastSyncError: null,
    plaidLastSyncErrorCode: null,
    plaidAccount: {
      id: "acct-1",
      itemId: "item-chase",
      name: "Visa",
      mask: "1234",
      type: "credit",
      subtype: "credit card",
      liabilityKind: "credit",
      institutionName: "Chase",
      institutionSlug: "chase",
    },
    ...overrides,
  } as Debt;
}

function renderBanner(debts: Debt[] | null | undefined) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <DebtReauthBanner debts={debts} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
});

describe("(#211) findDebtsNeedingReauth", () => {
  it("returns empty when no debts have a re-auth code", () => {
    const summary = findDebtsNeedingReauth([
      makeDebt({ id: "d1" }),
      makeDebt({ id: "d2", plaidLastSyncErrorCode: "RATE_LIMIT_EXCEEDED" }),
    ]);
    expect(summary.totalDebts).toBe(0);
    expect(summary.worst).toBeNull();
    expect(summary.institutions).toEqual([]);
  });

  it("groups affected debts by parent itemId and ranks worst-first", () => {
    const summary = findDebtsNeedingReauth([
      makeDebt({
        id: "d1",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
      makeDebt({
        id: "d2",
        plaidLastSyncErrorCode: "PENDING_EXPIRATION",
      }),
      makeDebt({
        id: "d3",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        plaidAccount: {
          id: "acct-2",
          itemId: "item-bofa",
          name: "Card",
          mask: "9999",
          type: "credit",
          subtype: "credit card",
          liabilityKind: "credit",
          institutionName: "Bank of America",
          institutionSlug: "bofa",
        },
      }),
    ]);
    expect(summary.totalDebts).toBe(3);
    expect(summary.institutions).toHaveLength(2);
    // Chase has 2 affected debts → ranks first.
    expect(summary.worst?.itemId).toBe("item-chase");
    expect(summary.worst?.debts).toHaveLength(2);
  });

  it("ignores re-auth debts that lack plaidAccount.itemId (defensive)", () => {
    const summary = findDebtsNeedingReauth([
      makeDebt({
        id: "d1",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        plaidAccount: {
          id: "acct-1",
          itemId: null,
          name: "Visa",
          mask: "1234",
          type: "credit",
          subtype: "credit card",
          liabilityKind: "credit",
          institutionName: "Chase",
          institutionSlug: "chase",
        },
      }),
    ]);
    expect(summary.totalDebts).toBe(0);
    expect(summary.worst).toBeNull();
  });
});

describe("(#211) DebtReauthBanner", () => {
  it("renders nothing when no debts need reconnecting", () => {
    renderBanner([makeDebt({ id: "d1" })]);
    expect(screen.queryByTestId("banner-debt-reauth")).toBeNull();
  });

  it("renders nothing for an empty / undefined debt list", () => {
    renderBanner(undefined);
    expect(screen.queryByTestId("banner-debt-reauth")).toBeNull();
  });

  it("names the institution and offers a Reconnect button when one item is in re-auth", () => {
    renderBanner([
      makeDebt({
        id: "d1",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
      makeDebt({
        id: "d2",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
    ]);
    const banner = screen.getByTestId("banner-debt-reauth");
    expect(banner.textContent).toContain("Chase needs reconnecting");
    // (#228) The debt-impact line keeps the count + "out of date" copy and
    // now lives in its own slot so the per-code reason can occupy the
    // primary subline.
    const impact = screen.getByTestId("text-debt-reauth-impact");
    expect(impact.textContent).toContain("2 debts may be out of date");
    expect(impact.textContent).toContain("balance, APR, and minimum payment");
    // Reconnect button is keyed off the parent item id.
    expect(screen.getByTestId("button-plaid-reconnect-item-chase")).toBeTruthy();
  });

  it("uses singular wording when only one debt is affected", () => {
    renderBanner([
      makeDebt({ id: "d1", plaidLastSyncErrorCode: "PENDING_EXPIRATION" }),
    ]);
    const banner = screen.getByTestId("banner-debt-reauth");
    expect(banner.textContent).toContain("Chase needs reconnecting");
    const impact = screen.getByTestId("text-debt-reauth-impact");
    expect(impact.textContent).toContain("1 debt may be out of date");
  });

  it("(#228) shows the per-code reason in the subline so the user knows why a reconnect is needed", () => {
    renderBanner([
      makeDebt({ id: "d1", plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
    ]);
    const subline = screen.getByTestId("text-debt-reauth-subline");
    expect(subline.textContent).toContain("Your saved login expired");
  });

  it("(#228) shows a different reason for PENDING_DISCONNECT (vs. ITEM_LOGIN_REQUIRED)", () => {
    renderBanner([
      makeDebt({ id: "d1", plaidLastSyncErrorCode: "PENDING_DISCONNECT" }),
    ]);
    const subline = screen.getByTestId("text-debt-reauth-subline");
    expect(subline.textContent).toContain("disconnect");
    expect(subline.textContent).not.toContain("Your saved login expired");
  });

  it("(#228) findDebtsNeedingReauth captures the parent item's lastSyncErrorCode", () => {
    const summary = findDebtsNeedingReauth([
      makeDebt({ id: "d1", plaidLastSyncErrorCode: "PENDING_EXPIRATION" }),
    ]);
    expect(summary.worst?.lastSyncErrorCode).toBe("PENDING_EXPIRATION");
  });

  it("targets the worst-affected institution and mentions the rest", () => {
    renderBanner([
      makeDebt({ id: "d1", plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
      makeDebt({ id: "d2", plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
      makeDebt({
        id: "d3",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        plaidAccount: {
          id: "acct-2",
          itemId: "item-bofa",
          name: "Card",
          mask: "9999",
          type: "credit",
          subtype: "credit card",
          liabilityKind: "credit",
          institutionName: "Bank of America",
          institutionSlug: "bofa",
        },
      }),
    ]);
    const banner = screen.getByTestId("banner-debt-reauth");
    expect(banner.textContent).toContain("Chase and 1 more bank need reconnecting");
    expect(banner.textContent).toContain("3 debts may be out of date");
    // The Reconnect button targets Chase (2 affected debts, the worst).
    expect(screen.getByTestId("button-plaid-reconnect-item-chase")).toBeTruthy();
    expect(screen.queryByTestId("button-plaid-reconnect-item-bofa")).toBeNull();
  });

  it("falls back to 'Your bank' when institutionName is missing", () => {
    renderBanner([
      makeDebt({
        id: "d1",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        plaidAccount: {
          id: "acct-1",
          itemId: "item-mystery",
          name: "Visa",
          mask: "1234",
          type: "credit",
          subtype: "credit card",
          liabilityKind: "credit",
          institutionName: null,
          institutionSlug: null,
        },
      }),
    ]);
    const banner = screen.getByTestId("banner-debt-reauth");
    expect(banner.textContent).toContain("Your bank needs reconnecting");
  });

  it("(#320) shows the consent-refresh failure inline so a stale disconnect date is visible from the debt banner", () => {
    // Same goal as the page-top PlaidReauthBanner: when the
    // disconnect-date check itself has been failing, the dated
    // 'Chase will disconnect on …' subline could be reading off a
    // stale cutoff. Surface that here so a user looking only at the
    // debts page can tell.
    renderBanner([
      makeDebt({
        id: "d1",
        plaidLastSyncErrorCode: "PENDING_DISCONNECT",
        plaidConsentExpirationAt: "2026-05-21T15:30:00.000Z",
        plaidConsentExpirationLastRefreshError: "ITEM_LOGIN_REQUIRED",
      } as Partial<Debt> & { id: string }),
    ]);
    const note = screen.getByTestId(
      "text-debt-reauth-consent-refresh-error-item-chase",
    );
    expect(note.textContent).toContain("Couldn't verify disconnect date");
    expect(note.textContent).toContain("ITEM_LOGIN_REQUIRED");
  });

  it("(#320) hides the consent-refresh line when the next refresh succeeds (error is cleared)", () => {
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <DebtReauthBanner
          debts={[
            makeDebt({
              id: "d1",
              plaidLastSyncErrorCode: "PENDING_DISCONNECT",
              plaidConsentExpirationAt: "2026-05-21T15:30:00.000Z",
              plaidConsentExpirationLastRefreshError: "ITEM_LOGIN_REQUIRED",
            } as Partial<Debt> & { id: string }),
          ]}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByTestId("text-debt-reauth-consent-refresh-error-item-chase"),
    ).toBeTruthy();

    rerender(
      <QueryClientProvider client={qc}>
        <DebtReauthBanner
          debts={[
            makeDebt({
              id: "d1",
              plaidLastSyncErrorCode: "PENDING_DISCONNECT",
              plaidConsentExpirationAt: "2026-05-21T15:30:00.000Z",
              plaidConsentExpirationLastRefreshError: null,
            } as Partial<Debt> & { id: string }),
          ]}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByTestId(
        "text-debt-reauth-consent-refresh-error-item-chase",
      ),
    ).toBeNull();
    // Banner stays mounted (debt still needs reconnect); only the
    // consent-refresh subline went away.
    expect(screen.getByTestId("banner-debt-reauth")).toBeTruthy();
  });

  it("(#320) does not render the consent-refresh line when the field is null", () => {
    renderBanner([
      makeDebt({ id: "d1", plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
    ]);
    expect(
      screen.queryByTestId("text-debt-reauth-consent-refresh-error-item-chase"),
    ).toBeNull();
  });

  it("hides itself when the user clicks the dismiss button", () => {
    renderBanner([
      makeDebt({ id: "d1", plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
    ]);
    expect(screen.getByTestId("banner-debt-reauth")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-debt-reauth-dismiss"));
    expect(screen.queryByTestId("banner-debt-reauth")).toBeNull();
  });

  it("disappears once the underlying debts list reports the item is healthy again (post-reconnect refetch)", () => {
    // Simulates the post-reconnect flow: <PlaidReconnectButton> succeeds,
    // it invalidates the debts query, the parent page refetches and passes
    // the now-healthy debt list back into <DebtReauthBanner> as a prop.
    // Without the debts-query invalidation added to plaid-reconnect-button,
    // the banner would stay mounted with the stale error code — this test
    // pins the reactive prop-change behavior.
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <DebtReauthBanner
          debts={[
            makeDebt({ id: "d1", plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED" }),
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("banner-debt-reauth")).toBeTruthy();

    rerender(
      <QueryClientProvider client={qc}>
        <DebtReauthBanner
          debts={[makeDebt({ id: "d1", plaidLastSyncErrorCode: null })]}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("banner-debt-reauth")).toBeNull();
  });
});
