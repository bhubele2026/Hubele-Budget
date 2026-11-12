import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The real route map and its speculative rule; only the chunk LOAD is a stand-in, recording which page was asked.
const pre = vi.hoisted(() => ({ importers: [] as Array<() => Promise<unknown>> }));
vi.mock("@/lib/lazyWithPreload", () => ({
  preloadImporter: (imp: () => Promise<unknown>) => {
    pre.importers.push(imp);
    return Promise.resolve({ default: () => null });
  },
  loadedModule: () => null,
}));

import { getGetForecastQueryKey, getListDebtsQueryKey } from "@workspace/api-client-react";
import { getGetBankingNeedsYouQueryKey } from "@workspace/api-client-react/features";
import { _resetRoutePrefetchForTests, routeImporters } from "@/lib/routePrefetch";
import { _resetPerfMarksForTests, markReady, startPerfNavigation } from "@/lib/perfMarks";
import { _resetSpeculativeForTests, noteChartsLoaded, trackChunk } from "@/lib/speculative";
import {
  _resetLandingWarmupForTests,
  HOME_MARKS,
  STAGE_GAP_MS,
  useLandingWarmup,
  WARMUP_GIVE_UP_MS,
  WARMUP_QUIET_MS,
} from "./useLandingWarmup";

/**
 * (perf phase 2) THE WARM-UP WAITS FOR THE REAL NUMBERS, AND SKIPS A SLOW OR SAVING CONNECTION.
 * On a throttled phone the old warm-up and the layout's idle warm pulled the area pages' chunks while Home's
 * numbers were still on their way, and those answers queued behind ~650 KB of guesses.
 */

function Probe() {
  useLandingWarmup();
  return null;
}
let qc: QueryClient;
let keys: string[];
const hrefsWarmed = () =>
  pre.importers.map((imp) => Object.keys(routeImporters).find((k) => routeImporters[k] === imp) ?? "?");
const mount = () => render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const numbersIn = () => act(async () => { for (const m of HOME_MARKS) markReady(m); });
const ALL_STAGES = 6 * STAGE_GAP_MS;

function setNavigator(o: { saveData?: boolean; effectiveType?: string; deviceMemory?: number }) {
  Object.defineProperty(navigator, "connection", {
    value: { saveData: o.saveData ?? false, effectiveType: o.effectiveType ?? "4g" },
    configurable: true,
  });
  Object.defineProperty(navigator, "deviceMemory", { value: o.deviceMemory, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  pre.importers.length = 0;
  _resetPerfMarksForTests();
  _resetSpeculativeForTests();
  _resetLandingWarmupForTests();
  _resetRoutePrefetchForTests();
  setNavigator({});
  qc = new QueryClient();
  keys = [];
  vi.spyOn(qc, "prefetchQuery").mockImplementation(((o: { queryKey: unknown }) => {
    keys.push(JSON.stringify(o.queryKey));
    return Promise.resolve();
  }) as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useLandingWarmup — after the real numbers, never ahead of them", () => {
  it("does not start before BOTH Home marks, however quiet the page is", async () => {
    mount();
    await tick(5_000);
    expect(pre.importers).toEqual([]);
    await act(async () => { markReady("h2:home-numbers-ready"); });
    await tick(5_000);
    expect(pre.importers).toEqual([]);
    await act(async () => { markReady("h2:weekly-pay-ready"); });
    await tick(WARMUP_QUIET_MS + 300);
    expect(hrefsWarmed()[0]).toBe("/banking");
  });

  it("marks in, but a query still in flight: it waits for the quiet", async () => {
    let release: (v: number) => void = () => {};
    void qc.fetchQuery({ queryKey: ["dash"], queryFn: () => new Promise<number>((r) => { release = r; }) });
    mount();
    await numbersIn();
    await tick(5_000);
    expect(pre.importers).toEqual([]);
    await act(async () => { release(1); });
    await tick(WARMUP_QUIET_MS + 300);
    expect(hrefsWarmed()[0]).toBe("/banking");
  });

  it("a lazy chunk still loading counts as foreground too", async () => {
    let arrive: () => void = () => {};
    void trackChunk(new Promise<void>((r) => (arrive = r)));
    mount();
    await numbersIn();
    await tick(5_000);
    expect(pre.importers).toEqual([]);
    await act(async () => { arrive(); });
    await tick(WARMUP_QUIET_MS + 300);
    expect(hrefsWarmed()[0]).toBe("/banking");
  });

  it("marks that never come (a failed read): it stops waiting for them after the give-up, never sooner", async () => {
    mount();
    await tick(WARMUP_GIVE_UP_MS - 500);
    expect(pre.importers).toEqual([]);
    await tick(1_000);
    expect(hrefsWarmed()[0]).toBe("/banking");
  });

  it("no unconditional fire: a request that never settles holds it off for good", async () => {
    void qc.fetchQuery({ queryKey: ["forever"], queryFn: () => new Promise<number>(() => {}) });
    mount();
    await numbersIn();
    await tick(WARMUP_GIVE_UP_MS * 4);
    expect(pre.importers).toEqual([]);
    expect(keys).toEqual([]);
  });

  for (const [why, nav] of [
    ["Save-Data", { saveData: true }],
    ["a 3G connection", { effectiveType: "3g" }],
    ["a 2G connection", { effectiveType: "2g" }],
    ["slow 2G", { effectiveType: "slow-2g" }],
    ["a 2 GB device", { deviceMemory: 2 }],
  ] as const) {
    it(`skipped on ${why}: no chunk, no data`, async () => {
      setNavigator(nav);
      mount();
      await numbersIn();
      await tick(WARMUP_GIVE_UP_MS * 2);
      expect(pre.importers).toEqual([]);
      expect(keys).toEqual([]);
    });
  }

  it("a 4G connection on a 4 GB device warms", async () => {
    setNavigator({ effectiveType: "4g", deviceMemory: 4 });
    mount();
    await numbersIn();
    await tick(WARMUP_QUIET_MS + 300);
    expect(pre.importers.length).toBeGreaterThan(0);
  });

  it("leaving Home cancels it: before it starts, nothing; mid-way, the later stages never run", async () => {
    const a = mount();
    await tick(1_000);
    a.unmount();
    await numbersIn();
    await tick(WARMUP_GIVE_UP_MS * 2);
    expect(pre.importers).toEqual([]);

    _resetPerfMarksForTests();
    const b = mount();
    await numbersIn();
    await tick(WARMUP_QUIET_MS + 300);
    const soFar = pre.importers.length;
    expect(soFar).toBeGreaterThan(0);
    startPerfNavigation("/banking");
    b.unmount();
    await tick(ALL_STAGES * 2);
    expect(pre.importers.length).toBe(soFar);
  });

  it("the next likely pages only, and never a page that would bring the chart library before a chart did", async () => {
    mount();
    await numbersIn();
    await tick(WARMUP_QUIET_MS + 300 + ALL_STAGES);
    // Banking and the Forecast overview carry no charts; Review, Spending and the payoff plan do.
    expect(hrefsWarmed()).toEqual(["/banking", "/forecast/overview"]);
    // Their DATA is still warmed, under the pages' own keys: /forecast's default horizon, the debts, Banking's Needs you.
    expect(keys).toContain(JSON.stringify(getGetForecastQueryKey({ days: 90 })));
    expect(keys).toContain(JSON.stringify(getListDebtsQueryKey()));
    await vi.waitFor(() => expect(keys).toContain(JSON.stringify(getGetBankingNeedsYouQueryKey())));
  });

  it("once a chart on screen has loaded the library, the chart pages are warmed too", async () => {
    noteChartsLoaded();
    mount();
    await numbersIn();
    await tick(WARMUP_QUIET_MS + 300 + ALL_STAGES);
    expect(hrefsWarmed()).toEqual(["/banking", "/forecast/overview", "/forecast", "/reports/spending", "/avalanche"]);
  });

  it("the forecast warm is exactly the key /forecast asks at its default horizon", () => {
    expect(getGetForecastQueryKey({ days: 90 })).toEqual(["/api/forecast", { days: 90 }]);
  });

  it("once per document: a re-mounted landing does not warm twice", async () => {
    const a = mount();
    await numbersIn();
    await tick(WARMUP_QUIET_MS + 300 + ALL_STAGES);
    const n = pre.importers.length;
    a.unmount();
    mount();
    await tick(WARMUP_GIVE_UP_MS * 2);
    expect(pre.importers.length).toBe(n);
  });
});
