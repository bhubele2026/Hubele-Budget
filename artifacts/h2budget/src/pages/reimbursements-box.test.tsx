import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import React from "react";
import type { Transaction } from "@workspace/api-client-react";

const updateMutateAsync = vi.fn();
const toastFn = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastFn }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const real = await vi.importActual<typeof import("@workspace/api-client-react")>(
    "@workspace/api-client-react",
  );
  return {
    ...real,
    useUpdateTransaction: () => ({
      mutateAsync: updateMutateAsync,
      isPending: false,
    }),
    getListTransactionsQueryKey: () => ["/api/transactions"],
  };
});

import { ReimbursementsBox } from "./dashboard";

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: "t-x",
    occurredOn: "2026-05-01",
    description: "Coffee",
    amount: "-12.34",
    forecastFlag: false,
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    reimbursable: true,
    reimbursed: false,
    isTransfer: false,
    source: "amex",
    ...over,
  };
}

// Wrapper that subscribes to the same cache key used by the optimistic-update
// helper inside ReimbursementsBox. In production the dashboard page does this
// via useListTransactions(); here we use useQuery against the mocked key so
// the optimistic setQueryData calls trigger a re-render and a fresh prop.
function ReimbursementsBoxHarness() {
  const { data } = useQuery<Transaction[]>({
    queryKey: ["/api/transactions"],
    // No queryFn / no refetch — the cache is pre-seeded by renderBox and
    // mutated by the component's optimistic helper. Disabling the fetcher
    // keeps the test deterministic and reflects only setQueryData edits.
    queryFn: () => Promise.resolve([] as Transaction[]),
    enabled: false,
    staleTime: Infinity,
  });
  return (
    <ReimbursementsBox
      transactions={data ?? []}
      today={new Date("2026-05-05T12:00:00Z")}
      mappingRules={[]}
    />
  );
}

function renderBox(transactions: Transaction[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(["/api/transactions"], transactions);
  return render(
    <QueryClientProvider client={qc}>
      <ReimbursementsBoxHarness />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  toastFn.mockClear();
  updateMutateAsync.mockReset();
  updateMutateAsync.mockResolvedValue({ id: "ok" });
});

describe("ReimbursementsBox bulk-select", () => {
  const baseRows: Transaction[] = [
    tx({ id: "a", description: "Dinner", amount: "-30.00", owedBy: "Alice" }),
    tx({ id: "b", description: "Uber",   amount: "-12.50", owedBy: "Alice" }),
    tx({ id: "c", description: "Movie",  amount: "-18.00", owedBy: "Bob"   }),
  ];

  it("entering selection mode swaps each pending row's checkbox to a select toggle", () => {
    renderBox(baseRows);
    // Before: per-row checkbox is the one-click reimburse toggle, no select-* testid.
    expect(screen.queryByTestId("select-reimburse-a")).toBeNull();

    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));

    // After: bulk bar appears and every pending row exposes a selection checkbox.
    expect(screen.getByTestId("bulk-reimburse-bar")).toBeTruthy();
    expect(screen.getByTestId("select-reimburse-a")).toBeTruthy();
    expect(screen.getByTestId("select-reimburse-b")).toBeTruthy();
    expect(screen.getByTestId("select-reimburse-c")).toBeTruthy();
  });

  it("'Mark N reimbursed' PATCHes only the selected rows and exits selection mode", async () => {
    renderBox(baseRows);
    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));
    fireEvent.click(screen.getByTestId("select-reimburse-a"));
    fireEvent.click(screen.getByTestId("select-reimburse-c"));

    const bar = screen.getByTestId("bulk-reimburse-bar");
    expect(within(bar).getByText(/2 of 3 selected/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("bulk-reimburse-mark-selected"));

    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledTimes(2);
    });
    const calledIds = updateMutateAsync.mock.calls.map(
      ([arg]) => (arg as { id: string }).id,
    );
    expect(calledIds.sort()).toEqual(["a", "c"]);
    for (const [arg] of updateMutateAsync.mock.calls) {
      expect((arg as { data: { reimbursed: boolean } }).data).toEqual({
        reimbursed: true,
      });
    }

    // Selection mode auto-exits and the success toast fires.
    await waitFor(() => {
      expect(screen.queryByTestId("bulk-reimburse-bar")).toBeNull();
    });
    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/Marked 2 item/) }),
    );
  });

  it("shift-click selects every pending row between the previous click and this one", async () => {
    const rows: Transaction[] = [
      tx({ id: "a", description: "Dinner",  owedBy: "Alice" }),
      tx({ id: "b", description: "Uber",    owedBy: "Alice" }),
      tx({ id: "c", description: "Movie",   owedBy: "Bob"   }),
      tx({ id: "d", description: "Lunch",   owedBy: "Carol" }),
    ];
    renderBox(rows);
    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));

    // Anchor click on row "a", then shift-click on row "c": a, b, c selected.
    fireEvent.click(screen.getByTestId("select-reimburse-a"));
    fireEvent.click(screen.getByTestId("select-reimburse-c"), { shiftKey: true });

    const bar = screen.getByTestId("bulk-reimburse-bar");
    expect(within(bar).getByText(/3 of 4 selected/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("bulk-reimburse-mark-selected"));
    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledTimes(3);
    });
    const ids = updateMutateAsync.mock.calls
      .map(([arg]) => (arg as { id: string }).id)
      .sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("shift-click works in reverse order from a later anchor row", async () => {
    const rows: Transaction[] = [
      tx({ id: "a", owedBy: "Alice" }),
      tx({ id: "b", owedBy: "Alice" }),
      tx({ id: "c", owedBy: "Bob"   }),
      tx({ id: "d", owedBy: "Carol" }),
    ];
    renderBox(rows);
    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));

    fireEvent.click(screen.getByTestId("select-reimburse-d"));
    fireEvent.click(screen.getByTestId("select-reimburse-b"), { shiftKey: true });

    const bar = screen.getByTestId("bulk-reimburse-bar");
    expect(within(bar).getByText(/3 of 4 selected/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("bulk-reimburse-mark-selected"));
    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledTimes(3);
    });
    const ids = updateMutateAsync.mock.calls
      .map(([arg]) => (arg as { id: string }).id)
      .sort();
    expect(ids).toEqual(["b", "c", "d"]);
  });

  it("re-entering selection mode forgets the prior anchor (no stale shift-click range)", () => {
    const rows: Transaction[] = [
      tx({ id: "a", owedBy: "Alice" }),
      tx({ id: "b", owedBy: "Alice" }),
      tx({ id: "c", owedBy: "Bob"   }),
      tx({ id: "d", owedBy: "Carol" }),
    ];
    renderBox(rows);

    // First session: anchor on "a", then cancel.
    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));
    fireEvent.click(screen.getByTestId("select-reimburse-a"));
    fireEvent.click(screen.getByTestId("bulk-reimburse-cancel"));

    // Second session: a fresh shift-click on "c" must NOT range-select from
    // the stale "a" anchor — it should just toggle "c" alone.
    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));
    fireEvent.click(screen.getByTestId("select-reimburse-c"), { shiftKey: true });

    const bar = screen.getByTestId("bulk-reimburse-bar");
    expect(within(bar).getByText(/1 of 4 selected/)).toBeTruthy();
  });

  it("Cancel clears the selection and exits selection mode without firing PATCH", () => {
    renderBox(baseRows);
    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));
    fireEvent.click(screen.getByTestId("select-reimburse-b"));
    fireEvent.click(screen.getByTestId("bulk-reimburse-cancel"));

    expect(screen.queryByTestId("bulk-reimburse-bar")).toBeNull();
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it("disables the per-payer chips while selection mode is active", () => {
    renderBox(baseRows);
    const aliceChip = screen.getByTestId("bulk-reimburse-Alice") as HTMLButtonElement;
    expect(aliceChip.disabled).toBe(false);

    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));

    // Same chip must now be disabled so the two flows can't fight.
    const aliceAfter = screen.getByTestId("bulk-reimburse-Alice") as HTMLButtonElement;
    expect(aliceAfter.disabled).toBe(true);
  });

  it("updates the per-payer chips optimistically when a batch is marked", async () => {
    renderBox(baseRows);

    // Both Alice (2 items) and Bob (1 item) start as pending payer chips.
    expect(screen.getByTestId("bulk-reimburse-Alice")).toBeTruthy();
    expect(screen.getByTestId("bulk-reimburse-Bob")).toBeTruthy();

    fireEvent.click(screen.getByTestId("bulk-reimburse-select-mode"));
    fireEvent.click(screen.getByTestId("select-reimburse-a"));
    fireEvent.click(screen.getByTestId("select-reimburse-b"));
    fireEvent.click(screen.getByTestId("bulk-reimburse-mark-selected"));

    // After the optimistic flip, both Alice rows are reimbursed so her chip
    // disappears; Bob's stays. The cache-driven re-render proves the headline
    // and chips are tracking the in-flight batch, not waiting on a refetch.
    await waitFor(() => {
      expect(screen.queryByTestId("bulk-reimburse-Alice")).toBeNull();
    });
    expect(screen.getByTestId("bulk-reimburse-Bob")).toBeTruthy();
  });
});
