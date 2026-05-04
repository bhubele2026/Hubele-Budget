import { describe, it, expect } from "vitest";
import {
  categorize,
  findMatchingRules,
  matchRule,
  type RuleRow,
} from "./autoCategorize";

const rules: RuleRow[] = [
  { id: "r1", pattern: "STARBUCKS", matchType: "contains", categoryId: "cat-coffee", priority: 50 },
  { id: "r2", pattern: "AMERICAN EXPRESS ACH", matchType: "contains", categoryId: "cat-amex-pmt", priority: 50 },
  { id: "r3", pattern: "EXACT", matchType: "starts_with", categoryId: "cat-paycheck", priority: 60 },
];

describe("matchRule", () => {
  it("returns categoryId when description contains the pattern (case-insensitive)", () => {
    expect(matchRule("Starbucks #1234 Madison", rules)).toBe("cat-coffee");
  });

  it("respects starts_with matchType", () => {
    expect(matchRule("EXACT SCIENCES PAYROLL", rules)).toBe("cat-paycheck");
    expect(matchRule("PAYROLL EXACT SCIENCES", rules)).not.toBe("cat-paycheck");
  });

  it("returns null when nothing matches", () => {
    expect(matchRule("Some random merchant", rules)).toBeNull();
  });

  it("returns null for empty descriptions", () => {
    expect(matchRule("", rules)).toBeNull();
  });
});

describe("findMatchingRules", () => {
  it("returns every rule whose pattern matches the description", () => {
    const seedish: RuleRow[] = [
      { id: "r1", pattern: "AMERICAN EXPRESS ACH", matchType: "contains", categoryId: "cat-misc", priority: 50 },
      { id: "r2", pattern: "AMEX", matchType: "contains", categoryId: "cat-amex", priority: 100 },
      { id: "r3", pattern: "STARBUCKS", matchType: "contains", categoryId: "cat-coffee", priority: 50 },
    ];
    const matches = findMatchingRules("AMERICAN EXPRESS ACH PMT XXXX5234", seedish);
    expect(matches.map((m) => m.id)).toEqual(["r1"]);
  });

  it("includes rules with a null categoryId (orphan rules can be repointed too)", () => {
    const orphans: RuleRow[] = [
      { id: "r1", pattern: "AMAZON", matchType: "contains", categoryId: null, priority: 50 },
    ];
    const matches = findMatchingRules("AMAZON.COM*Z123 SEATTLE", orphans);
    expect(matches.length).toBe(1);
    expect(matches[0]!.id).toBe("r1");
  });

  it("respects starts_with and exact match types", () => {
    const mixed: RuleRow[] = [
      { id: "r1", pattern: "EXACT", matchType: "starts_with", categoryId: "cat-paycheck", priority: 60 },
      { id: "r2", pattern: "exact sciences payroll", matchType: "exact", categoryId: "cat-paycheck", priority: 60 },
    ];
    const matches = findMatchingRules("EXACT SCIENCES PAYROLL", mixed);
    expect(matches.map((m) => m.id).sort()).toEqual(["r1", "r2"]);
  });

  it("returns empty for empty descriptions", () => {
    expect(findMatchingRules("", rules)).toEqual([]);
  });
});

describe("categorize", () => {
  it("hits a description rule before any PFC consideration", () => {
    const out = categorize(
      { description: "STARBUCKS STORE 123", pfcPrimary: "FOOD_AND_DRINK" },
      rules,
    );
    expect(out.categoryId).toBe("cat-coffee");
    expect(out.isTransfer).toBe(false);
  });

  it("flags TRANSFER_IN as a transfer with no category", () => {
    const out = categorize(
      { description: "ACH credit from savings", pfcPrimary: "TRANSFER_IN" },
      rules,
    );
    expect(out.isTransfer).toBe(true);
    expect(out.categoryId).toBeNull();
  });

  it("flags TRANSFER_OUT as a transfer", () => {
    const out = categorize(
      { description: "Outbound move", pfcPrimary: "TRANSFER_OUT" },
      rules,
    );
    expect(out.isTransfer).toBe(true);
  });

  it("flags ODP transfer descriptions as transfers even without a PFC", () => {
    const out = categorize({ description: "ODP TRANSFER FROM CHECKING" }, rules);
    expect(out.isTransfer).toBe(true);
    expect(out.categoryId).toBeNull();
  });

  it("flags 'online transfer to' descriptions as transfers", () => {
    const out = categorize(
      { description: "ONLINE TRANSFER TO SAVINGS XXXX1234" },
      rules,
    );
    expect(out.isTransfer).toBe(true);
  });

  it("returns no match when neither rules nor PFC apply", () => {
    const out = categorize(
      { description: "Mystery merchant", pfcPrimary: "GENERAL_MERCHANDISE" },
      rules,
    );
    expect(out.categoryId).toBeNull();
    expect(out.isTransfer).toBe(false);
  });

  it("description rule still wins even when transfer flag is true", () => {
    const out = categorize(
      { description: "AMERICAN EXPRESS ACH PAYMENT", pfcPrimary: "TRANSFER_OUT" },
      rules,
    );
    expect(out.categoryId).toBe("cat-amex-pmt");
    expect(out.isTransfer).toBe(true);
  });
});
