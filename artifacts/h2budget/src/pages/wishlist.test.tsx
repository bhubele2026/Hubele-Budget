import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

/** (F6) The wish list page, ported from the frozen h2 app's askPages wish-list tests. */

const m = vi.hoisted(() => ({
  items: [] as unknown[],
  create: vi.fn(async (_a: unknown) => ({})),
  update: vi.fn(async (_a: unknown) => ({})),
  evaluate: vi.fn(),
}));
vi.mock("@workspace/api-client-react/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react/features")>()),
  useListWishlist: () => ({ data: { items: m.items, waitDays: 7 }, isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateWishlistItem: () => ({ mutateAsync: m.create, isPending: false }),
  useUpdateWishlistItem: () => ({ mutateAsync: m.update, isPending: false }),
  useEvaluateWishlistItem: () => ({ mutateAsync: m.evaluate, isPending: false }),
}));
vi.mock("@/components/afford/AffordLauncher", () => ({
  AffordLauncher: () => <button data-testid="afford-open">Can we afford something?</button>,
}));

import WishlistPage from "./wishlist";

const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  amount: 480,
  url: null,
  categoryId: null,
  targetDate: null,
  requestedBy: "u1",
  requestedAt: "2026-10-05T12:00:00Z",
  waitingUntil: "2026-10-12",
  waitingDaysLeft: 5,
  decision: "pending",
  decidedAt: null,
  ...over,
});
const mount = () => render(<QueryClientProvider client={new QueryClient()}><WishlistPage /></QueryClientProvider>);

beforeEach(() => {
  m.items = [];
  m.create.mockClear();
  m.update.mockClear();
});
afterEach(() => cleanup());

describe("Wish list page", () => {
  it("title, amount, asked date, 'Wait until'; decided items sit apart without controls; the Afford launcher", () => {
    m.items = [
      item("w1", "Standing desk"),
      item("w2", "Rain jacket", { waitingDaysLeft: 0, decision: "approved", amount: 120 }),
      item("w3", "Board game", { decision: "bought", amount: 45 }),
    ];
    mount();
    const live = within(screen.getByTestId("wish-active")).getAllByTestId("wish-item");
    expect(live).toHaveLength(2);
    expect(live[0]!.textContent).toContain("Standing desk");
    expect(live[0]!.textContent).toContain("$480.00");
    expect(within(live[0]!).getByTestId("wish-wait").textContent).toBe("Wait until Oct 12");
    expect(within(live[1]!).getByTestId("wish-wait").textContent).toBe("Waiting period over");
    const done = within(screen.getByTestId("wish-decided")).getAllByTestId("wish-item");
    expect(done).toHaveLength(1);
    expect(within(done[0]!).queryByTestId("wish-bought")).toBeNull();
    expect(screen.getByTestId("afford-open")).toBeTruthy();
  });

  it("Bought and Dropped send the decision", async () => {
    m.items = [item("w1", "Standing desk")];
    mount();
    fireEvent.click(screen.getByTestId("wish-bought"));
    await waitFor(() => expect(m.update).toHaveBeenCalledWith({ id: "w1", data: { decision: "bought" } }));
    fireEvent.click(screen.getByTestId("wish-dropped"));
    await waitFor(() => expect(m.update).toHaveBeenCalledWith({ id: "w1", data: { decision: "declined" } }));
  });

  it("Add: needs a title, takes dollars and an optional link, and sends the body", async () => {
    mount();
    expect(screen.getByTestId("wishlist-note")).toBeTruthy();
    fireEvent.click(screen.getByTestId("wish-add"));
    fireEvent.click(await screen.findByTestId("wish-save"));
    expect(m.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("wish-title"), { target: { value: "Rain jacket" } });
    fireEvent.change(screen.getByTestId("wish-amount"), { target: { value: "$1,120.50" } });
    fireEvent.change(screen.getByTestId("wish-url"), { target: { value: "https://example.com/jacket" } });
    fireEvent.click(screen.getByTestId("wish-save"));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith({ data: { title: "Rain jacket", amount: 1120.5, url: "https://example.com/jacket" } });
  });

  it("title alone is enough; a bad link is refused", async () => {
    mount();
    fireEvent.click(screen.getByTestId("wish-add"));
    fireEvent.change(await screen.findByTestId("wish-title"), { target: { value: "Lamp" } });
    fireEvent.change(screen.getByTestId("wish-url"), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByTestId("wish-save"));
    expect(m.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("wish-url"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("wish-save"));
    await waitFor(() => expect(m.create).toHaveBeenCalledWith({ data: { title: "Lamp" } }));
  });

  it("Check now shows the server's verdict word and the figure after", async () => {
    m.items = [item("w1", "Standing desk")];
    m.evaluate.mockResolvedValue({
      lastEvaluation: { evaluatedAt: "2026-10-07T12:00:00Z", verdict: "tight", safeToSpendNowAfter: "10.00", availableUntilPaydayAfter: "820.25" },
    });
    mount();
    fireEvent.click(screen.getByTestId("wish-check"));
    expect((await screen.findByTestId("wish-eval-word")).textContent).toBe("Tight");
    expect(screen.getByTestId("wish-eval-after").textContent).toContain("$820.25");
  });
});
