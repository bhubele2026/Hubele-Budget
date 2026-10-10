import { describe, it, expect } from "vitest";
import type { BillsSummary, Spine } from "@workspace/api-client-react";
import { attentionItems, billsDueSoon, headerActionOf, upcomingBills } from "./attention";

const bank = (o: Partial<Spine["bank"]> = {}): Spine["bank"] => ({
  balance: "100", asOfDate: "2026-10-07", source: "plaid", lastContactAt: null, lastFailureAt: null, stale: false, staleReason: null, ...o,
});
const base = { bank: bank(), withinPlan: "yes" as const, overBy: null, dueSoon: [], today: "2026-10-08", reviewCount: 0 };
const summary = {
  income: [], monthly: {} as never,
  bills: [
    { item: { name: "Rent", amount: "1200", active: "true" }, nextOccurrence: "2026-10-09" },
    { item: { name: "Old", amount: "5", active: "false" }, nextOccurrence: "2026-10-09" },
    { item: { name: "Past", amount: "5", active: "true" }, nextOccurrence: "2026-10-01" },
  ],
  debtMins: [{ debtName: "Visa", minPayment: "35", nextOccurrence: "2026-10-20" }],
} as unknown as BillsSummary;

describe("attentionItems", () => {
  it("nothing when all is well", () => {
    expect(attentionItems(base)[0]).toMatchObject({ kind: "nothing", title: "Nothing needs you today" });
  });
  it("reconnect beats everything", () => {
    const a = attentionItems({ ...base, bank: bank({ staleReason: "refresh_failed", stale: true }), withinPlan: "over", reviewCount: 3 });
    expect(a.map((x) => x.kind)).toEqual(["reconnect", "over", "review"]);
    expect(a[0]!.action).toEqual({ label: "Reconnect", href: "/settings" });
  });
  it("stale balance", () => {
    expect(attentionItems({ ...base, bank: bank({ stale: true, staleReason: "old" }) })[0]!.kind).toBe("stale");
  });
  it("over names the amount", () => {
    const a = attentionItems({ ...base, withinPlan: "over", overBy: 40 })[0]!;
    expect(a.kind).toBe("over");
    expect(a.title).toBe("Over this week's limit by $40.00");
  });
  it("bills due today or tomorrow, singular and plural", () => {
    const one = attentionItems({ ...base, dueSoon: [{ name: "Rent", amount: 1200, dueOn: "2026-10-09" }] })[0]!;
    expect(one.title).toBe("Rent $1,200.00 is due tomorrow");
    expect(one.action?.href).toBe("/bills");
    const two = attentionItems({ ...base, dueSoon: [{ name: "A", amount: 1, dueOn: "2026-10-08" }, { name: "B", amount: 2, dueOn: "2026-10-09" }] })[0]!;
    expect(two.title).toBe("2 bills are due today or tomorrow");
  });
  it("review count", () => {
    expect(attentionItems({ ...base, reviewCount: 1 })[0]!.title).toBe("1 charge needs a look");
    expect(attentionItems({ ...base, reviewCount: 4 })[0]!.title).toBe("4 charges need a look");
  });
});

describe("bill helpers", () => {
  it("skips inactive and past, sorts soonest first", () => {
    expect(upcomingBills(summary, "2026-10-08").map((b) => b.name)).toEqual(["Rent", "Visa"]);
    expect(billsDueSoon(summary, "2026-10-08").map((b) => b.name)).toEqual(["Rent"]);
    expect(upcomingBills(undefined, "2026-10-08")).toEqual([]);
  });
});

describe("attention — way back (F7)", () => {
  it("the over item offers a way back; no other item does", () => {
    const over = attentionItems({ ...base, withinPlan: "over", overBy: 40 })[0]!;
    expect(over.wayBack).toBe(true);
    expect(over.detail).toBe("Pick a way back. No lecture.");
    expect(attentionItems({ ...base, reviewCount: 2 })[0]!.wayBack).toBeUndefined();
  });
});

describe("headerActionOf (the dashboard header's ONE action)", () => {
  const due = [{ name: "Rent", amount: 1200, dueOn: "2026-10-08" }];
  it("Reconnect when the bank's feed failed, even over plan and with a bill due", () => {
    const items = attentionItems({ ...base, bank: bank({ stale: true, staleReason: "refresh_failed" }), withinPlan: "over", overBy: 25, dueSoon: due });
    expect(headerActionOf(items)).toEqual({ kind: "reconnect", label: "Reconnect", href: "/settings" });
  });
  it("Pick a way back when the week is over its plan", () => {
    expect(headerActionOf(attentionItems({ ...base, withinPlan: "over", overBy: 25, dueSoon: due }))).toEqual({ kind: "wayBack" });
  });
  it("an old balance does not take the slot from Pick a way back (it has its own row and the per-bank Sync)", () => {
    const items = attentionItems({ ...base, bank: bank({ stale: true, staleReason: "old" }), withinPlan: "over", overBy: 25 });
    expect(items[0]!.kind).toBe("stale");
    expect(headerActionOf(items)).toEqual({ kind: "wayBack" });
  });
  it("otherwise the everyday question: Can we afford something?", () => {
    expect(headerActionOf(attentionItems(base))).toEqual({ kind: "afford" });
    expect(headerActionOf(attentionItems({ ...base, dueSoon: due, reviewCount: 3 }))).toEqual({ kind: "afford" });
    expect(headerActionOf(attentionItems({ ...base, bank: bank({ stale: true, staleReason: "old" }) }))).toEqual({ kind: "afford" });
  });
});

describe("attentionItems — a card's bank needing a new login (dashboard refinement)", () => {
  it("is a reconnect item, and takes the header's one action", () => {
    const items = attentionItems({ ...base, reauthBanks: ["American Express"] });
    expect(items[0]).toMatchObject({ kind: "reconnect", title: "Reconnect American Express", action: { href: "/settings" } });
    expect(headerActionOf(items)).toEqual({ kind: "reconnect", label: "Reconnect", href: "/settings" });
  });
  it("folds into the checking feed's own reconnect when both happen (one item)", () => {
    const items = attentionItems({ ...base, bank: bank({ stale: true, staleReason: "refresh_failed" }), reauthBanks: ["American Express", "American Express"] });
    expect(items.filter((a) => a.kind === "reconnect")).toHaveLength(1);
    expect(items[0]!.detail).toContain("American Express.");
  });
});

describe("headerActionOf — the forecast running short (lead, 2026-10-09; WP6: one item)", () => {
  const over = { ...base, withinPlan: "over" as const, overBy: 25 };
  // $350 under the $500 buffer (the server's not_yet): the forecast runs short.
  const short = { lowPoint: "350.00", lowPointDate: "2026-10-20", runwayDays: null, cashBuffer: "500.00", status: "not_yet" as const };
  const fine = { ...short, lowPoint: "1500.00", status: "ready" as const };
  it("order: Link a bank → Reconnect → runs short → Pick a way back → Afford", () => {
    expect(headerActionOf(attentionItems({ ...over, forecast: short }), { noBank: true }).kind).toBe("link");
    expect(headerActionOf(attentionItems({ ...over, forecast: short, reauthBanks: ["Amex"] })).kind).toBe("reconnect");
    expect(headerActionOf(attentionItems({ ...over, forecast: short }))).toEqual({ kind: "short", label: "See where it runs short", href: "/forecast" });
    expect(headerActionOf(attentionItems({ ...over, forecast: fine }))).toEqual({ kind: "wayBack" });
    expect(headerActionOf(attentionItems(base), {})).toEqual({ kind: "afford" });
  });
  it("(WP6) runs short is an attention item from lowPointView — the one Needs attention lists — in its place in the order", () => {
    const items = attentionItems({ ...over, forecast: short, bank: bank({ stale: true, staleReason: "old" }) });
    expect(items.map((a) => a.kind)).toEqual(["stale", "short", "over"]);
    expect(items[1]).toEqual({
      kind: "short", title: "The forecast runs short", detail: "Low $350.00 on Oct 20 · below your $500 buffer",
      action: { label: "See where it runs short", href: "/forecast" },
    });
    // Below zero runs short even above the buffer's verdict; tight and ready do not.
    expect(attentionItems({ ...base, forecast: { ...fine, lowPoint: "-40.00", status: "tight" } }).some((a) => a.kind === "short")).toBe(true);
    expect(attentionItems({ ...base, forecast: { ...fine, lowPoint: "620.00", status: "tight" } }).some((a) => a.kind === "short")).toBe(false);
    expect(attentionItems({ ...base, forecast: { ...short, status: "no_data" } }).some((a) => a.kind === "short")).toBe(false);
  });
});

describe("a due-soon payment with words built by the caller", () => {
  it("reads the label whole, and says when in the detail", () => {
    const items = attentionItems({ ...base, dueSoon: [{ name: "Weekly Spend", amount: 477.57, dueOn: "2026-10-09", label: "Weekly Spend · card payoff $477.57 (plan $450)" }] });
    expect(items[0]).toMatchObject({ kind: "bill", title: "Weekly Spend · card payoff $477.57 (plan $450)", detail: "Due tomorrow" });
  });
});

describe("a caller-worded title is never clipped (it must match its other surfaces)", () => {
  it("keeps a long hook label whole, while ordinary titles still clip at 60", () => {
    const label = "Amex Platinum weekly payoff · card payoff $1,477.57 (plan $1,450)";
    expect(label.length).toBeGreaterThan(60);
    const items = attentionItems({ ...base, dueSoon: [{ name: "Amex Platinum weekly payoff", amount: 1477.57, dueOn: "2026-10-08", label }] });
    expect(items[0]!.title).toBe(label);
    expect(Object.getOwnPropertySymbols(items[0]!)).toEqual([]); // the internal marker never leaks
    const plain = attentionItems({ ...base, dueSoon: [{ name: "A very long bill name that goes on and on and on", amount: 10, dueOn: "2026-10-08" }] });
    expect(plain[0]!.title.length).toBeLessThanOrEqual(60);
  });
});
