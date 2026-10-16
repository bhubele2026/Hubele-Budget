import { describe, expect, it } from "vitest";
import { categoryProvenance, provenanceWords, rowStatuses, spendingWords } from "./amexRowWords";

/** (P1) The calm row's words: formatting only — the row's flags and the server's answers. */
const row = (o: Record<string, unknown> = {}) =>
  ({
    id: "t1",
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    reimbursable: false,
    isTransfer: false,
    isTransferUserOverridden: false,
    isExternalCardPayment: false,
    pending: false,
    expiredHold: false,
    categoryId: null,
    matchedRuleId: null,
    categoryLockedByUser: false,
    ...o,
  }) as never;
const opts = (o: Partial<{ ignored: boolean; unfiled: boolean; kind: never }> = {}) => ({ ignored: false, unfiled: false, kind: "purchase" as never, ...o });

describe("spendingWords", () => {
  it("an expired hold says nothing here: its label already says 'not counted'", () => {
    expect(spendingWords(row({ expiredHold: true, weeklyAllowance: true }), opts())).toBe("");
  });
  it("a transfer, or a row in Ignore, is not counted", () => {
    expect(spendingWords(row({ isTransfer: true }), opts({ kind: "payment" as never }))).toBe("Not counted");
    expect(spendingWords(row({ weeklyAllowance: true }), opts({ ignored: true }))).toBe("Not counted");
  });
  it("the bucket flags, in the marks' order, with Reimbursable beside them", () => {
    expect(spendingWords(row({ weeklyAllowance: true }), opts())).toBe("Weekly");
    expect(spendingWords(row({ monthlyAllowance: true }), opts())).toBe("Monthly");
    expect(spendingWords(row({ unplannedAllowance: true, reimbursable: true }), opts())).toBe("Unplanned · Reimbursable");
    expect(spendingWords(row({ reimbursable: true }), opts({ unfiled: true }))).toBe("Reimbursable");
  });
  it("no flag: the server's 'not filed yet' row, else its kind, else a dash", () => {
    expect(spendingWords(row(), opts({ unfiled: true }))).toBe("Not filed yet");
    expect(spendingWords(row(), opts())).toBe("No bucket");
    expect(spendingWords(row(), opts({ kind: "refund" as never }))).toBe("Refund");
    expect(spendingWords(row(), opts({ kind: "payment" as never }))).toBe("Payment");
    expect(spendingWords(row(), opts({ kind: "other_credit" as never }))).toBe("Credit");
    expect(spendingWords(row(), opts({ kind: null as never }))).toBe("—");
  });
});

describe("rowStatuses", () => {
  it("only what applies, in reading order: Pending · Transfer · Not in avalanche · Ignored", () => {
    expect(rowStatuses(row(), false)).toEqual([]);
    const all = rowStatuses(row({ pending: true, isTransfer: true, isExternalCardPayment: true }), true);
    expect(all.map((s) => s.label)).toEqual(["Pending", "Transfer", "Not in avalanche", "Ignored"]);
    expect(all.map((s) => s.testId)).toEqual(["chip-pending-t1", "badge-transfer-t1", "badge-external-card-t1", "chip-ignored-t1"]);
  });
  it("an expired hold is never also 'Pending'", () => {
    expect(rowStatuses(row({ pending: true, expiredHold: true }), false)).toEqual([]);
  });
});

describe("categoryProvenance — never a 'Manual' guess", () => {
  const rules = [
    { id: "r1", pattern: "CAFE", matchType: "contains", categoryId: "c-din" },
    { id: "r2", pattern: "SHOP", matchType: "starts_with", categoryId: "c-other" },
  ];
  it("no category, or the system Uncategorized", () => {
    expect(categoryProvenance(row(), rules, "c-unc")).toEqual({ kind: "empty" });
    expect(categoryProvenance(row({ categoryId: "c-unc" }), rules, "c-unc")).toEqual({ kind: "empty" });
    expect(provenanceWords({ kind: "empty" })).toBe("No category yet.");
  });
  it("chosen by a person wins over any rule", () => {
    const p = categoryProvenance(row({ categoryId: "c-din", matchedRuleId: "r1", categoryLockedByUser: true }), rules, null);
    expect(p).toEqual({ kind: "hand" });
    expect(provenanceWords(p)).toBe("Chosen by hand.");
  });
  it("the matched rule, while it still points at this category", () => {
    const p = categoryProvenance(row({ categoryId: "c-din", matchedRuleId: "r1" }), rules, null);
    expect(p).toEqual({ kind: "rule", ruleId: "r1", pattern: "CAFE", matchWords: "contains" });
    expect(provenanceWords(p)).toBe('Set by rule "CAFE" (contains).');
  });
  it("a rule that points elsewhere, or none at all: no rule matches this category", () => {
    expect(categoryProvenance(row({ categoryId: "c-din", matchedRuleId: "r2" }), rules, null)).toEqual({ kind: "no_rule" });
    expect(categoryProvenance(row({ categoryId: "c-din" }), rules, null)).toEqual({ kind: "no_rule" });
    expect(provenanceWords({ kind: "no_rule" })).toBe("No rule matches this category.");
  });
});
