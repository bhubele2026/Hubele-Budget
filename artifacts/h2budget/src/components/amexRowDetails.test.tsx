import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Transaction } from "@workspace/api-client-react";

/**
 * ⭐ (P1) A CALM AMEX ROW AND ITS DETAILS. The row says its spending in words
 * (Review) or shows the marks (Categorize); everything else the row can do is in
 * its Details, in place under it. Each control calls the handler it is given —
 * the page's existing ones — so no write here is new. Synthetic rows.
 */
vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string }) => (
    <a href={href} data-testid={rest["data-testid"]}>{children}</a>
  ),
}));

import { AmexLedgerRow, AmexRowDetails, amexDetailsId } from "./amex-row";

const tx = (o: Record<string, unknown> = {}) =>
  ({
    id: "t1",
    occurredOn: "2026-10-08",
    description: "SQ *CORNER CAFE 0042",
    displayName: "Corner Cafe",
    amount: "-12.00",
    source: "plaid",
    categoryId: "c-din",
    matchedRuleId: null,
    categoryLockedByUser: false,
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    reimbursable: false,
    reimbursed: false,
    reviewed: false,
    isTransfer: false,
    isTransferUserOverridden: false,
    isExternalCardPayment: false,
    pending: false,
    notes: null,
    owedBy: null,
    plaidAccountId: "ext-plat",
    ...o,
  }) as unknown as Transaction;

const handlers = () => ({
  onBucketToggle: vi.fn(),
  onClearTransfer: vi.fn(),
  onSetExternal: vi.fn(),
  onQuickDate: vi.fn(async () => true),
  onSetReviewed: vi.fn(),
  onSplit: vi.fn(),
  onClose: vi.fn(),
});

function details(t: Transaction, o: Partial<React.ComponentProps<typeof AmexRowDetails>> = {}) {
  const h = handlers();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AmexRowDetails
        t={t}
        mode="review"
        cardLabel="Platinum ••1005"
        categoryName="Dining"
        provenance={{ kind: "no_rule" }}
        ignored={false}
        {...h}
        {...o}
      />
    </QueryClientProvider>,
  );
  return { h, region: screen.getByTestId(amexDetailsId(t.id)) };
}

afterEach(() => cleanup());

describe("AmexRowDetails — every action, each through its handler", () => {
  it("merchant: name, the bank's words, rename and split", () => {
    const { h, region } = details(tx());
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Details for Corner Cafe");
    expect(region.textContent).toContain("Bank: SQ *CORNER CAFE 0042");
    expect(within(region).getByTestId("rename-merchant-t1").textContent).toBe("Rename merchant…");
    fireEvent.click(within(region).getByTestId("split-category-t1"));
    expect(h.onSplit).toHaveBeenCalledTimes(1);
    cleanup();
    // The bank's words only when they say something else than the name (case and spacing aside).
    const same = details(tx({ displayName: "Market Fresh 442", description: "MARKET  FRESH 442" }));
    expect(same.region.textContent).not.toContain("Bank:");
  });

  it("category: its name and where it came from — never 'Manual'", () => {
    const { region } = details(tx(), { provenance: { kind: "rule", ruleId: "r1", pattern: "CORNER", matchWords: "contains" } });
    expect(region.textContent).toContain("Dining");
    expect(region.textContent).toContain('Set by rule "CORNER" (contains).');
    expect(within(region).getByTestId("link-matched-rule-amex-t1").getAttribute("href")).toBe("/mapping-rules?focus=r1");
    expect(region.textContent).not.toMatch(/\bManual\b/);
    cleanup();
    const second = details(tx(), { provenance: { kind: "no_rule" } });
    expect(within(second.region).getByTestId("text-no-rule-amex-t1").textContent).toBe("No rule matches this category.");
    cleanup();
    const third = details(tx(), { provenance: { kind: "hand" } });
    expect(third.region.textContent).toContain("Chosen by hand.");
    expect(third.region.textContent).not.toMatch(/\bManual\b/);
  });

  it("spending (Review): the four marks in full words; choosing one goes through the bucket handler", () => {
    const { h, region } = details(tx({ weeklyAllowance: true }));
    const weekly = within(region).getByRole("button", { name: "Weekly bucket" });
    expect(weekly.getAttribute("aria-pressed")).toBe("true");
    expect(weekly.textContent).toBe("Weekly");
    expect(within(region).getByRole("button", { name: "Reimbursable" }).textContent).toBe("Reimbursable");
    expect(region.textContent).toContain("Choosing one marks the row reviewed.");
    fireEvent.click(within(region).getByRole("button", { name: "Unplanned bucket" }));
    expect(h.onBucketToggle).toHaveBeenCalledWith("unplanned", true);
  });

  it("spending (Categorize): the marks are in the row, not here", () => {
    const { region } = details(tx(), { mode: "categorize" });
    expect(within(region).queryByRole("button", { name: "Weekly bucket" })).toBeNull();
  });

  it("a transfer: not counted, 'Count as spending'; a card payment can be marked outside the debt plan", () => {
    const { h, region } = details(tx({ isTransfer: true, isTransferUserOverridden: true }));
    expect(region.textContent).toContain("Transfer: not counted as spending.");
    expect(region.textContent).toContain("Set by hand. The next sync keeps it.");
    fireEvent.click(within(region).getByTestId("button-clear-transfer-t1"));
    expect(h.onClearTransfer).toHaveBeenCalledTimes(1);
    fireEvent.click(within(region).getByTestId("button-mark-external-card-t1"));
    expect(h.onSetExternal).toHaveBeenCalledWith(true);
  });

  it("a payment already marked outside the debt plan can be cleared", () => {
    const { h, region } = details(tx({ isTransfer: true, isExternalCardPayment: true }));
    expect(region.textContent).toContain("Paid to a card outside the debt plan.");
    fireEvent.click(within(region).getByTestId("button-clear-external-card-t1"));
    expect(h.onSetExternal).toHaveBeenCalledWith(false);
  });

  it("a purchase offers no card-payment flag", () => {
    const { region } = details(tx());
    expect(within(region).queryByTestId("button-mark-external-card-t1")).toBeNull();
  });

  it("date (posted): back a day, or any day; Save is off until the day changes", () => {
    const { h, region } = details(tx());
    fireEvent.click(within(region).getByTestId("button-bump-date-back-t1"));
    expect(h.onQuickDate).toHaveBeenCalledWith("2026-10-07");
    const save = within(region).getByTestId("button-save-inline-date-t1") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(region).getByTestId("input-inline-date-t1"), { target: { value: "2026-10-04" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(h.onQuickDate).toHaveBeenLastCalledWith("2026-10-04");
  });

  it("date (pending): the bank sets it; nothing to move", () => {
    const { region } = details(tx({ pending: true }));
    expect(within(region).getByTestId("text-pending-date-t1").textContent).toBe("The bank sets the date when it posts.");
    expect(within(region).queryByTestId("button-bump-date-back-t1")).toBeNull();
    expect(within(region).queryByTestId("input-inline-date-t1")).toBeNull();
  });

  it("review: Mark reviewed / Mark not reviewed, through the bulk path's handler", () => {
    const { h, region } = details(tx());
    fireEvent.click(within(region).getByTestId("button-row-reviewed-t1"));
    expect(h.onSetReviewed).toHaveBeenCalledWith(true);
    cleanup();
    const second = details(tx({ reviewed: true }));
    expect(within(second.region).getByTestId("button-row-reviewed-t1").textContent).toBe("Mark not reviewed");
    fireEvent.click(within(second.region).getByTestId("button-row-reviewed-t1"));
    expect(second.h.onSetReviewed).toHaveBeenCalledWith(false);
  });

  it("also: the card, the full notes and who owes it; Done closes", () => {
    const { h, region } = details(tx({ notes: "Team lunch, split with a friend", owedBy: "Sam" }));
    expect(within(region).getByTestId("details-card-t1").textContent).toBe("Platinum ••1005");
    expect(region.textContent).toContain("Team lunch, split with a friend");
    expect(region.textContent).toContain("Owed by");
    expect(region.textContent).toContain("Sam");
    fireEvent.click(within(region).getByTestId("button-row-details-done-t1"));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("an expired hold says why it is not counted", () => {
    const { region } = details(tx({ pending: true, expiredHold: true }));
    expect(region.textContent).toContain("Still pending more than 7 days after its date. Not counted anywhere.");
  });
});

describe("Escape closes the details only from inside them", () => {
  it("Escape inside the region closes", () => {
    const { h, region } = details(tx());
    fireEvent.keyDown(within(region).getByTestId("button-bump-date-back-t1"), { key: "Escape" });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape in the rename popover opened from here (portaled: React bubbles it, the region's DOM does not hold it) does not", async () => {
    const { h, region } = details(tx());
    fireEvent.click(within(region).getByTestId("rename-merchant-t1"));
    const input = await screen.findByTestId("rename-input-t1");
    expect(region.contains(input)).toBe(false);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(h.onClose).not.toHaveBeenCalled();
  });
});

describe("AmexLedgerRow", () => {
  const row = (o: Partial<React.ComponentProps<typeof AmexLedgerRow>> = {}) => {
    const onToggleDetails = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AmexLedgerRow
          t={tx()}
          mode="review"
          showCard
          cardLabel="Platinum ••1005"
          cardAccent="amex"
          selected={false}
          onToggleSelect={() => undefined}
          categories={[{ id: "c-din", name: "Dining" }]}
          onCategoryChange={() => undefined}
          onBucketToggle={() => undefined}
          ignored={false}
          spending="Not filed yet"
          amountNode={<span>-$12.00</span>}
          detailsOpen={false}
          onToggleDetails={onToggleDetails}
          details={<div data-testid="the-details" />}
          {...o}
        />
      </QueryClientProvider>,
    );
    return { onToggleDetails, el: screen.getByTestId("row-amex-t1") };
  };

  it("Review: merchant, card, category (one click), spending in words; no pencil, no row menu, no marks", () => {
    const { el } = row();
    expect(within(el).getByTestId("merchant-t1").textContent).toBe("Corner Cafe");
    expect(within(el).getByTestId("text-card-t1").textContent).toBe("Platinum ••1005");
    expect(within(el).getByRole("combobox", { name: "Category: Dining" })).toBeTruthy();
    expect(within(el).getByTestId("spending-t1").textContent).toBe("Spending: Not filed yet");
    expect(within(el).queryByTestId("rename-merchant-t1")).toBeNull();
    expect(within(el).queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(within(el).queryByRole("button", { name: "Weekly bucket" })).toBeNull();
    // About three stops a row: select, category, details.
    expect(within(el).getAllByRole("button").length + within(el).getAllByRole("checkbox").length).toBeLessThanOrEqual(3);
  });

  it("Categorize: the marks in place of the words", () => {
    const { el } = row({ mode: "categorize" });
    expect(within(el).queryByTestId("spending-t1")).toBeNull();
    expect(within(el).getByRole("button", { name: "Weekly bucket" })).toBeTruthy();
  });

  it("statuses only when they apply; Reviewed is quiet text", () => {
    const { el } = row({ t: tx({ pending: true, isTransfer: true, reviewed: true }), ignored: true });
    expect(within(el).getByTestId("chip-pending-t1").textContent).toBe("Pending");
    expect(within(el).getByTestId("badge-transfer-t1").textContent).toBe("Transfer");
    expect(within(el).getByTestId("chip-ignored-t1").textContent).toBe("Ignored");
    const reviewed = within(el).getByTestId("chip-state-t1");
    expect(reviewed.textContent).toBe("Reviewed");
    expect(reviewed.className).not.toContain("chip");
    cleanup();
    const second = row();
    expect(within(second.el).queryByTestId("chip-pending-t1")).toBeNull();
    expect(within(second.el).queryByTestId("chip-state-t1")).toBeNull();
  });

  it("the Details toggle: named, wired to its region, expanded state; the region draws inside the row", () => {
    const { el, onToggleDetails } = row();
    const btn = within(el).getByTestId("button-row-details-t1");
    expect(btn.getAttribute("aria-label")).toBe("Details for Corner Cafe");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe("amex-row-details-t1");
    fireEvent.click(btn);
    expect(onToggleDetails).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("the-details")).toBeNull();
    cleanup();
    const open = row({ detailsOpen: true });
    expect(within(open.el).getByTestId("button-row-details-t1").getAttribute("aria-expanded")).toBe("true");
    expect(open.el.contains(screen.getByTestId("the-details"))).toBe(true);
    expect(open.el.getAttribute("data-details")).toBe("open");
  });

  it("one card's page: no Card cell", () => {
    const { el } = row({ showCard: false });
    expect(within(el).queryByTestId("text-card-t1")).toBeNull();
  });
});
