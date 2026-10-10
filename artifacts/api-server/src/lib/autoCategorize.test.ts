import { describe, it, expect } from "vitest";
import {
  categorize,
  directionGuard,
  findMatchedRuleId,
  findMatchingRules,
  matchRule,
  type RuleRow,
} from "./autoCategorize";
import { spendContextOf } from "./spendContext";

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

describe("findMatchedRuleId", () => {
  const sortedRules: RuleRow[] = [
    { id: "r-pay", pattern: "EXACT", matchType: "starts_with", categoryId: "cat-paycheck", priority: 60 },
    { id: "r-coffee", pattern: "STARBUCKS", matchType: "contains", categoryId: "cat-coffee", priority: 50 },
    { id: "r-amex", pattern: "AMERICAN EXPRESS ACH", matchType: "contains", categoryId: "cat-amex-pmt", priority: 50 },
  ];

  it("returns the matching rule's id when its categoryId matches the txn's current category", () => {
    expect(
      findMatchedRuleId("Starbucks #1234 Madison", "cat-coffee", sortedRules),
    ).toBe("r-coffee");
  });

  it("returns null when the highest-priority matching rule disagrees with the current category (manual override)", () => {
    expect(
      findMatchedRuleId("Starbucks #1234 Madison", "cat-other", sortedRules),
    ).toBeNull();
  });

  it("returns null when no rule matches the description at all", () => {
    expect(
      findMatchedRuleId("Some random merchant", "cat-coffee", sortedRules),
    ).toBeNull();
  });

  it("returns null when the transaction has no current category", () => {
    expect(
      findMatchedRuleId("Starbucks #1234 Madison", null, sortedRules),
    ).toBeNull();
    expect(
      findMatchedRuleId("Starbucks #1234 Madison", undefined, sortedRules),
    ).toBeNull();
  });

  it("returns null for empty / null descriptions", () => {
    expect(findMatchedRuleId("", "cat-coffee", sortedRules)).toBeNull();
    expect(findMatchedRuleId(null, "cat-coffee", sortedRules)).toBeNull();
    expect(findMatchedRuleId(undefined, "cat-coffee", sortedRules)).toBeNull();
  });

  it("only considers the FIRST matching rule, mirroring categorize()'s priority-desc walk", () => {
    const ruleSet: RuleRow[] = [
      { id: "r-amex", pattern: "AMERICAN EXPRESS ACH", matchType: "contains", categoryId: "cat-amex-pmt", priority: 50 },
      { id: "r-amex-broad", pattern: "AMEX", matchType: "contains", categoryId: "cat-other", priority: 10 },
    ];
    expect(
      findMatchedRuleId("AMERICAN EXPRESS ACH PMT XXXX5234", "cat-other", ruleSet),
    ).toBeNull();
    expect(
      findMatchedRuleId("AMERICAN EXPRESS ACH PMT XXXX5234", "cat-amex-pmt", ruleSet),
    ).toBe("r-amex");
  });

  it("skips orphan rules (categoryId === null) when looking for an attribution", () => {
    const ruleSet: RuleRow[] = [
      { id: "r-orphan", pattern: "STARBUCKS", matchType: "contains", categoryId: null, priority: 100 },
      { id: "r-coffee", pattern: "STARBUCKS", matchType: "contains", categoryId: "cat-coffee", priority: 50 },
    ];
    expect(
      findMatchedRuleId("Starbucks #1234", "cat-coffee", ruleSet),
    ).toBe("r-coffee");
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

  // (#666) Auto-detection of transfers via Plaid PFC and description
  // patterns is disabled. Every call to categorize() returns
  // `isTransfer: false` regardless of input — the user is in full
  // manual control: they explicitly assign rows to the system
  // "Transfer" category when they want a row excluded from buckets.
  describe("(#666) auto-detect disabled — categorize never auto-flags as transfer", () => {
    it("does NOT flag TRANSFER_IN PFC", () => {
      const out = categorize(
        { description: "ACH credit from savings", pfcPrimary: "TRANSFER_IN" },
        rules,
      );
      expect(out.isTransfer).toBe(false);
    });

    it("does NOT flag TRANSFER_OUT PFC", () => {
      const out = categorize(
        { description: "Outbound move", pfcPrimary: "TRANSFER_OUT" },
        rules,
      );
      expect(out.isTransfer).toBe(false);
    });

    it("does NOT flag LOAN_PAYMENTS PFC", () => {
      const out = categorize(
        { description: "Some bank-side card payment", pfcPrimary: "LOAN_PAYMENTS" },
        [],
      );
      expect(out.isTransfer).toBe(false);
    });

    it("does NOT flag ODP transfer descriptions", () => {
      const out = categorize({ description: "ODP TRANSFER FROM CHECKING" }, rules);
      expect(out.isTransfer).toBe(false);
    });

    it("does NOT flag 'online transfer to' descriptions", () => {
      const out = categorize(
        { description: "ONLINE TRANSFER TO SAVINGS XXXX1234" },
        rules,
      );
      expect(out.isTransfer).toBe(false);
    });

    it("does NOT flag 'ONLINE PAYMENT - THANK YOU' descriptions", () => {
      const out = categorize({ description: "ONLINE PAYMENT - THANK YOU" }, []);
      expect(out.isTransfer).toBe(false);
    });

    it("does NOT flag 'AUTOPAY PAYMENT' descriptions", () => {
      const out = categorize(
        { description: "AUTOPAY PAYMENT - THANK YOU" },
        [],
      );
      expect(out.isTransfer).toBe(false);
    });

    it("description rule still wins regardless of PFC, and isTransfer stays false", () => {
      const out = categorize(
        { description: "AMERICAN EXPRESS ACH PAYMENT", pfcPrimary: "TRANSFER_OUT" },
        rules,
      );
      expect(out.categoryId).toBe("cat-amex-pmt");
      expect(out.isTransfer).toBe(false);
    });
  });

  it("returns no match when neither rules nor PFC apply", () => {
    const out = categorize(
      { description: "Mystery merchant", pfcPrimary: "GENERAL_MERCHANDISE" },
      rules,
    );
    expect(out.categoryId).toBeNull();
    expect(out.isTransfer).toBe(false);
  });

  it("does NOT flag a plain merchant charge that happens to contain 'pay'", () => {
    const out = categorize({ description: "PAYLESS SHOES #4521" }, []);
    expect(out.isTransfer).toBe(false);
  });
});

// ── (WP5d) the insert-time fill never files money against its direction ────
describe("(WP5d) categorize with a direction guard", () => {
  const ctx = {
    spendCtx: spendContextOf([
      { id: "cat-dining", name: "Dining & Coffee", debtId: null, kind: "expense" },
      { id: "cat-paycheck", name: "Paycheck", debtId: null, kind: "income" },
      { id: "cat-uncat", name: "Uncategorized", debtId: null, kind: "expense" },
    ]),
    uncategorizedIds: new Set(["cat-uncat"]),
  };
  // One broad employer rule, the way a seed payroll rule gets re-pointed.
  const broad: RuleRow[] = [{ id: "r-bigco", pattern: "BIGCO", matchType: "contains", categoryId: "cat-dining", priority: 50 }];
  const toPay: RuleRow[] = [{ id: "r-pay", pattern: "BIGCO", matchType: "contains", categoryId: "cat-paycheck", priority: 50 }];

  it("money in that a rule would file under an expense category files nothing, and names the rule", () => {
    const out = categorize(
      { description: "BIGCO PAYROLL PPD ID 4455" },
      broad,
      directionGuard(ctx, { amount: "2500.00", source: "plaid:chase", accountType: "depository" }),
    );
    expect(out).toEqual({
      categoryId: null,
      isTransfer: false,
      matchedRuleId: null,
      matchedRulePattern: null,
      directionConflict: { kind: "inflow_into_expense", ruleId: "r-bigco", pattern: "BIGCO" },
    });
  });

  it("money out that a rule would file under an income category files nothing either", () => {
    const out = categorize(
      { description: "BIGCO CAFE 0042" },
      toPay,
      directionGuard(ctx, { amount: "-8.50", source: "plaid:chase", accountType: "depository" }),
    );
    expect(out.categoryId).toBeNull();
    expect(out.directionConflict).toEqual({ kind: "outflow_into_income", ruleId: "r-pay", pattern: "BIGCO" });
  });

  it("the right direction files as before, with the rule attributed", () => {
    const cafe = categorize(
      { description: "BIGCO CAFE 0042" },
      broad,
      directionGuard(ctx, { amount: "-8.50", source: "plaid:chase", accountType: "depository" }),
    );
    expect(cafe).toMatchObject({ categoryId: "cat-dining", matchedRuleId: "r-bigco", directionConflict: null });
    const pay = categorize(
      { description: "BIGCO PAYROLL" },
      toPay,
      directionGuard(ctx, { amount: "2500.00", source: "plaid:chase", accountType: "depository" }),
    );
    expect(pay).toMatchObject({ categoryId: "cat-paycheck", matchedRuleId: "r-pay", directionConflict: null });
  });

  it("must not change: a card's credit (any bank), a transfer, a debt payment, a reimbursable credit, a checking refund", () => {
    const credit = (o: Parameters<typeof directionGuard>[1]) =>
      categorize({ description: "BIGCO STORE" }, broad, directionGuard(ctx, o)).categoryId;
    expect(credit({ amount: "20.00", source: "plaid:chase", accountType: "credit" })).toBe("cat-dining");
    expect(credit({ amount: "20.00", source: "plaid:amex", accountType: null })).toBe("cat-dining");
    expect(credit({ amount: "-20.00", source: "amex", accountType: null })).toBe("cat-dining");
    expect(credit({ amount: "20.00", source: "plaid:chase", accountType: "depository", isTransfer: true })).toBe("cat-dining");
    expect(credit({ amount: "20.00", source: "plaid:chase", accountType: "depository", debtId: "d1" })).toBe("cat-dining");
    expect(credit({ amount: "20.00", source: "plaid:chase", accountType: "depository", reimbursable: true })).toBe("cat-dining");
    expect(
      categorize({ description: "BIGCO REFUND" }, broad, directionGuard(ctx, { amount: "5.00", source: "plaid:chase", accountType: "depository" }))
        .categoryId,
    ).toBe("cat-dining");
  });

  it("without a guard nothing changes (callers that do not pass one keep today's behaviour)", () => {
    expect(categorize({ description: "BIGCO PAYROLL" }, broad)).toEqual({
      categoryId: "cat-dining",
      isTransfer: false,
      matchedRuleId: "r-bigco",
      matchedRulePattern: "BIGCO",
      directionConflict: null,
    });
  });

  it("directionGuard: card-ness from the account type or a card ledger source", () => {
    expect(directionGuard(ctx, { amount: 1, source: "plaid:chase", accountType: "credit" }).isCardAccount).toBe(true);
    expect(directionGuard(ctx, { amount: 1, source: "plaid:amex" }).isCardAccount).toBe(true);
    expect(directionGuard(ctx, { amount: 1, source: "plaid:chase", accountType: "depository" }).isCardAccount).toBe(false);
    expect(directionGuard(ctx, { amount: 1, source: "manual" }).isCardAccount).toBe(false);
  });
});
