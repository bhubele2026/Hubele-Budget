import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

/**
 * (Q6b round 2 → P1) The Summary panel: titled by its period, the period's household
 * link, the To-review buttons, reserved height, focus. Synthetic figures.
 */
vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string }) => <a href={href} data-testid={rest["data-testid"]}>{children}</a>,
}));
const link = vi.hoisted(() => ({ periods: [] as unknown[] }));
vi.mock("@/components/amex-over-link", () => ({
  AmexOverLink: ({ href, period }: { href: string; period: unknown }) => {
    link.periods.push(period);
    return <a href={href} data-testid="amex-household-link">link</a>;
  },
}));

import { AmexSummaryPanel, trackedDebtWords, whyOverPath } from "./amex-summary";

const total = (amount: string, count: number) => ({ amount, count });
const summary = (over: Record<string, unknown> = {}) =>
  ({
    scope: { kind: "all", accountId: null, name: null, mask: null, institution: null, cards: [] },
    period: { from: "2026-09-01", to: "2026-09-30", timezone: "America/Chicago" },
    owed: { current: "100.00", statement: null, asOf: null, source: "plaid", tracked: null },
    purchases: { amount: "10.00", count: 1, reimbursable: total("0.00", 0) },
    refunds: total("0.00", 0), payments: total("0.00", 0), otherCredits: total("0.00", 0), otherCharges: total("0.00", 0), notMine: total("0.00", 0),
    householdContribution: { weeklyPlan: "0.00", weeklyKnown: "0.00", weeklyUnresolved: "0.00", monthlyPlan: "0.00", monthlyKnown: "0.00", monthlyUnresolved: "0.00", unfiled: "0.00", link: "/spending/week" },
    planLink: { kind: "weekly_hook", payoff: "0.00", payoffDate: "2026-09-30", basis: "plan", debtId: null, name: null, minimum: null, avalancheRank: null, status: null },
    needsAttention: {
      unplanned: { amount: "40.00", count: 2, truncated: false, rows: [] },
      unfiled: { amount: "85.00", count: 1, truncated: false, rows: [] },
      uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
      truncated: false,
    },
    limitations: [],
    ...over,
  }) as never;

type Props = Partial<React.ComponentProps<typeof AmexSummaryPanel>>;
const BASE = {
  failed: false,
  title: "September 2026",
  mode: "mo" as const,
  isThisWeek: false,
  figure: null,
  onFigure: () => undefined,
  allCards: true,
  linkPeriod: { kind: "month" as const, start: "2026-09-01", monthName: "September" },
};
const panel = (props: Props = {}) => render(<AmexSummaryPanel summary={summary()} {...BASE} {...props} />);

afterEach(() => {
  cleanup();
  link.periods.length = 0;
});

describe("whyOverPath", () => {
  it("this week -> the week page; a past month -> that month; a year -> the month holding its end; no period -> the bare month", () => {
    expect(whyOverPath("wk", true, { from: "2026-10-11", to: "2026-10-17" })).toBe("/spending/week");
    expect(whyOverPath("mo", false, { from: "2026-09-01", to: "2026-09-30" })).toBe("/spending/month?start=2026-09-01");
    expect(whyOverPath("mo", true, { from: "2026-10-01", to: "2026-10-31" })).toBe("/spending/month?start=2026-10-01");
    expect(whyOverPath("yr", false, { from: "2025-01-01", to: "2025-12-31" })).toBe("/spending/month?start=2025-12-31");
    expect(whyOverPath("mo", false, null)).toBe("/spending/month");
  });
  it("the panel links the Summary's own period, and hands the link the period it reads the plan for", () => {
    panel();
    expect(screen.getByTestId("amex-household-link").getAttribute("href")).toBe("/spending/month?start=2026-09-01");
    expect(link.periods.at(-1)).toEqual({ kind: "month", start: "2026-09-01", monthName: "September" });
  });
});

describe("(P1) the title is the period; the card is named in the page's header", () => {
  it("a period title, loaded, loading or failed", () => {
    panel({ title: "This week · Oct 11 – 17" });
    expect(screen.getByRole("heading", { name: "This week · Oct 11 – 17" })).toBeTruthy();
    cleanup();
    panel({ summary: undefined, allCards: false });
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeTruthy();
    expect(screen.getByTestId("amex-summary").textContent).not.toContain("All cards");
    cleanup();
    panel({ summary: undefined, failed: true, allCards: false });
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeTruthy();
  });
  it("All cards shows its By card list; one card shows how it is paid, and the Owed figure links its history", () => {
    const onHistory = vi.fn();
    panel({ byCard: <div data-testid="by-card" />, payBlock: <div data-testid="pay-block" />, onOwedHistory: onHistory });
    expect(screen.getByTestId("by-card")).toBeTruthy();
    expect(screen.queryByTestId("pay-block")).toBeNull();
    expect(screen.queryByTestId("amex-owed-history-link")).toBeNull();
    cleanup();
    panel({ allCards: false, byCard: <div data-testid="by-card" />, payBlock: <div data-testid="pay-block" />, onOwedHistory: onHistory });
    expect(screen.queryByTestId("by-card")).toBeNull();
    expect(screen.getByTestId("pay-block")).toBeTruthy();
    fireEvent.click(screen.getByTestId("amex-owed-history-link"));
    expect(onHistory).toHaveBeenCalledTimes(1);
  });
  it("figures use the KPI step and readable labels", () => {
    panel();
    const owed = screen.getByTestId("amex-fig-owed");
    expect(owed.querySelector(".text-kpi")!.textContent).toBe("$100.00");
    expect(within(owed).getByText("Owed").className).toContain("text-label");
  });
});

describe("(Task 6, matrix) Owed is the card's figure; the payoff plan's own figure is said beside it when they differ", () => {
  const tracked = (balance: string, source: "plaid" | "manual") => ({ debtId: "d1", name: "Sample Card", balance, source, asOf: "2026-09-01T15:00:00.000Z" });
  it("a typed debt balance: both figures, where each comes from, and a link to the payoff plan", () => {
    const owed = { current: "1240.10", statement: null, asOf: null, source: "plaid", tracked: tracked("2875.40", "manual") };
    expect(trackedDebtWords(owed as never)).toBe("Payoff plan $2,875.40 · typed, not from the card");
    render(<AmexSummaryPanel summary={summary({ owed })} {...BASE} allCards={false} />);
    expect(screen.getByTestId("amex-fig-owed").textContent).toContain("$1,240.10");
    expect(screen.getByTestId("amex-owed-tracked").textContent).toBe("Payoff plan $2,875.40 · typed, not from the card · Payoff plan");
    expect(screen.getByTestId("amex-owed-tracked-link").getAttribute("href")).toBe("/avalanche");
  });
  it("the same figure, no debt, or an unknown Owed: nothing more is said", () => {
    expect(trackedDebtWords({ current: "1240.10", tracked: tracked("1240.10", "plaid") } as never)).toBeNull();
    expect(trackedDebtWords({ current: "1240.10", tracked: null } as never)).toBeNull();
    expect(trackedDebtWords({ current: null, tracked: tracked("10.00", "manual") } as never)).toBeNull();
    expect(trackedDebtWords({ current: "10.00", tracked: tracked("12.00", "plaid") } as never)).toBe("Payoff plan $12.00 · from the card's last sync");
    panel();
    expect(screen.queryByTestId("amex-owed-tracked")).toBeNull();
  });
});

describe("(P1) the To-review line", () => {
  it("one button per group with a count, said and priced; pressing one narrows the activity", () => {
    const onAttention = vi.fn();
    panel({ onAttention });
    const line = screen.getByTestId("amex-review-count");
    expect(line.textContent).toContain("To review:");
    expect(screen.getByTestId("amex-attn-unplanned").textContent).toBe("2 unplanned · $40.00");
    expect(screen.getByTestId("amex-attn-unfiled").textContent).toBe("1 not filed yet · $85.00");
    expect(screen.queryByTestId("amex-attn-uncategorized")).toBeNull();
    expect(screen.getByTestId("amex-attn-unfiled").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("amex-attn-unfiled"));
    expect(onAttention).toHaveBeenCalledWith("unfiled");
  });
  it("the pressed group says so, and pressing it again clears it", () => {
    const onAttention = vi.fn();
    panel({ attention: "unplanned", onAttention });
    expect(screen.getByTestId("amex-attn-unplanned").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("amex-attn-unplanned"));
    expect(onAttention).toHaveBeenCalledWith(null);
  });
  it("nothing to review says so", () => {
    panel({
      summary: summary({
        needsAttention: {
          unplanned: { amount: "0.00", count: 0, truncated: false, rows: [] },
          unfiled: { amount: "0.00", count: 0, truncated: false, rows: [] },
          uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
          truncated: false,
        },
      }),
    });
    expect(screen.getByTestId("amex-attn-none").textContent).toBe("Nothing to review in this period.");
  });
});

describe("height while the next answer loads", () => {
  it("the skeleton keeps the height of the answer it replaces", () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 312 });
    try {
      const r = panel();
      r.rerender(<AmexSummaryPanel summary={undefined} {...BASE} />);
      expect((screen.getByTestId("amex-summary-loading") as HTMLElement).style.height).toBe("312px");
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", desc);
    }
  });
});

describe("keyboard focus", () => {
  it("Retry keeps focus on the Summary heading", () => {
    const retry = vi.fn();
    panel({ summary: undefined, failed: true, onRetry: retry });
    fireEvent.click(screen.getByTestId("amex-summary-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "September 2026" }));
  });
});
