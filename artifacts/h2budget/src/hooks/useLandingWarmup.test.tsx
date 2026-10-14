import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const pre = vi.hoisted(() => ({ chunks: [] as string[] }));
vi.mock("@/lib/routePrefetch", () => ({ prefetchRoute: (h: string) => pre.chunks.push(h) }));

import { useLandingWarmup, WARMUP_GIVE_UP_MS, WARMUP_QUIET_MS } from "./useLandingWarmup";

function Probe() {
  useLandingWarmup();
  return null;
}
let qc: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  pre.chunks.length = 0;
  qc = new QueryClient();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const mount = () => render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);

describe("useLandingWarmup (P4)", () => {
  it("starts only after the dashboard's own queries have settled and a quiet moment has passed", async () => {
    let release: (v: number) => void = () => {};
    void qc.fetchQuery({ queryKey: ["dash"], queryFn: () => new Promise<number>((r) => { release = r; }) });
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(pre.chunks).toEqual([]);
    await act(async () => { release(1); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WARMUP_QUIET_MS - 50); });
    expect(pre.chunks).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(pre.chunks[0]).toBe("/banking");
  });

  it("a new request in flight cancels a pending start", async () => {
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(WARMUP_QUIET_MS - 100); });
    let release: (v: number) => void = () => {};
    void qc.fetchQuery({ queryKey: ["late"], queryFn: () => new Promise<number>((r) => { release = r; }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(pre.chunks).toEqual([]);
    await act(async () => { release(1); await vi.advanceTimersByTimeAsync(WARMUP_QUIET_MS + 50); });
    expect(pre.chunks[0]).toBe("/banking");
  });

  it("a request that never settles cannot starve the warm-up for good", async () => {
    void qc.fetchQuery({ queryKey: ["forever"], queryFn: () => new Promise<number>(() => {}) });
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(WARMUP_GIVE_UP_MS + 100); });
    expect(pre.chunks[0]).toBe("/banking");
  });
});
