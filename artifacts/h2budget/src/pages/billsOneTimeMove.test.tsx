import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (One-time bill move, owner decision 9) Editing a one-time bill offers two
// different acts: "Move this bill" (the default save once the date changes —
// the SAME bill, whose answers the server moves with it) and "Create another
// bill" (a NEW item with the edited fields; the original is not touched).

if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
}
if (!(Element.prototype as { hasPointerCapture?: unknown }).hasPointerCapture) {
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
}

type Item = {
  id: string;
  name: string;
  kind: string;
  type: "expense";
  amount: string;
  frequency: string;
  dayOfMonth: number | null;
  anchorDate: string | null;
  active: string;
  categoryId: string | null;
  debtId: string | null;
};

const ROOF: Item = {
  id: "bill-roof",
  name: "Roof repair",
  kind: "bill",
  type: "expense",
  amount: "300",
  frequency: "onetime",
  dayOfMonth: null,
  anchorDate: "2026-09-20",
  active: "true",
  categoryId: null,
  debtId: null,
};
const WATER: Item = { ...ROOF, id: "bill-water", name: "Water", amount: "80", frequency: "monthly", dayOfMonth: 14, anchorDate: null };

let items: Item[] = [];
const createItemMock = vi.fn();
const updateItemMock = vi.fn();

vi.mock("wouter", () => ({
  useSearch: () => "month=2026-09-01",
  useLocation: () => ["/bills", vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetBillsSummary: () => ({
    data: {
      income: [],
      bills: items.map((item) => ({ item, nextOccurrence: "2026-09-20", monthlyAmount: item.amount, actualAmount: "0" })),
      debtMins: [],
      monthly: { income: "0", bills: "0", debtMin: "0", totalOutflow: "0", net: "0", active: items.length, monthStart: "2026-09-01", monthEnd: "2026-09-30" },
    },
    isLoading: false,
  }),
  useListDebts: () => ({ data: [] }),
  useListTransactions: () => ({ data: [] }),
  useListCategories: () => ({ data: [] }),
  useGetAvalancheSettings: () => ({ data: undefined }),
  useGetAvalancheExtra: () => ({ data: undefined }),
  useCreateRecurringItem: () => ({
    mutate: (args: unknown, opts?: { onSuccess?: () => void }) => {
      createItemMock(args);
      opts?.onSuccess?.();
    },
    isPending: false,
  }),
  useUpdateRecurringItem: () => ({
    mutate: (args: unknown, opts?: { onSuccess?: () => void }) => {
      updateItemMock(args);
      opts?.onSuccess?.();
    },
    isPending: false,
  }),
  useDeleteRecurringItem: () => ({ mutate: vi.fn(), isPending: false }),
  getListRecurringItemsQueryKey: () => ["/api/recurring-items"],
  getGetBillsSummaryQueryKey: (m: string) => ["/api/bills/summary", m],
  getGetForecastQueryKey: () => ["/api/forecast"],
  getGetDashboardQueryKey: () => ["/api/dashboard"],
}));

import BillsPage from "./bills";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BillsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  createItemMock.mockClear();
  updateItemMock.mockClear();
  items = [ROOF, WATER];
});

describe("Bills editor — one-time bills: Move this bill vs Create another bill", () => {
  it("a new date turns the save into 'Move this bill', which updates the same bill", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("row-bill-bill-roof"));
    const date = (await screen.findByTestId("input-onetime-date")) as HTMLInputElement;
    expect(date.value).toBe("2026-09-20");
    expect(screen.getByTestId("button-save").textContent).toBe("Save changes");

    fireEvent.change(date, { target: { value: "2026-10-20" } });
    expect(screen.getByTestId("button-save").textContent).toBe("Move this bill");
    fireEvent.click(screen.getByTestId("button-save"));

    expect(updateItemMock).toHaveBeenCalledTimes(1);
    expect(updateItemMock).toHaveBeenCalledWith({
      id: "bill-roof",
      data: expect.objectContaining({ name: "Roof repair", amount: "300", frequency: "onetime", anchorDate: "2026-10-20" }),
    });
    expect(createItemMock).not.toHaveBeenCalled();
  });

  it("'Create another bill' creates a new one-time item with the edited fields and never updates the original", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("row-bill-bill-roof"));
    const date = (await screen.findByTestId("input-onetime-date")) as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByTestId("button-create-another"));

    expect(createItemMock).toHaveBeenCalledTimes(1);
    const arg = createItemMock.mock.calls[0]![0] as { id?: string; data: Record<string, unknown> };
    expect(arg.id).toBeUndefined();
    expect(arg.data).toMatchObject({ name: "Roof repair", amount: "300", frequency: "onetime", anchorDate: "2026-10-20" });
    expect(updateItemMock).not.toHaveBeenCalled();
  });

  it("a recurring bill has no 'Create another bill' and saves as before", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("row-bill-bill-water"));
    await screen.findByTestId("input-day-of-month");
    expect(screen.queryByTestId("button-create-another")).toBeNull();
    expect(screen.getByTestId("button-save").textContent).toBe("Save changes");
  });
});
