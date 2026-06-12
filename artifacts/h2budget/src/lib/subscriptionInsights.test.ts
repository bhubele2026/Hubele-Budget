import { describe, it, expect } from "vitest";
import {
  annualize,
  matchKey,
  isTrueSubscription,
  computeSubscriptionInsights,
} from "./subscriptionInsights";
import type { RecurringItem, Transaction } from "@workspace/api-client-react";

function rec(p: Partial<RecurringItem> & { name: string }): RecurringItem {
  return {
    id: p.id ?? `rec-${p.name}`,
    name: p.name,
    kind: p.kind ?? "bill",
    amount: p.amount ?? "10.00",
    frequency: p.frequency ?? "monthly",
    active: p.active ?? "true",
    categoryId: p.categoryId ?? null,
    debtId: p.debtId ?? null,
  } as RecurringItem;
}

function txn(date: string, amount: string, description: string): Transaction {
  return { id: `${description}-${date}`, occurredOn: date, amount, description } as Transaction;
}

const today = new Date("2026-06-12T12:00:00");
const subsCat = () => "Subscriptions";

describe("annualize", () => {
  it("normalizes cadence to a yearly figure", () => {
    expect(annualize(15, "monthly")).toBe(180);
    expect(annualize(120, "yearly")).toBe(120);
    expect(annualize(10, "weekly")).toBe(520);
    expect(annualize(10, "biweekly")).toBe(260);
  });
});

describe("matchKey", () => {
  it("picks the first meaningful token", () => {
    expect(matchKey("Netflix")).toBe("netflix");
    expect(matchKey("Disney Bundle")).toBe("disney");
    expect(matchKey("The Athletic")).toBe("athletic");
    expect(matchKey("HBO Max")).toBe("hbo");
  });
});

describe("isTrueSubscription", () => {
  it("includes services, excludes bills", () => {
    expect(isTrueSubscription("Netflix", "Entertainment")).toBe(true);
    expect(isTrueSubscription("Anything", "Subscriptions")).toBe(true);
    expect(isTrueSubscription("Mortgage (Lakeview)", "Mortgage (Lakeview)")).toBe(
      false,
    );
  });
});

describe("computeSubscriptionInsights", () => {
  it("counts subscriptions only and totals monthly + annual cost", () => {
    const items = [
      rec({ name: "Netflix", amount: "15.49", categoryId: "c1" }),
      rec({ name: "Mortgage (Lakeview)", amount: "2000", categoryId: "c2" }),
    ];
    const catName = (id: string | null | undefined) =>
      id === "c1" ? "Subscriptions" : "Mortgage (Lakeview)";
    const out = computeSubscriptionInsights(items, [], catName, today);
    expect(out.count).toBe(1);
    expect(out.items[0].name).toBe("Netflix");
    expect(out.annualTotal).toBe(185.88);
    expect(out.monthlyTotal).toBe(15.49);
  });

  it("flags a price increase from the charge history", () => {
    const items = [rec({ name: "Netflix", amount: "15.49", categoryId: "c1" })];
    const txns = [
      txn("2026-01-15", "-15.49", "NETFLIX.COM"),
      txn("2026-06-10", "-17.99", "NETFLIX.COM"),
    ];
    const out = computeSubscriptionInsights(items, txns, subsCat, today);
    expect(out.priceIncreases).toHaveLength(1);
    expect(out.items[0].priceChange).toEqual({ from: 15.49, to: 17.99 });
    expect(out.items[0].lastChargeDate).toBe("2026-06-10");
  });

  it("detects likely duplicate subscriptions", () => {
    const items = [
      rec({ name: "Netflix", id: "a", categoryId: "c1" }),
      rec({ name: "Netflix 4K", id: "b", categoryId: "c1" }),
    ];
    const out = computeSubscriptionInsights(items, [], subsCat, today);
    expect(out.duplicateGroups).toHaveLength(1);
    expect(out.duplicateGroups[0].map((g) => g.id).sort()).toEqual(["a", "b"]);
  });

  it("flags a monthly service with no recent charge", () => {
    const items = [rec({ name: "Spotify", amount: "11.99", categoryId: "c1" })];
    const out = computeSubscriptionInsights(items, [], subsCat, today);
    expect(out.noRecentCharge).toHaveLength(1);
    expect(out.items[0].noRecentCharge).toBe(true);
  });

  it("does NOT flag a recently-charged service as stale", () => {
    const items = [rec({ name: "Spotify", amount: "11.99", categoryId: "c1" })];
    const txns = [txn("2026-06-01", "-11.99", "SPOTIFY USA")];
    const out = computeSubscriptionInsights(items, txns, subsCat, today);
    expect(out.items[0].noRecentCharge).toBe(false);
  });
});
