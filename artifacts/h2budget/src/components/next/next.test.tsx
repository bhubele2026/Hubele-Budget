import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { identityOf } from "@/lib/accountIdentity";
import { AccountChip, ChartPanel, PageGrid, Panel, StatBlock, TablePanel, TxnTable, shortDate } from "./index";

afterEach(cleanup);
const chase = identityOf({ id: "1", name: "Total Checking", mask: "4821", type: "depository", subtype: "checking", institutionName: "Chase", institutionSlug: "chase" });
const amex = identityOf({ id: "2", name: "Platinum", mask: "1005", type: "credit", institutionName: "American Express", institutionSlug: "amex" });

describe("next primitives", () => {
  it("PageGrid renders the grid class and Panel carries span + accent + title", () => {
    const { container } = render(<PageGrid><Panel title="Chase" accent="checking" span={6} sub="Checking">x</Panel></PageGrid>);
    expect(container.querySelector(".grid-12")).toBeTruthy();
    const p = container.querySelector("section")!;
    expect(p.className).toContain("panel-accent-checking");
    expect(p.className).toContain("span-6");
    expect(screen.getByText("Chase")).toBeTruthy();
  });
  it("Panel with `to` makes the title a link", () => {
    render(<Panel title="Accounts" to="/next/accounts">x</Panel>);
    expect(screen.getByRole("link", { name: "Accounts" }).getAttribute("href")).toBe("/next/accounts");
  });
  it("StatBlock formats money, signs the delta, hides a zero delta", () => {
    const { rerender } = render(<StatBlock label="Checking" value={1234.5} delta={-45} hint="since Monday" />);
    expect(screen.getByText("$1,234.50")).toBeTruthy();
    expect(screen.getByTestId("stat-delta").textContent).toBe("-$45.00");
    expect(screen.getByText("since Monday")).toBeTruthy();
    rerender(<StatBlock label="Checking" value="3 items" delta={0} />);
    expect(screen.queryByTestId("stat-delta")).toBeNull();
  });
  it("AccountChip always shows the label, mask and accent", () => {
    const { container } = render(<AccountChip identity={amex} />);
    expect(screen.getByText("American Express Platinum")).toBeTruthy();
    expect(screen.getByText("••1005")).toBeTruthy();
    expect(container.querySelector('[data-accent="amex"]')).toBeTruthy();
  });
  it.each(["table", "list"] as const)("TxnTable (%s): chip + pending word + category per row; the description is a real link (Space too); the row still clicks", (layout) => {
    window.history.replaceState(null, "", "/");
    render(<TxnTable layout={layout} rows={[
      { id: "a", date: "2026-10-08", description: "Costco", amount: -82.1, identity: chase, pending: true, category: "Groceries", href: "/next/accounts/1" },
      { id: "b", date: "2026-10-07", description: "Paycheck", amount: 2000, identity: amex, pending: false },
    ]} />);
    const rows = screen.getAllByTestId("txn-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Total Checking");
    expect(rows[0]!.textContent).toContain("Pending");
    expect(rows[0]!.textContent).toContain("Groceries");
    expect(rows[1]!.textContent).toContain("Posted");
    expect(rows[1]!.textContent).toContain("Uncategorized");
    // One native, named focus stop per row that opens somewhere; none for a row that does not.
    const link = screen.getByRole("link", { name: "Costco" });
    expect(link.getAttribute("href")).toBe("/next/accounts/1");
    expect(rows[0]!.getAttribute("tabindex")).toBeNull();
    expect(screen.queryByRole("link", { name: "Paycheck" })).toBeNull();
    fireEvent.keyDown(link, { key: " " });
    expect(window.location.pathname).toBe("/next/accounts/1");
    window.history.replaceState(null, "", "/");
    fireEvent.click(rows[0]!.querySelector("[data-accent]")!); // anywhere else on the row
    expect(window.location.pathname).toBe("/next/accounts/1");
    window.history.replaceState(null, "", "/");
  });
  it.each(["table", "list"] as const)("TxnTable (%s): (WP7) a row with no href says why in its note; a row that opens never shows one", (layout) => {
    window.history.replaceState(null, "", "/");
    render(<TxnTable layout={layout} rows={[
      { id: "gone", date: "2026-10-08", description: "OLD CARD", amount: -9, identity: chase, pending: false, note: "No ledger: Chase (no longer linked)" },
      { id: "open", date: "2026-10-07", description: "Costco", amount: -82.1, identity: chase, pending: false, href: "/next/accounts/1", note: "never shown" },
      { id: "plain", date: "2026-10-06", description: "Paycheck", amount: 2000, identity: amex, pending: false },
    ]} />);
    const rows = screen.getAllByTestId("txn-row");
    const notes = screen.getAllByTestId("txn-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe("No ledger: Chase (no longer linked)");
    expect(rows[0]!.contains(notes[0]!)).toBe(true);
    expect(rows[1]!.textContent).not.toContain("never shown");
    // The row with no ledger is not a link and does not open on a click.
    expect(screen.queryByRole("link", { name: "OLD CARD" })).toBeNull();
    fireEvent.click(rows[0]!);
    expect(window.location.pathname).toBe("/");
    expect(rows[0]!.className).not.toContain("cursor-pointer");
  });
  it("TxnTable empty state and shortDate are timezone-proof", () => {
    render(<TxnTable rows={[]} />);
    expect(screen.getByText("No transactions to show.")).toBeTruthy();
    expect(shortDate("2026-01-01")).toBe("Jan 1");
    expect(shortDate("garbage")).toBe("garbage");
  });
});

describe("Panel variants (C0)", () => {
  const body = (section: Element) => section.querySelector(":scope > div")!;
  it("default: padded body, hover lift, clipped by .panel's overflow: hidden", () => {
    const { container } = render(<Panel title="Plain">x</Panel>);
    const p = container.querySelector("section")!;
    expect(p.className.split(" ")).toEqual(expect.arrayContaining(["panel", "panel-link"]));
    expect(p.className).not.toContain("panel-sticky-safe");
    expect(body(p).className).toBe("p-4");
  });
  it("flush drops the body padding; static drops the hover lift", () => {
    const { container } = render(<Panel title="Ledger" variant={["flush", "static"]}>x</Panel>);
    const p = container.querySelector("section")!;
    expect(p.className).toContain("panel-flush");
    expect(p.className).not.toContain("panel-link");
    expect(body(p).className).toBe("");
  });
  it("sticky-safe adds the overflow: clip class (index.css pins the rule)", () => {
    const { container } = render(<Panel title="Activity" variant="sticky-safe">x</Panel>);
    const p = container.querySelector("section")!;
    expect(p.className).toContain("panel-sticky-safe");
    expect(p.className).toContain("panel-link");
    expect(body(p).className).toBe("p-4");
  });
  it("ChartPanel gives the chart a fixed-height, full-width box", () => {
    const { container } = render(<ChartPanel title="Balance" height={320}><div data-testid="chart" /></ChartPanel>);
    const b = screen.getByTestId("chart").parentElement as HTMLElement;
    expect(b.style.height).toBe("320px");
    expect(b.className).toContain("w-full");
    expect(container.querySelector("section")!.className).toContain("panel");
    // default height
    cleanup();
    render(<ChartPanel title="Trend"><div data-testid="chart2" /></ChartPanel>);
    expect((screen.getByTestId("chart2").parentElement as HTMLElement).style.height).toBe("280px");
  });
  it("TablePanel is flush, carries a header row, and scrolls its rows under a max height", () => {
    const { container } = render(
      <TablePanel title="Rows" head={<span>Date · Amount</span>} maxHeight={400} variant="sticky-safe">
        <div data-testid="rows" />
      </TablePanel>,
    );
    const p = container.querySelector("section")!;
    expect(p.className).toContain("panel-flush");
    expect(p.className).toContain("panel-sticky-safe");
    expect(screen.getByTestId("table-panel-head").textContent).toBe("Date · Amount");
    const rows = screen.getByTestId("table-panel-rows");
    expect(rows.style.maxHeight).toBe("400px");
    expect(rows.className).toContain("overflow-y-auto");
    cleanup();
    render(<TablePanel title="Rows"><div /></TablePanel>);
    expect(screen.queryByTestId("table-panel-head")).toBeNull();
    expect(screen.getByTestId("table-panel-rows").className).toBe("");
  });
});

describe("StatBlock countUp", () => {
  const origMM = window.matchMedia;
  const origRaf = window.requestAnimationFrame;
  const origCaf = window.cancelAnimationFrame;
  afterEach(() => {
    window.matchMedia = origMM;
    window.requestAnimationFrame = origRaf;
    window.cancelAnimationFrame = origCaf;
  });
  const mm = (reduce: boolean) =>
    ((q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

  it("counts up from 0 to the figure, then rests on it", () => {
    let frames: FrameRequestCallback[] = [];
    window.matchMedia = mm(false);
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => (frames.push(cb), frames.length)) as never;
    window.cancelAnimationFrame = (() => {}) as never;
    render(<StatBlock label="Spent" value={1000} countUp data-testid="s" />);
    expect(screen.getByTestId("s").textContent).toContain("$0.00");
    act(() => { const f = frames; frames = []; f.forEach((cb) => cb(0)); });
    act(() => { const f = frames; frames = []; f.forEach((cb) => cb(10_000)); });
    expect(screen.getByTestId("s").textContent).toContain("$1,000.00");
  });

  it("under reduced motion shows the final figure at once", () => {
    window.matchMedia = mm(true);
    window.requestAnimationFrame = (() => 1) as never;
    render(<StatBlock label="Spent" value={1000} countUp data-testid="s" />);
    expect(screen.getByTestId("s").textContent).toContain("$1,000.00");
  });

  it("without the prop the figure is exact from the first paint", () => {
    window.matchMedia = mm(false);
    window.requestAnimationFrame = (() => 1) as never;
    render(<StatBlock label="Spent" value={1000} data-testid="s" />);
    expect(screen.getByTestId("s").textContent).toContain("$1,000.00");
  });
});
