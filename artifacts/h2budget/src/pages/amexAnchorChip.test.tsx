import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

type AnchorResp = {
  amexEndingBalance: number | null;
  asOf: string;
  source: "debt" | "anchor" | "computed" | "missing";
};

let anchorState: AnchorResp = {
  amexEndingBalance: 1000,
  asOf: "2026-04-01T00:00:00.000Z",
  source: "anchor",
};

const fetchCalls: { url: string; method: string; body?: unknown }[] = [];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??
  ResizeObserverStub;

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useLocation: () => ["/amex", () => undefined] as const,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Heavy children we don't care about for this chip-focused test.
vi.mock("@/components/plaid-link-button", () => ({
  PlaidLinkButton: () => null,
}));
vi.mock("@/components/sync-button", () => ({
  SyncButton: () => null,
}));
vi.mock("@/components/category-picker", () => ({
  CategoryPicker: () => null,
  defaultRememberPattern: (s: string) => s,
}));
vi.mock("@/components/bucket-bubbles", () => ({
  BucketBubbles: () => null,
}));

vi.mock("@workspace/api-client-react", () => {
  const TransactionWeeklyBucket = {
    groceries: "groceries",
    dining: "dining",
    entertainment: "entertainment",
    misc: "misc",
  } as const;
  return {
    TransactionWeeklyBucket,
    useGetSettings: () => ({ data: undefined }),
    useListTransactions: () => ({ data: [], isLoading: false }),
    useListCategories: () => ({ data: [] }),
    // No linked Amex debt — forces the chip to use the server anchor.
    useListDebts: () => ({ data: [] }),
    useUpdateTransaction: () => ({
      mutateAsync: async () => undefined,
      mutate: () => undefined,
    }),
    // amex.tsx imports useListMappingRules directly, and
    // useBulkRecategorizePrompt (called at amex.tsx:110) calls both
    // useListMappingRules and useRecategorizeTransactionsByPattern at
    // module-load time. Without these stubs the hook is invoked as
    // `undefined`, mirroring the same incomplete-mock crash Task #235
    // fixed in mappingRulesRestoreNoPrompt.test.tsx.
    useListMappingRules: () => ({ data: [], isLoading: false }),
    useRecategorizeTransactionsByPattern: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    // useRuleActionUndo (called from amex.tsx via useRuleActionUndo())
    // pulls these two hooks at module-load time. Stub them so the
    // render doesn't crash with "is not a function" when the hook
    // body runs.
    useDeleteMappingRule: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    useUpdateMappingRule: () => ({
      mutate: () => undefined,
      isPending: false,
    }),
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-months", m],
    // PlaidReauthBanner (rendered by amex.tsx) calls useListPlaidItems
    // at module load. Empty list keeps the banner inert.
    useListPlaidItems: () => ({ data: [] }),
    // usePlaidSync (called from amex.tsx) wraps useSyncPlaidTransactions.
    useSyncPlaidTransactions: () => ({
      mutateAsync: async () => ({ added: 0, modified: 0, removed: 0 }),
      isPending: false,
    }),
    customFetch: async (
      url: string,
      init: { method?: string; body?: string } = {},
    ) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });
      if (url === "/api/amex/anchor") {
        if (method === "GET") return anchorState;
        if (method === "POST") {
          const b = body as { balance: number; asOf?: string };
          anchorState = {
            amexEndingBalance: b.balance,
            asOf: b.asOf ?? new Date().toISOString(),
            source: "anchor",
          };
          return anchorState;
        }
        if (method === "DELETE") {
          anchorState = {
            amexEndingBalance: null,
            asOf: new Date().toISOString(),
            source: "missing",
          };
          return { ok: true };
        }
      }
      return undefined;
    },
  };
});

import AmexPage from "./amex";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AmexPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchCalls.length = 0;
  anchorState = {
    amexEndingBalance: 1000,
    asOf: "2026-04-01T00:00:00.000Z",
    source: "anchor",
  };
});

afterEach(() => {
  cleanup();
});

describe("Amex saved-anchor chip — Edit + Clear", () => {
  it("Edit pre-fills the popover with the current saved value and overwrites it on save", async () => {
    renderPage();

    // Wait for the anchor query to resolve and the chip to render.
    const editBtn = await screen.findByTestId("button-edit-actual-balance");
    expect(editBtn.textContent).toBe("Edit");

    // Open popover -> input is pre-filled with current saved value.
    act(() => {
      fireEvent.click(editBtn);
    });
    const input = (await screen.findByTestId(
      "input-actual-balance",
    )) as HTMLInputElement;
    expect(input.value).toBe("1000.00");

    // Overwrite the value and save.
    act(() => {
      fireEvent.change(input, { target: { value: "1750.25" } });
    });
    const saveBtn = screen.getByTestId("button-save-actual-balance");
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // POSTed the new value with the right shape.
    const post = fetchCalls.find(
      (c) => c.url === "/api/amex/anchor" && c.method === "POST",
    );
    expect(post).toBeTruthy();
    expect((post!.body as { balance: number }).balance).toBe(1750.25);

    // Cache invalidation re-fetched the anchor; chip re-renders with new value.
    await waitFor(() => {
      const chip = screen.getByTestId("stat-ending-balance");
      expect(chip.textContent).toMatch(/1,750\.25/);
    });
  });

  it("Clear removes the saved anchor and the chip immediately falls back (no Edit button left)", async () => {
    renderPage();

    // Open the Edit popover so the Clear button is visible.
    const editBtn = await screen.findByTestId("button-edit-actual-balance");
    act(() => {
      fireEvent.click(editBtn);
    });
    const clearBtn = await screen.findByTestId("button-clear-actual-balance");

    await act(async () => {
      fireEvent.click(clearBtn);
    });

    // DELETE was called.
    const del = fetchCalls.find(
      (c) => c.url === "/api/amex/anchor" && c.method === "DELETE",
    );
    expect(del).toBeTruthy();

    // After invalidation, the anchor source is "missing" — the Edit button
    // is gone and the chip switches to the "Set Amex balance" empty state.
    await waitFor(() => {
      expect(screen.queryByTestId("button-edit-actual-balance")).toBeNull();
      expect(screen.getByTestId("button-set-amex-balance")).toBeTruthy();
    });
  });
});
