import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/** (Q6b round 2) The Summary panel: title from the page's selection, the period's "Why over?" link, reserved height, focus. */
vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string }) => <a href={href} data-testid={rest["data-testid"]}>{children}</a>,
}));
vi.mock("@/components/amex-pay-mode", () => ({ CardPayModes: () => null }));

import { AmexSummaryPanel, AmexNeedsAttention, whyOverPath } from "./amex-summary";

const total = (amount: string, count: number) => ({ amount, count });
const summary = (over: Record<string, unknown> = {}) =>
  ({
    scope: { kind: "all", accountId: null, name: null, mask: null, institution: null, cards: [] },
    period: { from: "2026-09-01", to: "2026-09-30", timezone: "America/Chicago" },
    owed: { current: "100.00", statement: null, asOf: null, source: "plaid" },
    purchases: { amount: "10.00", count: 1, reimbursable: total("0.00", 0) },
    refunds: total("0.00", 0), payments: total("0.00", 0), otherCredits: total("0.00", 0), otherCharges: total("0.00", 0), notMine: total("0.00", 0),
    householdContribution: { weeklyPlan: "0.00", weeklyKnown: "0.00", weeklyUnresolved: "0.00", monthlyPlan: "0.00", monthlyKnown: "0.00", monthlyUnresolved: "0.00", unfiled: "0.00", link: "/spending/week" },
    planLink: { kind: "weekly_hook", payoff: "0.00", payoffDate: "2026-09-30", basis: "plan", debtId: null, name: null, minimum: null, avalancheRank: null, status: null },
    needsAttention: {
      unplanned: { amount: "40.00", count: 2, truncated: false, rows: [] },
      unfiled: { amount: "0.00", count: 0, truncated: false, rows: [] },
      uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
      truncated: false,
    },
    limitations: [],
    ...over,
  }) as never;

const panel = (props: Record<string, unknown> = {}) =>
  render(<AmexSummaryPanel summary={summary()} failed={false} periodLabel="September 2026" mode="mo" isThisWeek={false} figure={null} onFigure={() => undefined} {...props} />);

afterEach(() => cleanup());

describe("whyOverPath", () => {
  it("this week -> the week page; a past month -> that month; a year -> the month holding its end; no period -> the bare month", () => {
    expect(whyOverPath("wk", true, { from: "2026-10-11", to: "2026-10-17" })).toBe("/spending/week");
    expect(whyOverPath("mo", false, { from: "2026-09-01", to: "2026-09-30" })).toBe("/spending/month?start=2026-09-01");
    expect(whyOverPath("mo", true, { from: "2026-10-01", to: "2026-10-31" })).toBe("/spending/month?start=2026-10-01");
    expect(whyOverPath("yr", false, { from: "2025-01-01", to: "2025-12-31" })).toBe("/spending/month?start=2025-12-31");
    expect(whyOverPath("mo", false, null)).toBe("/spending/month");
  });
  it("the panel links the Summary's own period, not the current one", () => {
    panel();
    expect(screen.getByTestId("amex-household-link").getAttribute("href")).toBe("/spending/month?start=2026-09-01");
  });
});

describe("title follows the page's selection", () => {
  it("one card selected, summary loading: the card, never 'All cards'", () => {
    panel({ summary: undefined, allCards: false, cardTitle: "Platinum ••1005" });
    expect(screen.getByRole("heading", { name: "Platinum ••1005" })).toBeTruthy();
  });
  it("one card selected, summary failed: still the card", () => {
    panel({ summary: undefined, failed: true, allCards: false, cardTitle: "Platinum ••1005" });
    expect(screen.getByRole("heading", { name: "Platinum ••1005" })).toBeTruthy();
  });
  it("All cards selected says All cards", () => {
    panel({ allCards: true, cardTitle: null });
    expect(screen.getByRole("heading", { name: "All cards" })).toBeTruthy();
  });
});

describe("height while the next answer loads", () => {
  it("the skeleton keeps the height of the answer it replaces", () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 312 });
    try {
      const r = panel();
      r.rerender(<AmexSummaryPanel summary={undefined} failed={false} periodLabel="September 2026" mode="mo" isThisWeek={false} figure={null} onFigure={() => undefined} />);
      expect((screen.getByTestId("amex-summary-loading") as HTMLElement).style.height).toBe("312px");
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", desc);
    }
  });
});

describe("keyboard focus", () => {
  it("'N to review' moves focus to the Needs attention heading", () => {
    const s = summary();
    render(
      <>
        <AmexSummaryPanel summary={s} failed={false} periodLabel="x" mode="mo" isThisWeek={false} figure={null} onFigure={() => undefined} />
        <AmexNeedsAttention summary={s} showCard={false} onOpenRow={() => undefined} />
      </>,
    );
    fireEvent.click(screen.getByText("2 to review"));
    const h = screen.getByRole("heading", { name: "Needs attention" });
    expect(document.activeElement).toBe(h);
    expect(h.getAttribute("tabindex")).toBe("-1");
    expect(h.className).toContain("focus:ring-2");
  });
  it("Retry keeps focus on the Summary heading", () => {
    const retry = vi.fn();
    panel({ summary: undefined, failed: true, allCards: true, onRetry: retry });
    fireEvent.click(screen.getByTestId("amex-summary-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "All cards" }));
  });
});
