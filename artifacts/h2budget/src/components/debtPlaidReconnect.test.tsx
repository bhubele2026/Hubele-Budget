import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Stub the API hooks the DebtPlaidActions component relies on so we can
// render it in isolation without standing up MSW or a real query client.
vi.mock("@workspace/api-client-react", () => ({
  useListPlaidLiabilityAccounts: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  useLinkDebtToPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useUnlinkDebtFromPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshDebtFromPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateDebtFromPlaidAccount: () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false }),
  useCreatePlaidUpdateLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  // (#654) plaid-reconnect-listener also calls useCreatePlaidLinkToken
  // for the fresh-link fallback when the server returns 409+relink.
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
  // (#863) DebtPlaidActions imports these storage-key constants for its
  // stale-token cleanup handler. They aren't load-bearing for these
  // render-time assertions, but the mock must expose them or the named
  // imports resolve to `undefined`.
  PLAID_LINK_TOKEN_STORAGE_KEY: "h2budget:plaidLinkToken",
  PLAID_RETURN_TO_STORAGE_KEY: "h2budget:plaidReturnTo",
}));

// (#863) The refresh + unlink controls now live inside a Radix
// DropdownMenu ("⋯" overflow). Radix only mounts DropdownMenuContent
// once the trigger is opened, which jsdom's pointer-capture model
// makes awkward to drive. Swap in a render-everything shim so the
// in-menu items (button-debt-refresh / button-debt-unlink) are always
// in the DOM, exactly as before the overflow-menu refactor — without
// weakening what the tests assert.
vi.mock("@/components/ui/dropdown-menu", () => {
  type Kids = { children?: React.ReactNode };
  const Passthrough = ({ children }: Kids) => <>{children}</>;
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuGroup: Passthrough,
    DropdownMenuPortal: Passthrough,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuRadioGroup: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuShortcut: Passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({
      children,
      onClick,
      disabled,
      ...rest
    }: {
      children?: React.ReactNode;
      onClick?: (e: React.MouseEvent) => void;
      disabled?: boolean;
    } & Record<string, unknown>) => (
      <button type="button" onClick={onClick} disabled={disabled} {...rest}>
        {children}
      </button>
    ),
    DropdownMenuCheckboxItem: Passthrough,
    DropdownMenuRadioItem: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
  };
});

import { DebtPlaidActions } from "./debt-plaid-link";
import type { Debt } from "@workspace/api-client-react";

function baseDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: "d-1",
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
      itemId: "item-row-1",
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

function renderRow(debt: Debt) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <DebtPlaidActions debt={debt} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
});

describe("(#198) DebtPlaidActions surfaces Reconnect when item is in re-auth state", () => {
  it("renders the Reconnect button keyed off the parent item id when plaidLastSyncErrorCode === 'ITEM_LOGIN_REQUIRED'", () => {
    renderRow(
      baseDebt({
        plaidLastSyncError: "the login details of this item have changed",
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
    );
    // Button's testid is `button-plaid-reconnect-${itemId}` so the click
    // path mints an update-mode link_token for the right item.
    expect(screen.getByTestId("button-plaid-reconnect-item-row-1")).toBeTruthy();
    // The standard refresh + unlink controls must still be present.
    expect(screen.getByTestId("button-debt-refresh-d-1")).toBeTruthy();
    expect(screen.getByTestId("button-debt-unlink-d-1")).toBeTruthy();
  });

  it("(#654) renders Reconnect when plaidLastSyncErrorCode === 'INVALID_ACCESS_TOKEN' (env-mismatched Chase token)", () => {
    // Reproduces the exact persisted state of the user's two real Chase
    // rows after #654: a sandbox-prefixed access_token on a production
    // server that Plaid bounces with INVALID_ACCESS_TOKEN. The Reconnect
    // button MUST render off this code so the user can re-link without
    // waiting for a new sync to re-stamp the row.
    renderRow(
      baseDebt({
        plaidLastSyncError:
          "This bank was linked from a different Plaid environment. Please reconnect to refresh.",
        plaidLastSyncErrorCode: "INVALID_ACCESS_TOKEN",
      }),
    );
    expect(screen.getByTestId("button-plaid-reconnect-item-row-1")).toBeTruthy();
  });

  it("renders Reconnect for PENDING_EXPIRATION too (other re-auth code)", () => {
    renderRow(
      baseDebt({
        plaidLastSyncError: "your bank requires re-auth before access expires",
        plaidLastSyncErrorCode: "PENDING_EXPIRATION",
      }),
    );
    expect(screen.getByTestId("button-plaid-reconnect-item-row-1")).toBeTruthy();
  });

  it("does NOT render Reconnect for non-reauth codes (e.g. RATE_LIMIT_EXCEEDED)", () => {
    renderRow(
      baseDebt({
        plaidLastSyncError: "rate limit exceeded",
        plaidLastSyncErrorCode: "RATE_LIMIT_EXCEEDED",
      }),
    );
    expect(screen.queryByTestId("button-plaid-reconnect-item-row-1")).toBeNull();
    // The plain refresh icon stays — non-reauth errors might be transient.
    expect(screen.getByTestId("button-debt-refresh-d-1")).toBeTruthy();
  });

  it("does NOT render Reconnect when the debt is healthy (no error code)", () => {
    renderRow(baseDebt({ plaidLastSyncErrorCode: null, plaidLastSyncError: null }));
    expect(screen.queryByTestId("button-plaid-reconnect-item-row-1")).toBeNull();
  });

  it("does NOT render Reconnect when the API didn't include plaidAccount.itemId (defensive)", () => {
    // Older API responses that haven't been re-codegen'd against this PR
    // would leave itemId off; we should fail closed rather than crash.
    const debt = baseDebt({
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
    });
    renderRow(debt);
    // No item id → no reconnect rendered, and definitely no crash.
    expect(screen.queryByTestId("button-plaid-reconnect-item-row-1")).toBeNull();
  });

  it("does NOT render Reconnect on a manual (unlinked) debt", () => {
    renderRow(
      baseDebt({
        plaidAccountId: null,
        plaidAccount: null,
        plaidLastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      }),
    );
    // Unlinked debt → "Link" CTA, no reconnect.
    expect(screen.queryByTestId("button-plaid-reconnect-item-row-1")).toBeNull();
    expect(screen.getByTestId("button-debt-link-plaid-d-1")).toBeTruthy();
  });
});
