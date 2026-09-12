import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (One-time bill move, owner decision 9) Editing a one-time bill offers two
// different acts: "Move this bill" (the default save once the date changes —
// the SAME bill, whose answers the server moves with it) and "Create another
// bill" (a NEW, active item with the edited fields; the original is not
// touched), offered only once the date, name or amount differs. The save's
// toast says plainly what happened to the bill's match.

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
/** What the PATCH answers with; `moveResult` only when answers were re-checked. */
let updateResult: Record<string, unknown> = {};
const createItemMock = vi.fn();
const updateItemMock = vi.fn();
const toastMock = vi.fn();

vi.mock("wouter", () => ({
  useSearch: () => "month=2026-09-01",
  useLocation: () => ["/bills", vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
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
    mutate: (args: { id: string; data: Record<string, unknown> }, opts?: { onSuccess?: (data: unknown) => void }) => {
      updateItemMock(args);
      opts?.onSuccess?.({ ...ROOF, ...args.data, ...updateResult });
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

async function openRoof(): Promise<HTMLInputElement> {
  renderPage();
  fireEvent.click(screen.getByTestId("row-bill-bill-roof"));
  return (await screen.findByTestId("input-onetime-date")) as HTMLInputElement;
}

async function moveRoofTo(date: string): Promise<void> {
  const input = await openRoof();
  fireEvent.change(input, { target: { value: date } });
  fireEvent.click(screen.getByTestId("button-save"));
}

beforeEach(() => {
  cleanup();
  createItemMock.mockClear();
  updateItemMock.mockClear();
  toastMock.mockClear();
  items = [ROOF, WATER];
  updateResult = {};
});

describe("Bills editor — one-time bills: Move this bill vs Create another bill", () => {
  it("a new date turns the save into 'Move this bill', which updates the same bill", async () => {
    const date = await openRoof();
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
    const date = await openRoof();
    fireEvent.change(date, { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByTestId("button-create-another"));

    expect(createItemMock).toHaveBeenCalledTimes(1);
    const arg = createItemMock.mock.calls[0]![0] as { id?: string; data: Record<string, unknown> };
    expect(arg.id).toBeUndefined();
    expect(arg.data).toMatchObject({ name: "Roof repair", amount: "300", frequency: "onetime", anchorDate: "2026-10-20" });
    expect(updateItemMock).not.toHaveBeenCalled();
  });

  it("(review L3) 'Create another bill' is not offered until the date, name or amount differs", async () => {
    await openRoof();
    expect(screen.queryByTestId("button-create-another")).toBeNull();
    fireEvent.change(screen.getByTestId("input-name"), { target: { value: "Roof repair, second visit" } });
    expect(screen.getByTestId("button-create-another")).toBeTruthy();
    fireEvent.change(screen.getByTestId("input-name"), { target: { value: "Roof repair" } });
    expect(screen.queryByTestId("button-create-another")).toBeNull();
  });

  it("(review L3) the new bill is active even when the original was paused", async () => {
    items = [{ ...ROOF, active: "false" }, WATER];
    const date = await openRoof();
    fireEvent.change(date, { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByTestId("button-create-another"));
    const arg = createItemMock.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.active).toBe("true");
  });

  it("the help says a far move asks for review", async () => {
    await openRoof();
    expect(screen.getByLabelText(/far move asks for review/i)).toBeTruthy();
  });

  it("a recurring bill has no 'Create another bill' and saves as before", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("row-bill-bill-water"));
    await screen.findByTestId("input-day-of-month");
    expect(screen.queryByTestId("button-create-another")).toBeNull();
    expect(screen.getByTestId("button-save").textContent).toBe("Save changes");
  });
});

describe("(round 3, 4) the save says what happened to the bill's match", () => {
  const lastToast = () => toastMock.mock.calls.at(-1)?.[0] as { title: string; description?: string };

  it("a match carried to the new date: just 'Moved this bill'", async () => {
    updateResult = { moveResult: { carried: 1, needsReview: 0, cleared: 0 } };
    await moveRoofTo("2026-09-25");
    expect(lastToast()).toEqual({ title: "Moved this bill" });
  });

  it("a match put in question: says it needs review", async () => {
    updateResult = { moveResult: { carried: 0, needsReview: 1, cleared: 0 } };
    await moveRoofTo("2026-10-20");
    expect(lastToast()).toEqual({ title: "Moved this bill", description: "1 match needs review." });
  });

  it("a match cleared: says the bill shows unpaid", async () => {
    updateResult = { moveResult: { carried: 0, needsReview: 0, cleared: 1 } };
    await moveRoofTo("2026-07-01");
    expect(lastToast()).toEqual({
      title: "Moved this bill",
      description: "Its match was cleared, so the bill shows unpaid.",
    });
  });

  it("an amount change that puts two answers in question, without moving: 'Saved' and a plural", async () => {
    updateResult = { moveResult: { carried: 0, needsReview: 2, cleared: 0 } };
    await openRoof();
    fireEvent.change(screen.getByTestId("input-amount"), { target: { value: "3000" } });
    fireEvent.click(screen.getByTestId("button-save"));
    expect(lastToast()).toEqual({ title: "Saved", description: "2 matches need review." });
  });

  it("no summary: the toast is unchanged", async () => {
    await moveRoofTo("2026-09-25");
    expect(lastToast()).toEqual({ title: "Moved this bill" });
  });
});
