// (#671) Layer 4 — opportunistic Plaid refresh on page mount.
//
// Verifies the module-level cooldown so that hopping between
// Dashboard, Forecast, and Transactions in quick succession fires a
// single background refresh, not three; and that errors stay silent
// (no toast) since Layer 4 is best-effort invisible freshness.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const toastFn = vi.fn();
const navigateFn = vi.fn();
const mutateMock = vi.fn(
  (
    _vars: { data: { itemId?: string } },
    opts: {
      onSuccess?: (r: { items: unknown[] }) => void;
      onError?: (e: Error) => void;
    },
  ) => {
    opts.onSuccess?.({ items: [] });
  },
);

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastFn }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/", navigateFn] as const,
}));

vi.mock("@workspace/api-client-react", () => ({
  useSyncPlaidTransactions: () => ({ mutate: mutateMock, isPending: false }),
  getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
}));

vi.mock("@/components/plaid-reconnect-listener", () => ({
  dispatchPlaidReconnect: vi.fn(),
}));

import {
  useOpportunisticPlaidSync,
  _resetOpportunisticSyncForTests,
} from "./use-opportunistic-plaid-sync";

function Harness({ cooldownMs }: { cooldownMs?: number }) {
  useOpportunisticPlaidSync(cooldownMs !== undefined ? { cooldownMs } : {});
  return <div data-testid="mounted" />;
}

function withProvider(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  _resetOpportunisticSyncForTests();
  mutateMock.mockClear();
  toastFn.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useOpportunisticPlaidSync", () => {
  it("fires runSync once on first mount", async () => {
    render(withProvider(<Harness cooldownMs={60_000} />));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));
    // silent: no toast on success
    expect(toastFn).not.toHaveBeenCalled();
  });

  it("does NOT fire again when a second page mounts within the cooldown window", async () => {
    render(withProvider(<Harness cooldownMs={60_000} />));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));

    // Simulate the user navigating Dashboard → Forecast → Transactions
    // in quick succession: each page remounts the hook, but the
    // module-level cooldown gates all but the first.
    render(withProvider(<Harness cooldownMs={60_000} />));
    render(withProvider(<Harness cooldownMs={60_000} />));
    await new Promise((r) => setTimeout(r, 0));
    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  it("fires again once the cooldown elapses", async () => {
    render(withProvider(<Harness cooldownMs={1} />));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));

    await new Promise((r) => setTimeout(r, 10));

    render(withProvider(<Harness cooldownMs={1} />));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(2));
  });

  it("fires again when the tab regains focus after the cooldown has elapsed (#673)", async () => {
    render(withProvider(<Harness cooldownMs={1} />));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));

    // Let the cooldown lapse so the focus event is the trigger, not
    // an inflight collision.
    await new Promise((r) => setTimeout(r, 10));

    // Simulate the user switching back to the tab. The hook listens
    // on both `visibilitychange` (preferred modern signal) and
    // `focus` (older fallback). Dispatching `focus` is enough to
    // exercise the new code path.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(2));
  });

  it("fires when the document becomes visible again after cooldown (#673 visibilitychange path)", async () => {
    render(withProvider(<Harness cooldownMs={1} />));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));

    await new Promise((r) => setTimeout(r, 10));

    // jsdom defaults visibilityState to "visible" — flip to hidden,
    // then back to visible, and dispatch the corresponding event the
    // hook listens for.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(2));
  });

  it("does NOT fire on rapid tab flips inside the cooldown window (#673)", async () => {
    render(withProvider(<Harness cooldownMs={60_000} />));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));

    // Five quick alt-tabs — every one should be swallowed by the
    // module-level cooldown so Plaid never sees a burst.
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new Event("focus"));
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  it("never raises a toast on error (silent best-effort)", async () => {
    mutateMock.mockImplementationOnce(
      (
        _vars: { data: { itemId?: string } },
        opts: { onError?: (e: Error) => void },
      ) => {
        opts.onError?.(new Error("network down"));
      },
    );
    render(withProvider(<Harness cooldownMs={60_000} />));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));
    expect(toastFn).not.toHaveBeenCalled();
  });
});
