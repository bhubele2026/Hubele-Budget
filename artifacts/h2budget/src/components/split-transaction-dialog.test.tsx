import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/** (C3, AL-16) First test of the split dialog: fields, validity, writes order. */

const calls = vi.hoisted(() => ({ order: [] as string[], created: [] as unknown[], updated: [] as unknown[] }));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useCreateTransaction: () => ({
    mutateAsync: async (a: unknown) => {
      calls.order.push("create");
      calls.created.push(a);
    },
  }),
  useUpdateTransaction: () => ({
    mutateAsync: async (a: unknown) => {
      calls.order.push("update");
      calls.updated.push(a);
    },
  }),
}));
vi.mock("@/lib/weeklyBuckets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/weeklyBuckets")>()),
  useWeeklyBucketLabels: () => ({ groceries: "Groceries", alcohol: "Alcohol", misc: "Misc", dining: "Dining", gas: "Gas" }),
}));

import { SplitTransactionDialog } from "./split-transaction-dialog";

const tx = {
  id: "t1",
  occurredOn: "2026-10-05",
  description: "Store run",
  displayName: "Store run",
  amount: "-50.00",
  categoryId: null,
  weeklyBucket: "groceries",
  account: null,
} as never;

function mount(onOpenChange = vi.fn()) {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <SplitTransactionDialog tx={tx} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

afterEach(() => {
  cleanup();
  calls.order = [];
  calls.created = [];
  calls.updated = [];
});

describe("SplitTransactionDialog", () => {
  it("starts with two parts and needs them to add up before it will split", () => {
    mount();
    expect((screen.getByTestId("split-amount-0") as HTMLInputElement).value).toBe("50.00");
    expect(screen.getByText(/\$50\.00 left to allocate|Splits add up/)).toBeTruthy();
    const go = screen.getByRole("button", { name: "Split it" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true); // second part is 0
    fireEvent.change(screen.getByTestId("split-amount-0"), { target: { value: "30.00" } });
    fireEvent.change(screen.getByTestId("split-amount-1"), { target: { value: "20.00" } });
    expect(screen.getByText("Splits add up. ✓")).toBeTruthy();
    expect(go.disabled).toBe(false);
  });

  it("adds and removes parts", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Add part/ }));
    expect(screen.getByTestId("split-amount-2")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove part" })[0]);
    expect(screen.queryByTestId("split-amount-2")).toBeNull();
  });

  it("creates parts 2..N first, then reshapes the original to weekly", async () => {
    const onOpenChange = mount();
    fireEvent.change(screen.getByTestId("split-amount-0"), { target: { value: "30.00" } });
    fireEvent.change(screen.getByTestId("split-amount-1"), { target: { value: "20.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Split it" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.order).toEqual(["create", "update"]);
    expect((calls.created[0] as { data: Record<string, unknown> }).data).toMatchObject({
      amount: "-20.00",
      weeklyAllowance: true,
      source: "manual",
    });
    expect((calls.updated[0] as { data: Record<string, unknown> }).data).toMatchObject({
      amount: "-30.00",
      weeklyAllowance: true,
      monthlyAllowance: false,
      unplannedAllowance: false,
    });
  });
});
