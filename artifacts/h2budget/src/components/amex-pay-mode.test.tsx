import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** (F4) "How this card is paid": the words, the owner-only change, the confirm. Never set by itself. */
const h = vi.hoisted(() => ({ me: { isOwner: true } as unknown, save: vi.fn(), toast: vi.fn() }));
vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useGetMe: () => ({ data: h.me, isLoading: false }),
}));
vi.mock("@workspace/api-client-react/features", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSetAmexCardPayoffMode: () => ({ mutate: h.save, isPending: false }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));

import { CardPayMode, CardPayModes, payModeWords, paySourceWords } from "./amex-pay-mode";

const card = (o: Record<string, unknown> = {}) =>
  ({
    accountId: "ext-plat", name: "Platinum", mask: "2207", institution: "American Express", brand: "platinum", cadence: "weekly",
    debtLinked: false, debtId: null, owed: "100.00", purchases: { amount: "10.00", count: 1 },
    payoffMode: { mode: "in_full", source: "default", reason: "debt_not_active" },
    payDown: { available: true, reason: null }, ...o,
  }) as never;

const mount = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
beforeEach(() => { h.me = { isOwner: true }; h.save.mockReset(); h.toast.mockReset(); });
afterEach(() => cleanup());

describe("card pay mode words", () => {
  it("In full weekly / monthly, Paying down, Not chosen yet; and where the answer came from", () => {
    expect(payModeWords(card())).toBe("Paid in full weekly");
    expect(payModeWords(card({ cadence: "monthly" }))).toBe("Paid in full monthly");
    expect(payModeWords(card({ payoffMode: { mode: "debt_plan", source: "explicit", reason: "set_by_owner" } }))).toBe("Paying down (minimum + extra)");
    expect(payModeWords(card({ payoffMode: { mode: null, source: "default", reason: "debt_terms_missing" } }))).toBe("Not chosen yet");
    expect(paySourceWords(card())).toBe("Default from the card's debt");
    expect(paySourceWords(card({ payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" } }))).toBe("Chosen by you");
    expect(paySourceWords(card({ payoffMode: { mode: null, source: "default", reason: "debt_terms_missing" } }))).toBe("H2 can't tell from the debt");
  });
});

describe("the control", () => {
  it("shows the card, the mode and the source", () => {
    mount(<CardPayModes cards={[card()]} />);
    expect(screen.getByTestId("amex-paymode-word").textContent).toBe("Paid in full weekly");
    expect(screen.getByTestId("amex-paymode-source").textContent).toBe("Default from the card's debt");
    expect(screen.getByTestId("amex-paymodes").textContent).toContain("How this card is paid");
  });

  it("only the owner can change it", () => {
    h.me = { isOwner: false };
    mount(<CardPayMode card={card()} />);
    expect(screen.queryByTestId("amex-paymode-change")).toBeNull();
  });

  it("nothing is written until Confirm; Cancel writes nothing; Confirm sends the chosen mode", () => {
    mount(<CardPayMode card={card({ debtLinked: true, payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    const dlg = screen.getByTestId("amex-paymode-dialog");
    expect(h.save).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByTestId("amex-paymode-opt-debt_plan"));
    expect(within(dlg).getByTestId("amex-paymode-effect").textContent).toMatch(/minimum plus extra/);
    fireEvent.click(within(dlg).getByTestId("amex-paymode-cancel"));
    expect(h.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    fireEvent.click(screen.getByTestId("amex-paymode-opt-debt_plan"));
    fireEvent.click(screen.getByTestId("amex-paymode-go"));
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0]![0]).toEqual({ accountId: "ext-plat", data: { mode: "debt_plan" } });
  });

  it("'Use the default' clears an owner's choice (mode null), and is offered only after a choice was made", () => {
    mount(<CardPayMode card={card()} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    expect(screen.queryByTestId("amex-paymode-opt-default")).toBeNull();
    cleanup();
    mount(<CardPayMode card={card({ payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    fireEvent.click(screen.getByTestId("amex-paymode-opt-default"));
    fireEvent.click(screen.getByTestId("amex-paymode-go"));
    expect(h.save.mock.calls[0]![0]).toEqual({ accountId: "ext-plat", data: { mode: null } });
  });

  it("a card with no answer yet says so and nothing is chosen for the owner", () => {
    mount(<CardPayMode card={card({ payoffMode: { mode: null, source: "default", reason: "debt_terms_missing" } })} />);
    expect(screen.getByTestId("amex-paymode-word").textContent).toBe("Not chosen yet");
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("one label set, from paidAs (Q6b)", () => {
  const paid = (effectiveMode: string, source: string) => ({ paidAs: { effectiveMode, source } });
  it("the four labels follow effectiveMode, not the older payoffMode", () => {
    expect(payModeWords(card(paid("in_full_weekly", "default_no_debt")))).toBe("Paid in full weekly");
    expect(payModeWords(card(paid("in_full_monthly", "chosen")))).toBe("Paid in full monthly");
    expect(payModeWords(card(paid("debt_plan", "default_debt_active")))).toBe("Paying down (minimum + extra)");
    expect(payModeWords(card(paid("unset", "needs_choice")))).toBe("Not chosen yet");
  });
  it("the source line follows paidAs.source", () => {
    expect(paySourceWords(card(paid("in_full_weekly", "chosen")))).toBe("Chosen by you");
    expect(paySourceWords(card(paid("in_full_weekly", "default_no_debt")))).toBe("Default: no debt on this card");
    expect(paySourceWords(card(paid("in_full_weekly", "default_debt_inactive")))).toBe("Default: its debt is paid off");
    expect(paySourceWords(card(paid("debt_plan", "default_debt_active")))).toBe("Default from the card's debt");
  });
  it("Paying down chosen with no active debt never reads 'Not chosen yet / Chosen by you'", () => {
    const c = card({ ...paid("unset", "needs_choice"), debtLinked: true, payoffMode: { mode: null, source: "explicit", reason: "debt_plan_without_active_debt" } });
    mount(<CardPayModes cards={[c]} />);
    expect(screen.getByTestId("amex-paymode-source").textContent).toBe("Paying down needs an active debt");
    expect(screen.getByTestId("amex-paymode-source").textContent).not.toMatch(/Chosen by you/);
    expect(screen.getByTestId("amex-paymode-debts-link").getAttribute("href")).toBe("/debts");
  });
  const NO = (reason: string) => ({ payDown: { available: false, reason } });
  it("(Q6b) no debt: Paying down is disabled, with the reason and a link to Debts", () => {
    mount(<CardPayMode card={card({ debtLinked: false, ...NO("no_debt") })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    const opt = screen.getByTestId("amex-paymode-opt-debt_plan") as HTMLButtonElement;
    expect(opt.disabled).toBe(true);
    expect(screen.getByTestId("amex-paymode-debt-reason").textContent).toContain("Needs an active debt");
    expect(screen.getByTestId("amex-paymode-debt-link").getAttribute("href")).toBe("/debts");
    fireEvent.click(opt);
    expect(screen.queryByTestId("amex-paymode-effect")?.textContent ?? "").not.toMatch(/minimum plus extra/);
    fireEvent.click(screen.getByTestId("amex-paymode-go"));
    expect(h.save).not.toHaveBeenCalledWith(expect.objectContaining({ data: { mode: "debt_plan" } }), expect.anything());
  });
  it("(Q6b) A: archived debt after the owner confirmed in full: still disabled, no effect line, nothing sent", () => {
    mount(<CardPayMode card={card({ debtLinked: true, payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" }, ...NO("debt_not_active") })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    const opt = screen.getByTestId("amex-paymode-opt-debt_plan") as HTMLButtonElement;
    expect(opt.disabled).toBe(true);
    expect(opt.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(opt);
    expect(screen.queryByTestId("amex-paymode-effect")?.textContent ?? "").not.toMatch(/minimum plus extra/);
    expect(screen.getByTestId("amex-paymode-opt-in_full").getAttribute("aria-checked")).toBe("true");
    expect(h.save).not.toHaveBeenCalled();
  });
  it("(Q6b) B: an active debt with no APR or minimum: disabled, and the words say what to add", () => {
    mount(<CardPayMode card={card({ debtLinked: true, payoffMode: { mode: null, source: "default", reason: "debt_terms_missing" }, ...NO("debt_terms_missing") })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    expect((screen.getByTestId("amex-paymode-opt-debt_plan") as HTMLButtonElement).disabled).toBe(true);
    const why = screen.getByTestId("amex-paymode-debt-reason").textContent!;
    expect(why).toContain("APR and minimum");
    expect(why).not.toContain("active debt");
    expect(screen.getByTestId("amex-paymode-debt-link").getAttribute("href")).toBe("/debts");
  });
  it("(Q6b) the source line follows the cause when Paying down was saved but cannot take effect", () => {
    const base = { debtLinked: true, paidAs: { effectiveMode: "unset", source: "needs_choice" }, payoffMode: { mode: null, source: "explicit", reason: "debt_plan_without_active_debt" } };
    expect(paySourceWords(card({ ...base, ...NO("debt_not_active") }))).toBe("Paying down needs an active debt");
    expect(paySourceWords(card({ ...base, ...NO("debt_terms_missing") }))).toBe("Paying down needs the debt's APR and minimum");
  });
  it("an active debt keeps Paying down available and shows no reason", () => {
    mount(<CardPayMode card={card({ debtLinked: true, payoffMode: { mode: "debt_plan", source: "default", reason: "debt_active" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    expect((screen.getByTestId("amex-paymode-opt-debt_plan") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("amex-paymode-debt-reason")).toBeNull();
  });
  it("saved but not in effect: the toast says so instead of 'updated'", () => {
    mount(<CardPayMode card={card({ debtLinked: true, payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    fireEvent.click(screen.getByTestId("amex-paymode-opt-debt_plan"));
    fireEvent.click(screen.getByTestId("amex-paymode-go"));
    h.save.mock.calls[0]![1].onSuccess({ mode: null, source: "explicit", reason: "debt_plan_without_active_debt" });
    expect(h.toast.mock.calls[0]![0].title).toBe("Saved, not in effect.");
  });
  it("(Q6b r3) the toast takes its cause from the PUT answer, not the card as last shown", () => {
    mount(<CardPayMode card={card({ debtLinked: true, payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    fireEvent.click(screen.getByTestId("amex-paymode-opt-debt_plan"));
    fireEvent.click(screen.getByTestId("amex-paymode-go"));
    h.save.mock.calls[0]![1].onSuccess({ mode: null, source: "explicit", reason: "debt_plan_without_active_debt", payDown: { available: false, reason: "debt_terms_missing" } });
    expect(h.toast.mock.calls[0]![0]).toEqual({ title: "Saved, not in effect.", description: "Add the debt's APR and minimum in Debts." });
  });
  it("(Q6b r3) Use the default is disabled, with the cause, when the default cannot tell either; nothing is sent", () => {
    mount(<CardPayMode card={card({ payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" }, defaultMode: { mode: null, reason: "debt_terms_missing" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    const opt = screen.getByTestId("amex-paymode-opt-default") as HTMLButtonElement;
    expect(opt.disabled).toBe(true);
    expect(screen.getByTestId("amex-paymode-default-reason").textContent).toContain("Add the debt's APR and minimum in");
    fireEvent.click(opt);
    expect(screen.queryByText("H2 goes back to reading it from the card's debt.")).toBeNull();
    expect((screen.getByTestId("amex-paymode-go") as HTMLButtonElement).disabled).toBe(false);
  });
  it("(Q6b r3) Use the default stays available when it resolves, and any choice that answers mode null reads 'Saved, not in effect'", () => {
    mount(<CardPayMode card={card({ payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" }, defaultMode: { mode: "in_full", reason: "debt_not_active" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    expect((screen.getByTestId("amex-paymode-opt-default") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("amex-paymode-default-reason")).toBeNull();
    fireEvent.click(screen.getByTestId("amex-paymode-opt-default"));
    fireEvent.click(screen.getByTestId("amex-paymode-go"));
    h.save.mock.calls[0]![1].onSuccess({ mode: null, source: "default", reason: "debt_terms_missing", payDown: { available: false, reason: "debt_terms_missing" } });
    expect(h.toast.mock.calls[0]![0].title).toBe("Saved, not in effect.");
    expect(h.toast.mock.calls[0]![0].description).toBe("Add the debt's APR and minimum in Debts.");
  });
  it("(Q6b r3 review A) the APR/minimum sentence shows once when both options are blocked for the same cause", () => {
    mount(<CardPayMode card={card({ debtLinked: true, payoffMode: { mode: "in_full", source: "explicit", reason: "set_by_owner" }, ...NO("debt_terms_missing"), defaultMode: { mode: null, reason: "debt_terms_missing" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    expect((screen.getByTestId("amex-paymode-opt-default") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("amex-paymode-debt-reason").textContent).toContain("APR and minimum");
    expect(screen.queryByTestId("amex-paymode-default-reason")).toBeNull();
  });
  it("(Q6b r3 review A) no default reason when Use the default is not offered", () => {
    mount(<CardPayMode card={card({ debtLinked: true, payoffMode: { mode: null, source: "default", reason: "debt_terms_missing" }, ...NO("debt_terms_missing"), defaultMode: { mode: null, reason: "debt_terms_missing" } })} />);
    fireEvent.click(screen.getByTestId("amex-paymode-change"));
    expect(screen.queryByTestId("amex-paymode-opt-default")).toBeNull();
    expect(screen.queryByTestId("amex-paymode-default-reason")).toBeNull();
  });
  it("(Q6b) one card on the page: its name is not repeated inside the block", () => {
    mount(<CardPayModes cards={[card()]} />);
    expect(screen.getByTestId("amex-paymodes").textContent).not.toContain("Platinum");
    cleanup();
    mount(<CardPayModes cards={[card(), card({ accountId: "ext-gold", name: "Gold", mask: "2002" })]} />);
    expect(screen.getByTestId("amex-paymodes").textContent).toContain("Platinum");
    expect(screen.getByTestId("amex-paymodes").textContent).toContain("Gold");
  });
});
