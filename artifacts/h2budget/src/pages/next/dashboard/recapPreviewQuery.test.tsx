import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { onWriteSuccess } from "@/lib/mutationInvalidation";
import { useRecapPreviewQ } from "./RecapPreview";

// (D14) Opening the morning-text preview asks for the recap once, never marks the
// spine / reports / ledger stale, and a reopen inside ten minutes asks nothing.

const BODY = { model: null, template: { text: "Template summary." }, facts: {} };

function setup() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(BODY), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  // Same wiring as App.tsx: every successful mutation runs the after-write rule.
  const holder: { qc?: QueryClient } = {};
  const qc = new QueryClient({
    mutationCache: new MutationCache({
      onSuccess: (_d, _v, _c, mutation) => onWriteSuccess(holder.qc!, mutation),
    }),
    defaultOptions: { queries: { staleTime: 5 * 60_000 } },
  });
  holder.qc = qc;
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { fetchMock, invalidate, wrapper };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useRecapPreviewQ", () => {
  it("asks once per open, invalidates nothing, and a reopen inside ten minutes asks nothing", async () => {
    const { fetchMock, invalidate, wrapper } = setup();
    const first = renderHook(() => useRecapPreviewQ(), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    first.unmount();

    const second = renderHook(() => useRecapPreviewQ(), { wrapper });
    await waitFor(() => expect(second.result.current.data).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("a failed preview is not retried on its own (a retry would be a second model call)", async () => {
    const { fetchMock, wrapper } = setup();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
    const h = renderHook(() => useRecapPreviewQ(), { wrapper });
    await waitFor(() => expect(h.result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
