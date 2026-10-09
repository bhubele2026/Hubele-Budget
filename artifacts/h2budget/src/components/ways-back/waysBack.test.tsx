import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/** (F7) The "way back" sheet: three options, owner-only carry-over with undo. */

const m = vi.hoisted(() => ({
  ways: null as unknown,
  isOwner: true,
  create: vi.fn(),
  del: vi.fn(),
}));
vi.mock("wouter", () => ({
  Link: ({ children, href, ...r }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={href} {...r}>{children}</a>
  ),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({ data: { isOwner: m.isOwner } }),
}));
vi.mock("@workspace/api-client-react/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react/features")>()),
  useGetWaysBack: () => ({ data: m.ways, isError: false, isFetching: false, refetch: vi.fn() }),
  useCreateWeekAdjustment: () => ({ mutate: m.create, isPending: false }),
  useDeleteWeekAdjustment: () => ({ mutate: m.del, isPending: false }),
}));

import { WaysBackLauncher } from "./WaysBackLauncher";

const ways = (over: Record<string, unknown> = {}, carry: Record<string, unknown> = {}) => ({
  weekStart: "2026-10-04",
  weekEnd: "2026-10-10",
  overBy: 4000,
  daysLeft: 3,
  hold: { perDay: 0, leavesUntilPayday: 91250 },
  trims: [
    { categoryId: "c1", name: "Dining", spentWeek: 9000, usualWeek: 5000 },
    { categoryId: "c2", name: "Coffee", spentWeek: 2500, usualWeek: null },
  ],
  carryOver: { nextWeekStart: "2026-10-11", nextWeekCap: 21000, applied: false, adjustment: null, ...carry },
  ...over,
});

async function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WaysBackLauncher />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId("ways-back-open"));
  return screen.findByTestId("ways-back");
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  m.isOwner = true;
});

describe("Ways back", () => {
  it("lays out hold, trim and carry-over in words, from whole cents", async () => {
    m.ways = ways();
    await open();
    expect(screen.getByTestId("way-hold").textContent).toContain("until Saturday");
    expect(screen.getByTestId("way-hold").textContent).toContain("$912.50 until payday");
    const rows = screen.getAllByTestId("way-trim-row");
    expect(rows[0].textContent).toContain("Dining");
    expect(rows[0].textContent).toContain("spent $90.00 this week · usually $50.00");
    expect(rows[1].textContent).not.toContain("usually");
    expect(screen.getByTestId("way-carry").textContent).toContain("Next week starts $40.00 lower, at $210.00.");
  });

  it("the owner carries it over: the next week, minus the overage, whole cents", async () => {
    m.ways = ways();
    await open();
    fireEvent.click(screen.getByTestId("carry-go"));
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create.mock.calls[0][0]).toEqual({ data: { weekStart: "2026-10-11", amountCents: -4000, reason: "carry_over" } });
  });

  it("a member sees the option, disabled, with whom to ask", async () => {
    m.isOwner = false;
    m.ways = ways();
    await open();
    expect((screen.getByTestId("carry-ask") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("carry-go")).toBeNull();
  });

  it("once carried over it says so and the owner can undo", async () => {
    m.ways = ways({}, { applied: true, adjustment: { weekStart: "2026-10-11", amountCents: -4000, reason: "carry_over" } });
    await open();
    expect(screen.getByTestId("carry-applied").textContent).toBe("Carried over. Next week starts $40.00 lower.");
    fireEvent.click(screen.getByTestId("carry-undo"));
    expect(m.del.mock.calls[0][0]).toEqual({ weekStart: "2026-10-11" });
  });

  it("with no limit next week there is nothing to lower; not over says so", async () => {
    m.ways = ways({ overBy: 0 }, { nextWeekCap: null });
    await open();
    expect(screen.getByTestId("ways-back-not-over")).toBeTruthy();
    expect(screen.getByTestId("way-carry").textContent).toContain("no limit set");
  });

  it("the server's 403 gets the owner-only sentence", async () => {
    m.ways = ways();
    m.create.mockImplementation((_a: unknown, o: { onError: (e: unknown) => void }) => o.onError({ status: 403 }));
    await open();
    fireEvent.click(screen.getByTestId("carry-go"));
    await waitFor(() => expect(screen.getByTestId("carry-error").textContent).toBe("Only the household owner can do this."));
  });
});
