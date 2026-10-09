import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemoryItem } from "@workspace/api-client-react/features";

// (F8) Settings › Memory — ported from h2's `ask/askPages.test.tsx` "Memory".

const mocks = vi.hoisted(() => ({
  put: null as unknown as ReturnType<typeof vi.fn>,
  del: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("@workspace/api-client-react/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react/features")>();
  return {
    ...actual,
    usePutMemory: () => ({ mutateAsync: mocks.put, isPending: false }),
    useDeleteMemory: () => ({ mutateAsync: mocks.del, isPending: false }),
  };
});
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import { MemoryView, NEVER_STORED, type MemoryRead } from "./MemoryTab";

const NOW = new Date("2026-10-07T15:00:00Z");
const mem = (id: string, scope: MemoryItem["scope"], key: string, text: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  scope,
  key,
  value: { text },
  source: "user_stated",
  createdByKind: "user",
  memberUserId: null,
  updatedAt: "2026-10-05T12:00:00Z",
  ...over,
} as MemoryItem);
const loaded = (data: MemoryItem[] | undefined, over: Partial<MemoryRead> = {}): MemoryRead => ({
  data,
  state: data === undefined ? "cold" : "loaded",
  isFetching: false,
  refetch: vi.fn(),
  ...over,
});
const mount = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const MEMS = [
  mem("k1", "categorization", "sample_diner", "Sample Diner is Dining out."),
  mem("k2", "categorization", "corner_market", "Corner Market is Groceries.", {
    source: "inferred",
    value: { text: "Corner Market is Groceries.", evidence: ["txn-aaa111"] },
  } as Partial<MemoryItem>),
  mem("k3", "spending", "weekend_limit", "Weekends under $150.", { source: "agent_proposed", memberUserId: "u1" }),
];

beforeEach(() => {
  mocks.put = vi.fn().mockResolvedValue({});
  mocks.del = vi.fn().mockResolvedValue(undefined);
  toastMock.mockClear();
});
afterEach(cleanup);

describe("Memory", () => {
  it("grouped by topic, key and value as words, the source in words, evidence as links, and the never-stored line", () => {
    mount(<MemoryView memories={loaded(MEMS)} now={NOW} />);
    expect(screen.getByTestId("memory-categorization").className).toContain("span-6");
    expect(screen.getByTestId("memory-spending")).toBeTruthy();
    expect(screen.queryByTestId("memory-debt")).toBeNull();
    const rows = screen.getAllByTestId("memory-item");
    expect(rows[0]!.textContent).toContain("Sample diner");
    expect(rows.map((r) => /You said|H2 inferred|H2 proposed/.exec(r.textContent!)![0])).toEqual([
      "You said",
      "H2 inferred",
      "H2 proposed",
    ]);
    // Evidence opens the Chase ledger on that charge (classic has no /activity).
    expect(within(rows[1]!).getByTestId("memory-evidence").getAttribute("href")).toBe("/transactions?tx=txn-aaa111");
    expect(screen.getByTestId("memory-foot").textContent).toBe(NEVER_STORED);
    expect(NEVER_STORED).toBe("H2 never stores account numbers or balances here.");
  });

  it("edit sends the new value with the note's scope and key (PUT)", async () => {
    mount(<MemoryView memories={loaded(MEMS)} now={NOW} />);
    fireEvent.click(within(screen.getAllByTestId("memory-item")[0]!).getByTestId("memory-edit"));
    const box = await screen.findByTestId("memory-edit-input");
    fireEvent.change(box, { target: { value: "Sample Diner is Fun." } });
    fireEvent.click(screen.getByTestId("memory-save"));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(mocks.put).toHaveBeenCalledWith({ scope: "categorization", key: "sample_diner", data: { value: "Sample Diner is Fun." } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ title: "Saved. H2 will use your words." }));
  });

  it("a member's own note stays theirs when edited; an empty edit sends nothing", async () => {
    mount(<MemoryView memories={loaded(MEMS)} now={NOW} />);
    fireEvent.click(within(screen.getAllByTestId("memory-item")[2]!).getByTestId("memory-edit"));
    const box = await screen.findByTestId("memory-edit-input");
    fireEvent.change(box, { target: { value: "  " } });
    fireEvent.click(screen.getByTestId("memory-save"));
    expect(mocks.put).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toBe("Write something, or forget this note instead.");
    fireEvent.change(box, { target: { value: "Under $120." } });
    fireEvent.click(screen.getByTestId("memory-save"));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith({ scope: "spending", key: "weekend_limit", data: { value: "Under $120.", mine: true } }),
    );
  });

  it("delete asks first, then calls DELETE with the note's id", async () => {
    mount(<MemoryView memories={loaded(MEMS)} now={NOW} />);
    fireEvent.click(within(screen.getAllByTestId("memory-item")[1]!).getByTestId("memory-delete"));
    expect(mocks.del).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("memory-forget-yes"));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith({ id: "k2" }));
  });

  it("empty, cold and failed states are words", () => {
    mount(<MemoryView memories={loaded([])} now={NOW} />);
    expect(screen.getByTestId("memory-empty").textContent).toContain("H2 hasn't kept any notes yet.");
    cleanup();
    mount(<MemoryView memories={loaded(undefined)} now={NOW} />);
    expect(screen.getByTestId("memory-skeleton")).toBeTruthy();
    cleanup();
    mount(<MemoryView memories={loaded(undefined, { state: "failed" })} now={NOW} />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load what H2 remembers.");
  });
});
