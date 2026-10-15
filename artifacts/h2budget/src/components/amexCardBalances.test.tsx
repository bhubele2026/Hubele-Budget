import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { AmexSummary } from "@workspace/api-client-react";
import { AmexCardBalances } from "./amex-card-balances";

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

/** (Q3) "All cards" lists each card's own balance — never a combined walk. Synthetic cards. */
const card = (accountId: string, name: string, mask: string | null, owed: string | null) => ({
  accountId, name, mask, institution: "American Express", brand: "silver", cadence: "weekly",
  debtLinked: false, debtId: null, owed, purchases: { amount: "0.00", count: 0 },
});
const summary = (kind: "all" | "card", cards: ReturnType<typeof card>[]) =>
  ({ scope: { kind, accountId: null, name: null, mask: null, institution: null, cards } }) as unknown as AmexSummary;

afterEach(() => cleanup());

describe("(Q3) AmexCardBalances", () => {
  it("lists each card by name and ••mask with its balance; unknown is —, never $0.00", () => {
    const onSelect = vi.fn();
    render(
      <AmexCardBalances
        summary={summary("all", [card("a", "Platinum", "1002", "1234.5"), card("b", "Blue Cash", null, null)])}
        failed={false}
        pending={false}
        masks={new Map([["b", "2003"]])}
        onSelect={onSelect}
      />,
    );
    const a = screen.getByTestId("amex-card-balance-a");
    expect(screen.getByTestId("amex-card-owed-a").textContent).toBe("$1,234.50");
    expect(a.textContent).toContain("Platinum ••1002");
    expect(a.getAttribute("aria-label")).toBe("Platinum ••1002: owed $1,234.50, purchases $0.00");
    const b = screen.getByTestId("amex-card-balance-b");
    expect(b.textContent).toContain("Blue Cash ••2003");
    expect(screen.getByTestId("amex-card-owed-b").textContent).toBe("—");
    expect(b.textContent).not.toContain("$0.00—");
    fireEvent.click(b);
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("(P1) the By card list: each card's owed, its purchases for the period and how it is paid", () => {
    const paid = (c: ReturnType<typeof card>, effectiveMode: string, source: string) => ({ ...c, paidAs: { effectiveMode, source }, payoffMode: { mode: null, source: "default", reason: "x" } });
    render(
      <AmexCardBalances
        summary={summary("all", [
          paid({ ...card("a", "Platinum", "1002", "1649.35"), purchases: { amount: "120.40", count: 3 } }, "in_full_weekly", "default_debt_inactive"),
          paid(card("b", "Blue Cash", "2003", "300.00"), "debt_plan", "default_debt_active"),
          paid(card("c", "Gold", "3004", "10.00"), "unset", "needs_choice"),
          card("d", "Other", "4005", "1.00"),
        ])}
        failed={false}
        pending={false}
        onSelect={vi.fn()}
      />,
    );
    expect(within(screen.getByTestId("amex-card-balances")).getByRole("heading", { name: "By card" })).toBeTruthy();
    expect(screen.getByTestId("amex-card-purchases-a").textContent).toContain("$120.40");
    expect(screen.getByTestId("amex-card-payword-a").textContent).toBe("Paid in full weekly");
    expect(screen.getByTestId("amex-card-payword-b").textContent).toBe("Paying down");
    expect(screen.getByTestId("amex-card-payword-c").textContent).toBe("Not chosen yet · Choose");
    // The server does not know how this card is paid: no word, never a guess.
    expect(screen.getByTestId("amex-card-payword-d").textContent).toBe("");
    // The owed is the card's own; the old "Default: its debt is paid off" never shows here.
    expect(screen.getByTestId("amex-card-balances").textContent).not.toMatch(/paid off/i);
  });

  it("a card's summary left on screen while switching is not read as All cards", () => {
    render(
      <AmexCardBalances summary={summary("card", [card("a", "Platinum", "1002", "9.99")])} failed={false} pending onSelect={vi.fn()} />,
    );
    expect(screen.queryByTestId("amex-card-balance-a")).toBeNull();
    expect(screen.getByTestId("amex-card-balances-loading")).toBeTruthy();
  });

  it("failed says so; no cards says so", () => {
    render(<AmexCardBalances summary={undefined} failed pending={false} onSelect={vi.fn()} />);
    expect(within(screen.getByTestId("amex-card-balances")).getByText("Card balances did not load.")).toBeTruthy();
    cleanup();
    render(<AmexCardBalances summary={summary("all", [])} failed={false} pending={false} onSelect={vi.fn()} />);
    expect(screen.getByText("No cards yet.")).toBeTruthy();
  });
});
