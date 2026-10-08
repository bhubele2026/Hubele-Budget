import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { PlanLine } from "@/lib/forecastMatch";

// The rows themselves are not under test — only which of them mount.
vi.mock("./PlanDropRow", () => ({
  PlanDropRow: ({ row }: { row: { itemId: string } }) => <div data-testid="plan-row">{row.itemId}</div>,
}));
vi.mock("./CashFreedBanner", () => ({ CashFreedBanner: () => <div data-testid="banner" /> }));

import { PlannedItemsList, type PlannedItem } from "./PlannedItemsList";

const ROW = 73;
const VIEWPORT = 800;
const items: PlannedItem[] = Array.from({ length: 300 }, (_, i) => ({
  kind: "plan",
  key: `k${i}`,
  row: { itemId: `item-${i}`, date: "2026-10-09" } as unknown as PlanLine,
}));
const noop = () => {};
const list = () => (
  <PlannedItemsList
    items={items}
    payoffsByItem={new Map()}
    bestSuggestionPlanKey={null}
    highlightedPlanKey={null}
    activeDragId={null}
    onSelectPlan={noop}
    onMoveStart={noop}
    onMarkMissed={noop}
  />
);
const shown = () => screen.queryAllByTestId("plan-row").map((r) => Number(r.textContent!.slice(5)));

// jsdom has no layout: the shell's <main> is VIEWPORT tall, every row ROW tall.
let restore: () => void = noop;
beforeEach(() => {
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-shell-scroller") ? VIEWPORT : ROW;
    },
  });
  restore = () => Object.defineProperty(HTMLElement.prototype, "offsetHeight", desc);
});
afterEach(() => {
  cleanup();
  restore();
});

describe("PlannedItemsList virtualizes against the shell's <main> (C0, parity review D7)", () => {
  it("mounts only a screenful, and follows <main> as it scrolls", () => {
    const { container } = render(<main data-shell-scroller="">{list()}</main>);
    const main = container.querySelector("main")!;
    let top = 0;
    Object.defineProperty(main, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = v; } });

    const first = shown();
    expect(first.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThan(40); // virtualized, not 300
    expect(Math.min(...first)).toBe(0);

    // The window never scrolls in the shell — this must not move anything.
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(shown()).toEqual(first);

    // <main> scrolls 150 rows down: the rows there mount, the top ones go.
    act(() => {
      main.scrollTop = 150 * ROW;
      main.dispatchEvent(new Event("scroll"));
    });
    const later = shown();
    expect(later).toContain(150);
    expect(later).not.toContain(0);
    expect(Math.max(...later)).toBeLessThan(200);
  });

  it("the box is as tall as the rows (no scrollMargin subtracted twice)", () => {
    render(<main data-shell-scroller="">{list()}</main>);
    const box = screen.getByTestId("planned-items-virtual").firstElementChild as HTMLElement;
    expect(box.style.height).toBe(`${300 * ROW}px`);
  });

  it("outside the shell there is no scroller to follow, so every row renders rather than a blank list", () => {
    render(<div>{list()}</div>);
    expect(shown()).toHaveLength(300);
  });
});
