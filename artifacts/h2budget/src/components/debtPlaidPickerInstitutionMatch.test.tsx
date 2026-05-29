import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Pure-function tests for the institution-match heuristic + an integration
// test that the picker dialog honors it. Tracking the symptom that broke
// the user's "Link" flow: clicking Link on a Chase debt surfaced their
// existing Amex card accounts as candidates AND a stale OAuth link_token
// in localStorage could bleed into Plaid SDK as an Amex 2FA modal.

vi.mock("@workspace/api-client-react", () => ({
  useListPlaidLiabilityAccounts: vi.fn(),
  useLinkDebtToPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useUnlinkDebtFromPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshDebtFromPlaid: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateDebtFromPlaidAccount: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePlaidUpdateLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePlaidLinkToken: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePlaidAddAccountLinkToken: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useExchangePlaidPublicToken: () => ({ mutate: vi.fn(), isPending: false }),
  useListPlaidItems: () => ({ data: [], isFetched: true }),
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
  PlaidLinkButton: ({ label }: { label?: string }) => (
    <button data-testid="plaid-link-another-button">
      {label ?? "Link a Bank or Card"}
    </button>
  ),
  PLAID_LINK_TOKEN_STORAGE_KEY: "h2:plaid:link_token",
  PLAID_RETURN_TO_STORAGE_KEY: "h2:plaid:return_to",
}));

import {
  DebtPlaidActions,
  isInstitutionMatch,
} from "./debt-plaid-link";
import type { Debt, PlaidLiabilityAccount } from "@workspace/api-client-react";
import { useListPlaidLiabilityAccounts } from "@workspace/api-client-react";

function baseDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: "d-chase-amzn",
    name: "Chase Amazon Prime Visa",
    balance: "1000",
    apr: "0.25",
    minPayment: "30",
    payment: "30",
    status: "active",
    sortOrder: 1,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
    plaidAccountId: null,
    plaidLastSyncedAt: null,
    plaidLastSyncError: null,
    plaidLastSyncErrorCode: null,
    ...overrides,
  } as Debt;
}

function amexAccount(overrides: Partial<PlaidLiabilityAccount> = {}): PlaidLiabilityAccount {
  return {
    id: "acct-amex-platinum",
    itemId: "item-amex",
    name: "Platinum Card®",
    officialName: "Platinum Card®",
    mask: "1009",
    type: "credit",
    subtype: "credit card",
    liabilityKind: "credit",
    institutionName: "American Express",
    institutionSlug: "amex",
    ...overrides,
  } as PlaidLiabilityAccount;
}

function chaseAccount(overrides: Partial<PlaidLiabilityAccount> = {}): PlaidLiabilityAccount {
  return {
    id: "acct-chase-amzn",
    itemId: "item-chase",
    name: "Amazon Prime Rewards Visa",
    officialName: "Amazon Prime Rewards Visa Signature",
    mask: "4242",
    type: "credit",
    subtype: "credit card",
    liabilityKind: "credit",
    institutionName: "Chase",
    institutionSlug: "chase",
    ...overrides,
  } as PlaidLiabilityAccount;
}

function renderActions(debt: Debt) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <DebtPlaidActions debt={debt} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.mocked(useListPlaidLiabilityAccounts).mockReset();
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

describe("isInstitutionMatch (#link-button-bug)", () => {
  it("matches debt 'Chase Amazon Prime Visa' against institution 'Chase'", () => {
    expect(isInstitutionMatch("Chase Amazon Prime Visa", "Chase", "chase")).toBe(true);
  });

  it("does NOT match debt 'Chase Amazon Prime Visa' against institution 'American Express'", () => {
    expect(
      isInstitutionMatch("Chase Amazon Prime Visa", "American Express", "amex"),
    ).toBe(false);
  });

  it("matches via slug alias: debt 'Amex Platinum' against institution 'American Express' (slug=amex)", () => {
    expect(isInstitutionMatch("Amex Platinum", "American Express", "amex")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isInstitutionMatch("CHASE AMAZON PRIME VISA", "chase", "chase")).toBe(true);
  });

  it("doesn't false-match on shared stopword 'Bank' alone", () => {
    expect(
      isInstitutionMatch("Bank of America Visa", "Chase Bank", "chase"),
    ).toBe(false);
  });

  it("returns false for empty / null inputs", () => {
    expect(isInstitutionMatch("", "Chase", "chase")).toBe(false);
    expect(isInstitutionMatch("Chase", null, null)).toBe(false);
    expect(isInstitutionMatch(null, "Chase", "chase")).toBe(false);
  });

  // (#link-button-bug follow-up from architect review) Alias / format
  // variants the heuristic must cover so common US debts don't slip
  // through the prefilter and force the user into the escape hatch.
  it("matches Citi/Citibank alias", () => {
    expect(isInstitutionMatch("Citi Double Cash", "Citibank", "citibank")).toBe(true);
    expect(isInstitutionMatch("Citibank Visa", "Citi", "citi")).toBe(true);
  });

  it("matches joined-word debt label 'CapitalOne Venture' against 'Capital One'", () => {
    expect(isInstitutionMatch("CapitalOne Venture", "Capital One", "capital-one")).toBe(true);
  });

  it("matches joined-word debt label 'WellsFargo Active Cash' against 'Wells Fargo'", () => {
    expect(isInstitutionMatch("WellsFargo Active Cash", "Wells Fargo", "wells-fargo")).toBe(true);
  });

  it("matches via hyphenated slug tokens (e.g. 'capital-one' → 'capital','one')", () => {
    expect(isInstitutionMatch("Capital One Quicksilver", "Capital One", "capital-one")).toBe(true);
  });

  it("matches BoA / BofA aliases to 'Bank of America'", () => {
    expect(isInstitutionMatch("BoA Travel Rewards", "Bank of America", "bank-of-america")).toBe(true);
    expect(isInstitutionMatch("BofA Cash Rewards", "Bank of America", "bank-of-america")).toBe(true);
  });
});

describe("PlaidAccountPicker prefilter + storage clear (#link-button-bug)", () => {
  function openPickerFor(debt: Debt, accounts: PlaidLiabilityAccount[]) {
    vi.mocked(useListPlaidLiabilityAccounts).mockReturnValue({
      data: accounts,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useListPlaidLiabilityAccounts>);
    renderActions(debt);
    fireEvent.click(screen.getByTestId(`button-debt-link-plaid-${debt.id}`));
  }

  it("hides Amex accounts when the debt's name matches Chase", () => {
    const debt = baseDebt({ name: "Chase Amazon Prime Visa" });
    openPickerFor(debt, [amexAccount(), amexAccount({ id: "acct-amex-2", name: "Blue Cash Preferred®" })]);
    // The matching path: zero Chase candidates → empty-state copy with
    // a prominent "Link a bank for {debtName}" CTA, not the Amex rows.
    expect(screen.queryByTestId("button-pick-plaid-acct-amex-platinum")).toBeNull();
    expect(screen.queryByTestId("button-pick-plaid-acct-amex-2")).toBeNull();
    expect(
      screen.getByTestId(`text-debt-picker-no-matches-${debt.id}`),
    ).toBeTruthy();
    expect(screen.getByText(/Link a bank for Chase Amazon Prime Visa/)).toBeTruthy();
  });

  it("shows the matching Chase account when linking a Chase debt", () => {
    const debt = baseDebt({ name: "Chase Amazon Prime Visa" });
    openPickerFor(debt, [chaseAccount(), amexAccount()]);
    expect(screen.getByTestId("button-pick-plaid-acct-chase-amzn")).toBeTruthy();
    expect(screen.queryByTestId("button-pick-plaid-acct-amex-platinum")).toBeNull();
  });

  it("clears a stale h2:plaid:link_token from localStorage when the Link button is clicked", () => {
    localStorage.setItem("h2:plaid:link_token", "link-sandbox-stale-amex-token");
    localStorage.setItem("h2:plaid:return_to", "/debts");
    const debt = baseDebt({ name: "Chase Amazon Prime Visa" });
    openPickerFor(debt, []);
    expect(localStorage.getItem("h2:plaid:link_token")).toBeNull();
    expect(localStorage.getItem("h2:plaid:return_to")).toBeNull();
  });

  // (#link-button-bug follow-up from architect review) Escape hatch:
  // even when the heuristic hides all linked accounts, the user must be
  // able to fall back to the full list — never trapped.
  it("'Show all linked accounts anyway' escape hatch reveals the hidden accounts", () => {
    const debt = baseDebt({ name: "Chase Amazon Prime Visa" });
    openPickerFor(debt, [
      amexAccount(),
      amexAccount({ id: "acct-amex-2", name: "Blue Cash Preferred®" }),
    ]);
    // Confirm we're in the no-matches state with the escape-hatch button.
    const showAll = screen.getByTestId(`button-debt-picker-show-all-${debt.id}`);
    expect(showAll).toBeTruthy();
    expect(showAll.textContent).toContain("Show all 2 linked accounts");
    fireEvent.click(showAll);
    // Now the previously-hidden Amex rows must render.
    expect(screen.getByTestId("button-pick-plaid-acct-amex-platinum")).toBeTruthy();
    expect(screen.getByTestId("button-pick-plaid-acct-amex-2")).toBeTruthy();
  });
});
