import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * (E5, Task 5) Spending › This week: the Amex line says where the Amex
 * purchases went — the server's partition (`reconciliation`), words only.
 * Synthetic figures.
 */
const h = vi.hoisted(() => ({ data: undefined as unknown, params: [] as Array<Record<string, unknown>> }));
vi.mock("@workspace/api-client-react/features", () => ({
  useGetAmexSummary: (p: Record<string, unknown>) => {
    h.params.push(p);
    return { data: h.data };
  },
  getGetAmexSummaryQueryKey: (p: unknown) => ["/api/amex/summary", p],
}));

import { AmexWeekLine, amexWeekWords } from "./AmexWeekLine";

const LABELS = [
  ["weekly_known", "This week's plan"],
  ["weekly_unresolved", "This week's plan, awaiting a decision"],
  ["monthly_known", "Monthly allowance"],
  ["monthly_unresolved", "Monthly allowance, awaiting a decision"],
  ["bills", "Bills"],
  ["unplanned", "Unplanned"],
  ["reimbursable", "Reimbursable"],
  ["not_counted", "Not counted"],
  ["no_bucket", "Not placed"],
] as const;
type Key = (typeof LABELS)[number][0];
type T = [string, number];
const recon = (o: { purchases: T; groups?: Partial<Record<Key, T>>; unresolved?: T; refunds?: T }) => ({
  purchases: { amount: o.purchases[0], count: o.purchases[1] },
  refunds: { amount: o.refunds?.[0] ?? "0.00", count: o.refunds?.[1] ?? 0 },
  net: "0.00",
  unresolved: { amount: o.unresolved?.[0] ?? "0.00", count: o.unresolved?.[1] ?? 0 },
  ties: true,
  groups: LABELS.map(([key, label]) => ({
    key, label, amount: o.groups?.[key]?.[0] ?? "0.00", count: o.groups?.[key]?.[1] ?? 0, rows: [], truncated: false,
  })),
});
const answer = (r: ReturnType<typeof recon>) => {
  h.data = { purchases: { amount: r.purchases.amount, count: r.purchases.count }, reconciliation: r };
};
const line = (o: { isCurrent?: boolean; open?: string[]; onToggle?: (t: string) => void } = {}) =>
  render(
    <AmexWeekLine start="2026-10-11" end="2026-10-17" isCurrent={o.isCurrent ?? true} open={o.open ?? []} onToggle={o.onToggle ?? (() => {})} routeOf={() => ({ kind: "none", href: null, label: "", note: null, identity: {} as never })} />,
  );
const words = () => screen.getByTestId("sp-amex-week-words").textContent;

afterEach(() => {
  cleanup();
  h.data = undefined;
  h.params = [];
});

describe("(Task 5) Spending week: the Amex line", () => {
  it("weekly + monthly: purchases, this week's plan, monthly allowance — the server's own figures; the tile's key", () => {
    answer(recon({ purchases: ["425.00", 5], groups: { weekly_known: ["300.00", 3], monthly_known: ["125.00", 2] } }));
    line();
    expect(words()).toBe("Amex purchases $425.00 · this week's plan $300.00 · monthly allowance $125.00");
    expect(h.params[0]).toEqual({ accountId: "all", from: "2026-10-11", to: "2026-10-17" });
    expect(screen.getByTestId("sp-amex-week-link").textContent).toBe("Breakdown");
  });

  it("weekly only: no monthly part, never a $0.00 group", () => {
    answer(recon({ purchases: ["80.00", 2], groups: { weekly_known: ["80.00", 2] } }));
    line();
    expect(words()).toBe("Amex purchases $80.00 · this week's plan $80.00");
    expect(words()).not.toMatch(/\$0\.00/);
  });

  it("unresolved present: 'awaiting a decision $W', the server's total of the two unresolved groups", () => {
    answer(recon({ purchases: ["140.00", 3], groups: { weekly_known: ["100.00", 2], weekly_unresolved: ["40.00", 1] }, unresolved: ["40.00", 1] }));
    line();
    expect(words()).toBe("Amex purchases $140.00 · this week's plan $100.00 · awaiting a decision $40.00");
  });

  it("empty week: 'No Amex purchases this week', no Breakdown; another week says 'that week'", () => {
    answer(recon({ purchases: ["0.00", 0] }));
    line();
    expect(words()).toBe("No Amex purchases this week");
    expect(screen.queryByTestId("sp-amex-week-link")).toBeNull();
    cleanup();
    line({ isCurrent: false });
    expect(words()).toBe("No Amex purchases that week");
  });

  it("refunds: not in the line (credits, beside the total); Breakdown opens them", async () => {
    answer(recon({ purchases: ["60.00", 1], groups: { weekly_known: ["60.00", 1] }, refunds: ["15.00", 1] }));
    line({ open: ["amex"] });
    expect(words()).toBe("Amex purchases $60.00 · this week's plan $60.00");
    expect((await screen.findByTestId("sp-amex-refunds")).textContent).toBe("Refunds −$15.00 · credits, not in the total");
  });

  it("at most three groups inline, in the server's order; the rest wait in Breakdown", () => {
    answer(recon({ purchases: ["150.00", 5], groups: { weekly_known: ["10.00", 1], monthly_known: ["20.00", 1], bills: ["30.00", 1], unplanned: ["40.00", 1], reimbursable: ["50.00", 1] } }));
    line();
    expect(words()).toBe("Amex purchases $150.00 · this week's plan $10.00 · monthly allowance $20.00 · bills $30.00");
  });

  it("Breakdown asks the page to open it (the address holds it); open, it draws the reconciliation", async () => {
    answer(recon({ purchases: ["80.00", 2], groups: { weekly_known: ["80.00", 2] } }));
    const toggle = vi.fn();
    line({ onToggle: toggle });
    expect(screen.queryByTestId("sp-amex-breakdown")).toBeNull();
    fireEvent.click(screen.getByTestId("sp-amex-week-link"));
    expect(toggle).toHaveBeenCalledWith("amex");
    cleanup();
    line({ open: ["amex"] });
    expect(await screen.findByTestId("sp-amex-breakdown")).toBeTruthy();
    expect(screen.getByTestId("sp-amex-week").hasAttribute("open")).toBe(true);
  });

  it("draws nothing without an answer (never $0.00)", () => {
    const { container } = line();
    expect(container.textContent).toBe("");
  });

  it("a group outside the plans reads in its own words: not counted, not placed", () => {
    const r = recon({ purchases: ["37.34", 2], groups: { not_counted: ["25.00", 1], no_bucket: ["12.34", 1] } });
    expect(amexWeekWords(r as never, true)).toBe("Amex purchases $37.34 · not counted $25.00 · not placed $12.34");
  });
});
