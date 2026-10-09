import { describe, it, expect } from "vitest";
import type { BillsSummary, Spine } from "@workspace/api-client-react";
import { attentionItems, billsDueSoon, upcomingBills } from "./attention";

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
