import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * (Task 5) The Amex reconciliation opened from the Spending week's Amex line:
 * groups (label · amount · count), their purchases, each linking to its Amex
 * row, "and N more", refunds beside. Synthetic figures.
 */
vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

import AmexWeekBreakdown, { amexMoreHref } from "./AmexWeekBreakdown";

const CARD = { accountId: "p-plat", name: "Platinum", mask: "1001" };
const r = (id: string, amount: string, o: Record<string, unknown> = {}) => ({
  id, date: "2026-10-12", displayName: `Shop ${id}`, amount, pending: false, card: CARD, notes: [] as string[], ...o,
});
const g = (key: string, label: string, amount: string, count: number, rows: unknown[] = [], truncated = false) => ({ key, label, amount, count, rows, truncated });
const REC = {
  purchases: { amount: "188.49", count: 6 },
  refunds: { amount: "12.00", count: 1 },
  net: "176.49",
  unresolved: { amount: "35.00", count: 1 },
  ties: true,
  groups: [
    g("weekly_known", "This week's plan", "110.50", 3, [r("a", "48.00"), r("b", "40.00", { date: "2026-10-16" })], true),
    g("weekly_unresolved", "This week's plan, awaiting a decision", "35.00", 1, [r("c", "35.00", { notes: ["not_filed", "no_category"] })]),
    g("monthly_known", "Monthly allowance", "43.00", 2, [r("d", "30.00", { card: { accountId: "p-blue", name: "Blue Cash", mask: "2002" } }), r("e", "13.00", { pending: true, notes: ["pending"] })]),
    g("monthly_unresolved", "Monthly allowance, awaiting a decision", "0.00", 0),
    g("bills", "Bills", "0.00", 0),
    g("unplanned", "Unplanned", "0.00", 0),
    g("reimbursable", "Reimbursable", "0.00", 0),
    g("not_counted", "Not counted", "0.00", 0),
    g("no_bucket", "Not placed", "0.00", 0),
  ],
};
const routeOf = (row: { id: string; date: string; card: { accountId: string } }) =>
  row.id === "e"
    ? { kind: "unknown" as const, href: null, label: "", note: null, identity: {} as never }
    : { kind: "account" as const, href: `/amex?card=${row.card.accountId}&month=${row.date.slice(0, 7)}-01&tx=${row.id}`, label: "", note: null, identity: {} as never };

function show(o: { open?: string[]; isCurrent?: boolean; rec?: unknown; onToggle?: (t: string) => void } = {}) {
  return render(
    <AmexWeekBreakdown
      rec={(o.rec ?? REC) as never}
      start="2026-10-11"
      end="2026-10-17"
      isCurrent={o.isCurrent ?? true}
      open={o.open ?? ["amex"]}
      onToggle={o.onToggle ?? (() => {})}
      routeOf={routeOf as never}
    />,
  );
}

afterEach(cleanup);

describe("(Task 5) the Amex week breakdown", () => {
  it("one scope line, then one line per group that holds a purchase: label · amount · count", () => {
    show();
    expect(screen.getByTestId("sp-amex-scope").textContent).toBe("All Amex cards · Oct 11 – Oct 17");
    const lines = screen.getAllByTestId(/^sp-amex-group-(?!amount)/).map((el) => el.querySelector("summary")!.textContent);
    expect(lines).toEqual([
      "This week's plan$110.50 · 3 purchases",
      "This week's plan, awaiting a decision$35.00 · 1 purchase",
      "Monthly allowance$43.00 · 2 purchases",
    ]);
    // A group with no purchase is not drawn (never a $0.00 line).
    expect(screen.queryByTestId("sp-amex-group-bills")).toBeNull();
    // Closed groups list no rows.
    expect(screen.queryAllByTestId("sp-amex-row")).toHaveLength(0);
  });

  it("a group opens through the address token amex:<key>", () => {
    const toggle = vi.fn();
    show({ onToggle: toggle });
    fireEvent.click(within(screen.getByTestId("sp-amex-group-monthly_known")).getByText("Monthly allowance"));
    expect(toggle).toHaveBeenCalledWith("amex:monthly_known");
  });

  it("open: each purchase — date · merchant · amount · card ••mask · notes — links to its Amex row", () => {
    show({ open: ["amex", "amex:weekly_unresolved", "amex:monthly_known"] });
    const rows = screen.getAllByTestId("sp-amex-row");
    expect(rows.map((el) => el.textContent)).toEqual([
      "Oct 12Shop c$35.00Platinum ••1001Not filed yet · No category",
      "Oct 12Shop d$30.00Blue Cash ••2002",
      "Oct 12Shop e$13.00Platinum ••1001Pending",
    ]);
    const links = screen.getAllByTestId("sp-amex-row-link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/amex?card=p-plat&month=2026-10-01&tx=c", "/amex?card=p-blue&month=2026-10-01&tx=d"]);
    // A row whose ledger is not known yet opens nowhere, and claims nothing.
    expect(within(rows[2]!).queryByRole("link")).toBeNull();
  });

  it("a truncated group says 'and N more → open in Amex' (this week: /amex; another week: its month)", () => {
    show({ open: ["amex", "amex:weekly_known"] });
    const more = screen.getByTestId("sp-amex-more-weekly_known");
    expect(more.textContent).toBe("and 1 more → open in Amex");
    expect(more.getAttribute("href")).toBe("/amex");
    expect(amexMoreHref("2026-10-10", false)).toBe("/amex?month=2026-10-01&mode=month");
  });

  it("refunds stand beside the total; none, no line", () => {
    show();
    expect(screen.getByTestId("sp-amex-refunds").textContent).toBe("Refunds −$12.00 · credits, not in the total");
    cleanup();
    show({ rec: { ...REC, refunds: { amount: "0.00", count: 0 } } });
    expect(screen.queryByTestId("sp-amex-refunds")).toBeNull();
  });
});
