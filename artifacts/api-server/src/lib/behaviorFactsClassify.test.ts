import { describe, it, expect } from "vitest";
import {
  FIXED_OBLIGATION_PATTERN,
  isNonDiscretionaryCategory,
  isTrueSubscription,
} from "./behaviorFacts";

describe("FIXED_OBLIGATION_PATTERN — biggest splurge exclusions", () => {
  it("matches car payments and leases (the reported splurge bug)", () => {
    expect(FIXED_OBLIGATION_PATTERN.test("Car Payments")).toBe(true);
    expect(FIXED_OBLIGATION_PATTERN.test("Toyota Ach Lease")).toBe(true);
    expect(FIXED_OBLIGATION_PATTERN.test("Auto Loan")).toBe(true);
  });

  it("still matches the existing fixed obligations", () => {
    expect(FIXED_OBLIGATION_PATTERN.test("Mortgage (Lakeview)")).toBe(true);
    expect(FIXED_OBLIGATION_PATTERN.test("HELOC (Figure)")).toBe(true);
    expect(FIXED_OBLIGATION_PATTERN.test("State Farm Insurance")).toBe(true);
  });

  it("does NOT match genuine one-off discretionary spend", () => {
    expect(FIXED_OBLIGATION_PATTERN.test("Shopping")).toBe(false);
    expect(FIXED_OBLIGATION_PATTERN.test("Best Buy")).toBe(false);
    expect(FIXED_OBLIGATION_PATTERN.test("Dining & Coffee")).toBe(false);
  });
});

describe("isNonDiscretionaryCategory", () => {
  const base = {
    groupName: "",
    kind: "expense",
    sourceKind: "manual",
    excludeFromBudget: false,
  };
  it("excludes a Car Payments category from biggest splurge", () => {
    expect(isNonDiscretionaryCategory({ ...base, name: "Car Payments" })).toBe(
      true,
    );
  });
  it("keeps a discretionary category eligible", () => {
    expect(isNonDiscretionaryCategory({ ...base, name: "Shopping" })).toBe(
      false,
    );
  });
});

describe("isTrueSubscription", () => {
  it("counts a Subscriptions/Streaming category", () => {
    expect(isTrueSubscription("Disney Bundle", "Subscriptions")).toBe(true);
    expect(isTrueSubscription("Anything", "Streaming")).toBe(true);
  });

  it("counts a known subscription service by name", () => {
    expect(isTrueSubscription("Netflix", "Entertainment")).toBe(true);
    expect(isTrueSubscription("Spotify Premium", null)).toBe(true);
    expect(isTrueSubscription("Planet Fitness", null)).toBe(true);
  });

  it("excludes fixed bills and variable spend", () => {
    expect(isTrueSubscription("Mortgage (Lakeview)", "Mortgage (Lakeview)")).toBe(
      false,
    );
    expect(isTrueSubscription("HELOC (Figure)", "HELOC (Figure)")).toBe(false);
    expect(isTrueSubscription("Groceries & Dining", "Groceries & Dining")).toBe(
      false,
    );
  });
});
