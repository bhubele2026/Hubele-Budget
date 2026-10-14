import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/** (W3) Biggest charges: largest first in the DOM, from the same bounded read as before. */
const h = vi.hoisted(() => ({ txns: [] as unknown[], calls: [] as Array<Record<string, unknown>> }));
vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<typeof import("@workspace/api-client-react")>()),
  useListTransactions: (p: Record<string, unknown>) => {
    h.calls.push(p);
    return { data: h.txns };
  },
  useListRecurringItems: () => ({ data: [] }),
}));
vi.mock("@/lib/cssBars", () => ({
  CssBars: ({ rows }: { rows: Array<{ id: string; label: string; value: number }> }) => (
    <ol data-testid="bars">{rows.map((r) => <li key={r.id}>{r.label}:{r.value}</li>)}</ol>
  ),
}));

import { BiggestCharges } from "./spending/BiggestCharges";

afterEach(() => cleanup());

const t = (id: string, description: string, amount: string, on = "2026-10-05") => ({
  id, description, amount, occurredOn: on, reimbursable: false, isTransfer: false, isExternalCardPayment: false,
  debtId: null, weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false,
});

describe("BiggestCharges", () => {
  it("is sorted by amount, largest first", () => {
    h.txns = [t("a", "SMALL SHOP", "-20.00"), t("b", "BIG SHOP", "-310.00", "2026-10-06"), t("c", "MID PLACE", "-95.00", "2026-10-07")];
    render(<BiggestCharges monthStart="2026-10-01" monthLabel="October 2026" />);
    const items = [...screen.getByTestId("bars").querySelectorAll("li")].map((l) => l.textContent);
    expect(items).toEqual(["BIG SHOP:310", "MID PLACE:95", "SMALL SHOP:20"]);
  });

  it("shows only the month it is given, and reads one bounded window", () => {
    h.calls = [];
    h.txns = [t("a", "THIS MONTH", "-50.00"), t("z", "LAST MONTH", "-900.00", "2026-09-20")];
    render(<BiggestCharges monthStart="2026-10-01" monthLabel="October 2026" />);
    expect(screen.getByTestId("bars").textContent).toContain("THIS MONTH");
    expect(screen.getByTestId("bars").textContent).not.toContain("LAST MONTH");
    expect(h.calls[0]).toMatchObject({ limit: 1000 });
  });

  it("says so when there are none", () => {
    h.txns = [];
    render(<BiggestCharges monthStart="2026-10-01" monthLabel="October 2026" />);
    expect(screen.getByText("No one-off charges this month.")).toBeTruthy();
  });
});

describe("Spending › This month › Details", () => {
  it("mounts the charges only once Details is opened, and only on the month page", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { Details } = await import("@/pages/spending/Details");
    h.txns = [t("a", "ONE SHOP", "-50.00")];
    h.calls = [];
    const data = {
      period: "month", start: "2026-10-01", actual: "100.00", known: "100.00", carryOver: null, refundFloorAdjustment: "0.00",
      unresolved: { amount: "0.00" }, categories: [], usualBasis: "same_days", usualThrough: "2026-10-14",
      beside: { unplanned: "0.00", weekly: null, monthly: "0.00", billMatched: "0.00", reimbursable: "0.00", householdSpend: "100.00" },
    } as never;
    const { unmount } = render(<Details data={data} view="month" />);
    expect(screen.queryByTestId("sp-biggest-charges")).toBeNull();
    expect(h.calls.length).toBe(0);
    const box = screen.getByTestId("sp-details") as HTMLDetailsElement;
    box.open = true;
    fireEvent(box, new Event("toggle"));
    expect(screen.getByTestId("sp-biggest-charges").textContent).toContain("October 2026");
    unmount();
    render(<Details data={data} view="week" />);
    const wk = screen.getByTestId("sp-details") as HTMLDetailsElement;
    wk.open = true;
    fireEvent(wk, new Event("toggle"));
    expect(screen.queryByTestId("sp-biggest-charges")).toBeNull();
  });
});
