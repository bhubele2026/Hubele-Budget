import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryCache, useQuery } from "@tanstack/react-query";
import React from "react";
import {
  olderWords,
  recordDataAsOf,
  resetDataAsOf,
  snapshotAtOf,
  snapshotState,
  useDataAsOfMark,
  useOlderSnapshot,
} from "./dataAsOf";

/**
 * (T1, H2) No older bank reading ever shows as current. Synthetic.
 * T1 = the earlier reading ($432.00), T2 = the newer one ($0.00).
 */
const T1 = "2026-10-14T12:00:00.000Z";
const T2 = "2026-10-15T12:02:00.000Z";
const asOf = (snapshotAt: string | null) => ({ dataAsOf: { snapshotAt, computedAt: "2026-10-15T14:00:00.000Z" } });

afterEach(() => {
  cleanup();
  resetDataAsOf();
});

describe("the high-water mark", () => {
  it("keeps the NEWEST reading seen; an older or missing one never lowers it", () => {
    const { result } = renderHook(() => useDataAsOfMark());
    expect(result.current).toBeNull();
    act(() => recordDataAsOf(asOf(T1)));
    expect(result.current).toBe(T1);
    act(() => recordDataAsOf(asOf(T2)));
    expect(result.current).toBe(T2);
    act(() => {
      recordDataAsOf(asOf(T1));
      recordDataAsOf(asOf(null));
      recordDataAsOf({ unrelated: true });
      recordDataAsOf(undefined);
      recordDataAsOf([1, 2, 3]);
    });
    expect(result.current).toBe(T2);
    act(() => resetDataAsOf());
    expect(result.current).toBeNull();
  });

  it("reads `dataAsOf.snapshotAt` only", () => {
    expect(snapshotAtOf(asOf(T1))).toBe(T1);
    expect(snapshotAtOf({ dataAsOf: null })).toBeNull();
    expect(snapshotAtOf({ snapshotAt: T1 })).toBeNull();
    expect(snapshotAtOf(null)).toBeNull();
  });

  it("older = strictly before the mark; the same moment written another way is current; no reading is unknown", () => {
    expect(snapshotState(T1, T2)).toBe("older");
    expect(snapshotState(T2, T2)).toBe("current");
    expect(snapshotState("2026-10-15T07:02:00-05:00", T2)).toBe("current");
    expect(snapshotState(T2, null)).toBe("current");
    expect(snapshotState(null, T2)).toBe("unknown");
    expect(snapshotState("not a time", T2)).toBe("unknown");
    expect(olderWords(T1)).toBe("Earlier reading (Oct 14) — updating…");
  });
});

describe("⭐ (H2) an older answer after a newer one: labelled, asked again ONCE, never current", () => {
  function Card({ q }: { q: { data: unknown; isPlaceholderData?: boolean; refetch: () => unknown } }) {
    const o = useOlderSnapshot(q);
    return <div data-testid="card" data-older={o.older ? "true" : "false"}>{o.words ?? "current"}</div>;
  }

  it("the spine read T2; the 5-minute /forecast still answers T1 with $432.00 → 'Earlier reading', one refetch", () => {
    const refetch = vi.fn();
    act(() => recordDataAsOf(asOf(T2)));
    const stale = { data: { ...asOf(T1), bankSnapshot: { balance: "432.00" } }, refetch };
    const { rerender } = render(<Card q={stale} />);
    expect(screen.getByTestId("card").textContent).toBe("Earlier reading (Oct 14) — updating…");
    expect(screen.getByTestId("card").getAttribute("data-older")).toBe("true");
    expect(refetch).toHaveBeenCalledTimes(1);
    // A re-render with the same older answer does not ask again (no loop).
    rerender(<Card q={{ ...stale }} />);
    expect(refetch).toHaveBeenCalledTimes(1);
    // The fresh answer arrives: current.
    rerender(<Card q={{ data: asOf(T2), refetch }} />);
    expect(screen.getByTestId("card").textContent).toBe("current");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("(H8) a placeholder — another key's answer kept while this one loads — is never judged or refetched", () => {
    const refetch = vi.fn();
    act(() => recordDataAsOf(asOf(T2)));
    render(<Card q={{ data: asOf(T1), isPlaceholderData: true, refetch }} />);
    expect(screen.getByTestId("card").textContent).toBe("current");
    expect(refetch).not.toHaveBeenCalled();
  });

  it("an answer with no reading at all is never guarded (unknown is not older)", () => {
    const refetch = vi.fn();
    act(() => recordDataAsOf(asOf(T2)));
    render(<Card q={{ data: asOf(null), refetch }} />);
    expect(screen.getByTestId("card").textContent).toBe("current");
    expect(refetch).not.toHaveBeenCalled();
  });

  it("App's QueryCache records it: any successful query naming a newer reading moves the mark", async () => {
    const qc = new QueryClient({
      queryCache: new QueryCache({ onSuccess: (d) => recordDataAsOf(d) }),
      defaultOptions: { queries: { retry: false } },
    });
    function Reader() {
      useQuery({ queryKey: ["/api/spine"], queryFn: async () => asOf(T2) });
      return <span data-testid="mark">{useDataAsOfMark() ?? "none"}</span>;
    }
    render(
      <QueryClientProvider client={qc}>
        <Reader />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(T2)).toBeTruthy();
  });
});
