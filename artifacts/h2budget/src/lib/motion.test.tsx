import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { makeGlideNav, takeArrival, CHUNK_WAIT_MS, GESTURE_MS } from "./motion";
import { Roll, isFigureText } from "@/components/figure-roll";

/**
 * (Every click glides, 2026-11-12) The glide's own rules. The suite's matchMedia says "reduce" (everything snaps);
 * these tests say "no-preference" so the motion paths run, and stub the View Transition the browser would run.
 */
const realMatch = window.matchMedia;
// The first page of a visit is simply there (no fade, no rises): spend it, as the app's first frame does.
expect(takeArrival("/home")).toBe("first");
let vtCalls = 0;
beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  vtCalls = 0;
  (document as unknown as { startViewTransition: (cb: () => void) => { finished: Promise<void> } }).startViewTransition = (cb) => {
    vtCalls += 1;
    cb();
    return { finished: Promise.resolve() };
  };
});
afterEach(() => {
  window.matchMedia = realMatch;
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  vi.useRealTimers();
});

const click = () => window.dispatchEvent(new Event("pointerup"));
const strip = (p: string) => p;

describe("the page glide (wouter aroundNav)", () => {
  it("a click into another page cross-fades, and the page knows it arrived crossed", () => {
    const nav = vi.fn();
    click();
    makeGlideNav(() => null, strip)(nav, "/banking");
    expect(vtCalls).toBe(1);
    expect(nav).toHaveBeenCalledWith("/banking", undefined);
    expect(takeArrival("/banking")).toBe("crossed");
    // Read once: the next mount of the same path (Back, a deep link) arrives plain.
    expect(takeArrival("/banking")).toBe("plain");
  });

  it("anything the app does by itself — no click within GESTURE_MS — goes at once", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    click();
    vi.advanceTimersByTime(GESTURE_MS + 50);
    const nav = vi.fn();
    makeGlideNav(() => null, strip)(nav, "/forecast");
    expect(vtCalls).toBe(0);
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it("a filter or a hash on the same page is not a page: no cross-fade", () => {
    const nav = vi.fn();
    click();
    makeGlideNav(() => null, strip)(nav, `${window.location.pathname}?month=2026-10#needs-you`);
    expect(vtCalls).toBe(0);
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it("waits for the page's chunk (at most CHUNK_WAIT_MS) so the fade lands on the page, not a skeleton", async () => {
    vi.useFakeTimers();
    let land!: () => void;
    const chunk = new Promise<void>((r) => (land = r));
    const nav = vi.fn();
    click();
    makeGlideNav(() => chunk, strip)(nav, "/amex");
    expect(nav).not.toHaveBeenCalled();
    land();
    await vi.advanceTimersByTimeAsync(0);
    expect(nav).toHaveBeenCalledTimes(1);
    expect(vtCalls).toBe(1);
    // A chunk that never comes still lets the click through.
    const nav2 = vi.fn();
    click();
    makeGlideNav(() => new Promise<void>(() => {}), strip)(nav2, "/debts");
    await vi.advanceTimersByTimeAsync(CHUNK_WAIT_MS + 10);
    expect(nav2).toHaveBeenCalledTimes(1);
  });

  it("reduced motion: never a cross-fade", () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const nav = vi.fn();
    click();
    makeGlideNav(() => null, strip)(nav, "/bills");
    expect(vtCalls).toBe(0);
    expect(nav).toHaveBeenCalledTimes(1);
  });
});

describe("a figure that changes ROLLS (never counts, never on first paint)", () => {
  const box = { top: 100, bottom: 130, left: 0, right: 80, width: 80, height: 30, x: 0, y: 100, toJSON() {} };
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box as DOMRect);
  });

  it("first paint: just the value", () => {
    const { container } = render(<Roll value="$1,234.00" />);
    expect(container.querySelector("[data-roll=out]")).toBeNull();
    expect(container.textContent).toBe("$1,234.00");
  });

  it("a change: the old slides out (hidden from assistive tech), the new rises in — only the two values, nothing between", () => {
    const { container, rerender } = render(<Roll value="$1,234.00" />);
    act(() => rerender(<Roll value="$980.00" />));
    const out = container.querySelector("[data-roll=out]")!;
    expect(out.textContent).toBe("$1,234.00");
    expect(out.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("$980.00").className).toContain("roll-in");
  });

  it("a dash or a word filling in with a figure is a plain swap", () => {
    const { container, rerender } = render(<Roll value="—" />);
    act(() => rerender(<Roll value="$12.00" />));
    expect(container.querySelector("[data-roll=out]")).toBeNull();
    expect(isFigureText("—")).toBe(false);
    expect(isFigureText("−$45")).toBe(true);
  });
});
