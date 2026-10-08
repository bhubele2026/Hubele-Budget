import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { identityOf } from "@/lib/accountIdentity";
import { AccountChip, PageGrid, Panel, StatBlock, TxnTable, shortDate } from "./index";

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
  it("TxnTable: chip + pending word + category per row, Enter opens the row", () => {
    window.history.replaceState(null, "", "/");
    render(<TxnTable rows={[
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
    expect(rows[0]!.getAttribute("tabindex")).toBe("0");
    expect(rows[1]!.getAttribute("tabindex")).toBeNull();
    fireEvent.keyDown(rows[0]!, { key: "Enter" });
    expect(window.location.pathname).toBe("/next/accounts/1");
    window.history.replaceState(null, "", "/");
  });
  it("TxnTable empty state and shortDate are timezone-proof", () => {
    render(<TxnTable rows={[]} />);
    expect(screen.getByText("No transactions to show.")).toBeTruthy();
    expect(shortDate("2026-01-01")).toBe("Jan 1");
    expect(shortDate("garbage")).toBe("garbage");
  });
});
