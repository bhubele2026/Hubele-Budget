import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { _resetPerfMarksForTests, markReady, observeWebVitals, startPerfNavigation, usePageReadyMark, useReadyMark } from "./perfMarks";

type MarkCall = [string, { detail?: { nav: number; path?: string } } | undefined];

describe("perfMarks", () => {
  let calls: MarkCall[];
  beforeEach(() => {
    _resetPerfMarksForTests();
    calls = [];
    vi.spyOn(performance, "mark").mockImplementation(((name: string, opts?: MarkCall[1]) => {
      calls.push([name, opts]);
      return undefined as unknown as PerformanceMark;
    }) as typeof performance.mark);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { __h2perf?: unknown }).__h2perf;
  });

  it("marks a name once per page view, and again after a route change", () => {
    markReady("h2:home-numbers-ready");
    markReady("h2:home-numbers-ready");
    expect(calls).toEqual([["h2:home-numbers-ready", { detail: { nav: 0 } }]]);
    startPerfNavigation("/forecast");
    markReady("h2:home-numbers-ready");
    expect(calls.slice(1)).toEqual([
      ["h2:nav", { detail: { nav: 1, path: "/forecast" } }],
      ["h2:home-numbers-ready", { detail: { nav: 1 } }],
    ]);
  });

  it("useReadyMark waits for ready, then marks after the commit, once", () => {
    function Box({ ready, n }: { ready: boolean; n: number }) {
      useReadyMark("h2:page-ready:/amex", ready);
      return <span>{n}</span>;
    }
    const { rerender } = render(<Box ready={false} n={1} />);
    expect(calls).toEqual([]);
    rerender(<Box ready n={2} />);
    rerender(<Box ready n={3} />);
    rerender(<Box ready={false} n={4} />);
    rerender(<Box ready n={5} />);
    expect(calls.map((c) => c[0])).toEqual(["h2:page-ready:/amex"]);
  });

  it("usePageReadyMark names the page it is on", () => {
    window.history.pushState({}, "", "/review?x=1");
    function Line({ ready }: { ready: boolean }) {
      usePageReadyMark(ready);
      return null;
    }
    const { rerender } = render(<Line ready={false} />);
    rerender(<Line ready />);
    expect(calls.map((c) => c[0])).toEqual(["h2:page-ready:/review"]);
    window.history.pushState({}, "", "/");
  });

  it("never throws where marks or observers are missing", () => {
    (performance.mark as unknown as { mockImplementation: (f: () => never) => void }).mockImplementation(() => {
      throw new TypeError("no details here");
    });
    expect(() => markReady("h2:x")).not.toThrow();
    expect(() => startPerfNavigation("/x")).not.toThrow();
    const PO = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = undefined;
    try {
      expect(() => observeWebVitals()).not.toThrow();
    } finally {
      (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = PO;
    }
  });

  it("keeps LCP, CLS (without recent input) and the longest interaction in window.__h2perf", () => {
    const observers: Array<{ type: string; cb: (l: { getEntries: () => unknown[] }) => void }> = [];
    class FakePO {
      static supportedEntryTypes = ["largest-contentful-paint", "layout-shift", "event"];
      constructor(private cb: (l: { getEntries: () => unknown[] }) => void) {}
      observe(o: { type: string }) {
        observers.push({ type: o.type, cb: this.cb });
      }
    }
    const PO = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = FakePO;
    try {
      observeWebVitals();
      const feed = (type: string, entries: unknown[]) => observers.find((o) => o.type === type)!.cb({ getEntries: () => entries });
      feed("largest-contentful-paint", [{ startTime: 800 }, { startTime: 1450 }]);
      feed("layout-shift", [{ value: 0.02 }, { value: 0.5, hadRecentInput: true }, { value: 0.01 }]);
      feed("event", [{ interactionId: 0, duration: 400 }, { interactionId: 7, duration: 96 }, { interactionId: 8, duration: 40 }]);
      const s = (window as unknown as { __h2perf: { lcp: number; cls: number; inp: number } }).__h2perf;
      expect(s.lcp).toBe(1450);
      expect(s.cls).toBeCloseTo(0.03, 5);
      expect(s.inp).toBe(96);
    } finally {
      (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = PO;
    }
  });
});
