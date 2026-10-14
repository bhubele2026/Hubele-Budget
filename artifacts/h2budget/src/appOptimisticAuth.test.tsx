import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import React from "react";

/**
 * ⭐ THE ROUTES DO NOT WAIT FOR CLERK WHEN THIS BROWSER WAS SIGNED IN BEFORE.
 *
 * `h2:auth-hint` set + Clerk still booting → the real route mounts and its
 * query goes out at once (the API reads the `__session` cookie, not Clerk).
 * Clerk then answering SIGNED OUT clears the hint and the cache and sends the
 * visitor to /sign-in: no data outlives the answer.
 */

const auth = vi.hoisted(() => ({ isLoaded: false, isSignedIn: false as boolean | undefined }));
const pageFetch = vi.hoisted(() => vi.fn());
const chunk = vi.hoisted(() => ({ wait: null as Promise<void> | null }));

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Show: () => null,
  useAuth: () => ({ isLoaded: auth.isLoaded, isSignedIn: auth.isSignedIn }),
  useClerk: () => ({ addListener: () => () => {} }),
}));
vi.mock("@clerk/react/internal", () => ({ publishableKeyFromHost: () => "pk_test_x" }));
vi.mock("@clerk/themes", () => ({ shadcn: {} }));
vi.mock("@workspace/api-client-react", () => ({
  getSpine: vi.fn(() => new Promise(() => {})),
  getGetSpineQueryKey: () => ["/api/spine"],
}));
vi.mock("./components/layout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));
vi.mock("./lib/routePrefetch", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  const Page = () => {
    const q = useQuery({ queryKey: ["/api/test-page"], queryFn: pageFetch, retry: false });
    return <div data-testid="page-amex">{q.data ? `data:${q.data}` : "loading"}</div>;
  };
  const page = () => Promise.resolve({ default: Page });
  const names = [
    "importCommandCenter", "importForecast", "importForecastOverview", "importReports",
    "importReportsDebt", "importReportsCashFlow", "importReportsSpending", "importReportsBudget",
    "importReportsBehavior", "importDebts", "importAvalanche", "importReviewCategories",
    "importTransactions", "importBills", "importBillsOverview", "importBudget",
    "importAllowances", "importSpendingPeriod", "importWishlist", "importMappingRules",
    "importSettings", "importAsk", "importSuggestions", "importNextForecast", "importNextAccounts",
  ];
  const out: Record<string, unknown> = { prefetchRoute: () => {}, whenRouteChunkLoaded: () => chunk.wait, importAmex: page };
  for (const n of names) out[n] = page;
  return out;
});
vi.mock("./pages/next/Dashboard", () => ({ default: () => <div data-testid="page-home" /> }));
vi.mock("./pages/auth", () => ({
  SignInPage: () => <div data-testid="page-sign-in" />,
  SignUpPage: () => <div data-testid="page-sign-up" />,
}));
vi.mock("./pages/plaid-oauth", () => ({ default: () => null }));
vi.mock("./pages/not-found", () => ({ default: () => <div data-testid="page-not-found" /> }));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/plaid-reconnect-listener", () => ({ PlaidReconnectListener: () => null }));
vi.mock("@/components/version-update-prompt", () => ({ VersionUpdatePrompt: () => null }));
vi.mock("@/lib/mutationInvalidation", () => ({ onWriteSuccess: () => {} }));

async function boot(path: string, hint: boolean) {
  vi.resetModules();
  window.localStorage.clear();
  if (hint) window.localStorage.setItem("h2:auth-hint", "1");
  window.history.pushState({}, "", path);
  const { default: App } = await import("./App");
  return render(<App />);
}

beforeEach(() => {
  auth.isLoaded = false;
  auth.isSignedIn = false;
  chunk.wait = null;
  pageFetch.mockReset();
  pageFetch.mockResolvedValue("rows");
});

afterEach(cleanup);

describe("optimistic routes", () => {
  it("hint set + Clerk not loaded: the page renders and its query fires", async () => {
    await boot("/amex", true);
    expect(await screen.findByTestId("page-amex")).toBeTruthy();
    expect(screen.queryByTestId("route-loading")).toBeNull();
    await waitFor(() => expect(pageFetch).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("data:rows")).toBeTruthy();
  });

  it("holds the routes (layout + skeleton, no Suspense) until the page chunk is in", async () => {
    let arrive: () => void = () => {};
    chunk.wait = new Promise<void>((r) => (arrive = r));
    await boot("/amex", true);
    expect(await screen.findByTestId("route-loading")).toBeTruthy();
    expect(pageFetch).not.toHaveBeenCalled();
    chunk.wait = null;
    await act(async () => arrive());
    expect(await screen.findByTestId("page-amex")).toBeTruthy();
    await waitFor(() => expect(pageFetch).toHaveBeenCalledTimes(1));
  });

  it("no hint + Clerk not loaded: nothing renders (slow-but-correct front door)", async () => {
    await boot("/amex", false);
    await act(async () => {});
    expect(screen.queryByTestId("page-amex")).toBeNull();
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("'/' with the hint goes straight to the landing", async () => {
    await boot("/", true);
    expect(await screen.findByTestId("page-home")).toBeTruthy();
  });

  it("Clerk loads signed OUT: hint cleared, cache cleared, sent to sign-in, no data left", async () => {
    const view = await boot("/amex", true);
    expect(await screen.findByText("data:rows")).toBeTruthy();
    const qc = (window as unknown as { __qc: { getQueryCache: () => { getAll: () => unknown[] } } }).__qc;
    expect(qc.getQueryCache().getAll().length).toBeGreaterThan(0);

    auth.isLoaded = true;
    auth.isSignedIn = false;
    const { default: App } = await import("./App");
    view.rerender(<App />);

    expect(await screen.findByTestId("page-sign-in")).toBeTruthy();
    expect(screen.queryByText("data:rows")).toBeNull();
    expect(window.localStorage.getItem("h2:auth-hint")).toBeNull();
    await waitFor(() => expect(qc.getQueryCache().getAll().length).toBe(0));
  });
});
