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
    payoffMode: { mode: "in_full", source: "default", reason: "debt_not_active" }, ...o,
  }) as never;

const mount = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
beforeEach(() => { h.me = { isOwner: true }; h.save.mockReset(); h.toast.mockReset(); });
afterEach(() => cleanup());

describe("card pay mode words", () => {
  it("In full weekly / monthly, Paying down, Not chosen yet; and where the answer came from", () => {
    expect(payModeWords(card())).toBe("In full weekly");
    expect(payModeWords(card({ cadence: "monthly" }))).toBe("In full monthly");
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
    expect(screen.getByTestId("amex-paymode-word").textContent).toBe("In full weekly");
    expect(screen.getByTestId("amex-paymode-source").textContent).toBe("Default from the card's debt");
    expect(screen.getByTestId("amex-paymodes").textContent).toContain("How this card is paid");
  });

  it("only the owner can change it", () => {
    h.me = { isOwner: false };
    mount(<CardPayMode card={card()} />);
    expect(screen.queryByTestId("amex-paymode-change")).toBeNull();
  });

  it("nothing is written until Confirm; Cancel writes nothing; Confirm sends the chosen mode", () => {
    mount(<CardPayMode card={card()} />);
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
