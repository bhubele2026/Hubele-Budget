import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CssBars, type CssBarRow } from "./cssBars";
import { CHART } from "./chartTokens";

afterEach(() => cleanup());

// CssBars is the primitive behind every hover-scrubbed / frequently-updating
// list in the app (biggest charges, per-debt progress). Its whole reason to
// exist is that recharts restarts its draw on any data-reference change, so a
// list driven by a hover strobes. The invariants that make the CSS version
// glide instead are pinned here.

const ROWS: CssBarRow[] = [
  { id: "groceries", label: "Groceries", value: 400 },
  { id: "fuel", label: "Fuel", value: -200 },
  { id: "dining", label: "Dining", value: 100 },
  { id: "flat", label: "Flat", value: 0 },
];

const money = (n: number) => `$${Math.round(n)}`;

/** jsdom may serialise an inline hex as rgb(); accept either form. */
const rgbOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const bgOf = (el: Element) => {
  const s = (el as HTMLElement).style;
  return s.background || s.backgroundColor;
};
const expectColor = (el: Element, hex: string) =>
  expect([hex, rgbOf(hex)]).toContain(bgOf(el));

/** Every mounted row, ignoring the accessibility tree. */
const mountedRows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[role="listitem"]'));
/** The bar inside a row — the only element in it carrying `rounded-sm`. */
const barIn = (row: Element) => {
  const bar = row.querySelector(".rounded-sm");
  if (!bar) throw new Error("row has no bar element");
  return bar;
};
/** A row's label text (the first truncating span), independent of its value. */
const labelOf = (row: Element) =>
  row.querySelector(".truncate")?.textContent ?? "";
const rowByLabel = (c: HTMLElement, label: string) => {
  const hit = mountedRows(c).find((r) => labelOf(r) === label);
  if (!hit) throw new Error(`no row for ${label}`);
  return hit;
};

describe("CssBars — rows are never unmounted", () => {
  it("keeps every row in the DOM even when topN hides most of them", () => {
    // Unmounting a hidden row is what makes a scrub jump: React tears the node
    // down and rebuilds it somewhere else instead of sliding it.
    const { container } = render(
      <CssBars rows={ROWS} format={money} topN={2} ariaLabel="Spend by category" />,
    );
    expect(mountedRows(container)).toHaveLength(ROWS.length);
  });

  it("hides the rows outside topN from the accessibility tree and from the pointer", () => {
    const { container } = render(<CssBars rows={ROWS} format={money} topN={2} />);
    // Only the two largest by magnitude (400, -200) are visible.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    const hidden = rowByLabel(container, "Flat") as HTMLElement;
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
    expect(hidden.style.opacity).toBe("0");
    expect(hidden.style.pointerEvents).toBe("none");
    expect(hidden.tabIndex).toBe(-1);
  });

  it("names the list for screen readers", () => {
    render(<CssBars rows={ROWS} format={money} ariaLabel="Spend by category" />);
    expect(screen.getByRole("list", { name: "Spend by category" })).toBeTruthy();
  });
});

describe("CssBars — rank is a transform, not a reorder", () => {
  it("positions each row by its magnitude rank, largest first", () => {
    const { container } = render(
      <CssBars rows={ROWS} format={money} rowHeight={28} />,
    );
    // Ranked by |value|: 400, -200, 100, 0.
    expect((rowByLabel(container, "Groceries") as HTMLElement).style.transform)
      .toBe("translateY(0px)");
    expect((rowByLabel(container, "Fuel") as HTMLElement).style.transform)
      .toBe("translateY(28px)");
    expect((rowByLabel(container, "Dining") as HTMLElement).style.transform)
      .toBe("translateY(56px)");
    expect((rowByLabel(container, "Flat") as HTMLElement).style.transform)
      .toBe("translateY(84px)");
  });

  it("keeps DOM order stable when the values change rank", () => {
    // Same rows, re-valued so Dining becomes the biggest. The DOM order must
    // NOT change — only each row's transform.
    const { container, rerender } = render(<CssBars rows={ROWS} format={money} />);
    const orderBefore = mountedRows(container).map(labelOf);

    const reValued = ROWS.map((r) =>
      r.id === "dining" ? { ...r, value: 9_000 } : r,
    );
    rerender(<CssBars rows={reValued} format={money} />);

    expect(mountedRows(container).map(labelOf)).toEqual(orderBefore);
    expect((rowByLabel(container, "Dining") as HTMLElement).style.transform)
      .toBe("translateY(0px)");
  });

  it("locks the container height to the visible row count so it cannot resize mid-scrub", () => {
    const { container } = render(
      <CssBars rows={ROWS} format={money} topN={3} rowHeight={28} />,
    );
    const list = container.querySelector('[role="list"]') as HTMLElement;
    expect(list.style.height).toBe("84px");
  });
});

describe("CssBars — rankBy: a domain order instead of bar length", () => {
  // The debt payoff list is ordered by the month each debt dies, which has
  // nothing to do with how big its bar is. Without an explicit rank the list
  // would silently re-sort itself into a different plan than the one the
  // simulator runs.
  const PAYOFF_ORDER: Record<string, number> = {
    dining: 0,
    flat: 1,
    groceries: 2,
    fuel: 3,
  };
  const rankBy = (r: CssBarRow) => PAYOFF_ORDER[r.id] ?? 99;

  it("positions rows by the supplied rank, not by magnitude", () => {
    const { container } = render(
      <CssBars rows={ROWS} format={money} rowHeight={28} rankBy={rankBy} />,
    );
    // Magnitude order would be Groceries, Fuel, Dining, Flat. The supplied
    // order wins.
    expect((rowByLabel(container, "Dining") as HTMLElement).style.transform)
      .toBe("translateY(0px)");
    expect((rowByLabel(container, "Flat") as HTMLElement).style.transform)
      .toBe("translateY(28px)");
    expect((rowByLabel(container, "Groceries") as HTMLElement).style.transform)
      .toBe("translateY(56px)");
    expect((rowByLabel(container, "Fuel") as HTMLElement).style.transform)
      .toBe("translateY(84px)");
  });

  it("colours the ramp by the supplied rank, so the first item to be paid is darkest", () => {
    const rows: CssBarRow[] = [
      { id: "big", label: "Big", value: 900 },
      { id: "small", label: "Small", value: 100 },
    ];
    const { container } = render(
      <CssBars
        rows={rows}
        format={money}
        ramp
        // "Small" dies first, so it takes the darkest navy even though its bar
        // is the shorter one.
        rankBy={(r) => (r.id === "small" ? 0 : 1)}
      />,
    );
    expectColor(barIn(rowByLabel(container, "Small")), CHART.navy);
    expect(bgOf(barIn(rowByLabel(container, "Big")))).not.toBe(
      bgOf(barIn(rowByLabel(container, "Small"))),
    );
  });

  it("still keeps DOM order stable when the rank changes", () => {
    const { container, rerender } = render(
      <CssBars rows={ROWS} format={money} rowHeight={28} rankBy={rankBy} />,
    );
    const orderBefore = mountedRows(container).map(labelOf);

    // A payment lands and Fuel is now first to be paid off.
    const reRanked = (r: CssBarRow) => (r.id === "fuel" ? -1 : rankBy(r));
    rerender(
      <CssBars rows={ROWS} format={money} rowHeight={28} rankBy={reRanked} />,
    );

    expect(mountedRows(container).map(labelOf)).toEqual(orderBefore);
    expect((rowByLabel(container, "Fuel") as HTMLElement).style.transform)
      .toBe("translateY(0px)");
  });

  it("defaults to magnitude rank when no rankBy is given", () => {
    const { container } = render(
      <CssBars rows={ROWS} format={money} rowHeight={28} />,
    );
    expect((rowByLabel(container, "Groceries") as HTMLElement).style.transform)
      .toBe("translateY(0px)");
  });
});

describe("CssBars — value to width", () => {
  it("scales bar widths against the largest visible magnitude", () => {
    const { container } = render(<CssBars rows={ROWS} format={money} />);
    // Max magnitude is 400.
    expect((barIn(rowByLabel(container, "Groceries")) as HTMLElement).style.width)
      .toBe("100%");
    expect((barIn(rowByLabel(container, "Fuel")) as HTMLElement).style.width)
      .toBe("50%");
    expect((barIn(rowByLabel(container, "Dining")) as HTMLElement).style.width)
      .toBe("25%");
    expect((barIn(rowByLabel(container, "Flat")) as HTMLElement).style.width)
      .toBe("0%");
  });

  it("rescales the visible bars when topN drops the largest rows", () => {
    // The scale follows the visible set, so trimming the list re-stretches the
    // survivors across the full track instead of leaving them as slivers.
    const rows: CssBarRow[] = [
      { id: "huge", label: "Huge", value: 10_000 },
      { id: "a", label: "A", value: 100 },
      { id: "b", label: "B", value: 50 },
    ];
    const { container, rerender } = render(<CssBars rows={rows} format={money} />);
    expect((barIn(rowByLabel(container, "A")) as HTMLElement).style.width).toBe("1%");

    // Hide "Huge" by moving it out of the rows list entirely.
    rerender(<CssBars rows={rows.slice(1)} format={money} />);
    expect((barIn(rowByLabel(container, "A")) as HTMLElement).style.width).toBe("100%");
    expect((barIn(rowByLabel(container, "B")) as HTMLElement).style.width).toBe("50%");
  });

  it("tolerates a topN larger than the row list", () => {
    const { container } = render(<CssBars rows={ROWS} format={money} topN={99} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(ROWS.length);
    expect((barIn(rowByLabel(container, "Groceries")) as HTMLElement).style.width)
      .toBe("100%");
  });

  it("halves the width in delta mode, where bars diverge from a centre line", () => {
    const { container } = render(
      <CssBars rows={ROWS} format={money} mode="delta" />,
    );
    const up = barIn(rowByLabel(container, "Groceries")) as HTMLElement;
    const down = barIn(rowByLabel(container, "Fuel")) as HTMLElement;
    // A positive bar starts at the centre line and grows right.
    expect(up.style.width).toBe("50%");
    expect(up.style.left).toBe("50%");
    // A negative bar grows leftwards, so its RIGHT edge lands on the centre
    // line: left + width must equal 50%.
    expect(down.style.width).toBe("25%");
    expect(down.style.left).toBe("25%");
  });
});

describe("CssBars — sign to colour", () => {
  it("draws navy up, deep orange down, mist flat", () => {
    const { container } = render(<CssBars rows={ROWS} format={money} />);
    expectColor(barIn(rowByLabel(container, "Groceries")), CHART.navy);
    expectColor(barIn(rowByLabel(container, "Fuel")), CHART.orangeDeep);
    expectColor(barIn(rowByLabel(container, "Flat")), CHART.mist);
  });

  it("switches to the sequential navy ramp by rank when asked", () => {
    const rows: CssBarRow[] = [
      { id: "a", label: "A", value: 300 },
      { id: "b", label: "B", value: 200 },
      { id: "c", label: "C", value: 100 },
    ];
    const { container } = render(<CssBars rows={rows} format={money} ramp />);
    // Rank 0 is the darkest navy; the rest walk toward the light end.
    expectColor(barIn(rowByLabel(container, "A")), CHART.navy);
    const bs = [
      bgOf(barIn(rowByLabel(container, "A"))),
      bgOf(barIn(rowByLabel(container, "B"))),
      bgOf(barIn(rowByLabel(container, "C"))),
    ];
    expect(new Set(bs).size).toBe(3);
  });
});

describe("CssBars — the number is always printed", () => {
  it("prints every row's formatted value, so colour is never the only signal", () => {
    const { container } = render(<CssBars rows={ROWS} format={money} />);
    const text = container.textContent ?? "";
    expect(text).toContain("$400");
    expect(text).toContain("$-200");
    expect(text).toContain("$100");
  });

  it("renders values in mono tabular numerals so digits do not jitter", () => {
    const { container } = render(<CssBars rows={ROWS} format={money} />);
    const value = rowByLabel(container, "Groceries").querySelector(".tabular-nums");
    expect(value).toBeTruthy();
    expect(value?.className).toContain("font-mono");
  });
});
