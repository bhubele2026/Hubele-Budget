import { describe, it, expect } from "vitest";
import type { ImportHistoryItem, ImportPreview, ImportStateSummary } from "@workspace/api-client-react/features";
import {
  addsLine,
  confirmLabel,
  confirmQuestion,
  daySpan,
  historyLine,
  historyNote,
  importedLine,
  keptEditsLine,
  keptLine,
  restoredLine,
  stateLine,
} from "./importWords";

// (W) The import's words: short, plural-correct, every number the server's.
const S = (over: Partial<ImportStateSummary> = {}): ImportStateSummary => ({
  transactions: 2, bankTransactions: 1, bankFrom: "2026-10-01", bankTo: "2026-10-01", categories: 1, budgetLines: 1,
  debts: 1, rules: 1, recurring: 0, monthlySnapshots: 0, decisions: 0, splits: 0, ...over,
});
const P = (replaces: ImportStateSummary, adds = 1): ImportPreview => ({
  fileName: "f.xlsx",
  confirmToken: "t",
  adds: { transactions: adds, from: null, to: null, categories: 0, budgetLines: 0, debts: 0, rules: 0, recurring: 0, monthlySnapshots: 0 },
  replaces,
  rulesKept: 0,
});

describe("(W) import words", () => {
  it("the confirmation question names the bank rows (singular and plural)", () => {
    expect(confirmQuestion(P(S()))).toBe("Replace 2 transactions, including 1 bank row?");
    expect(confirmQuestion(P(S({ transactions: 1, bankTransactions: 0 })))).toBe("Replace 1 transaction?");
    expect(confirmQuestion(P(S({ transactions: 1250, bankTransactions: 1200 })))).toBe("Replace 1,250 transactions, including 1,200 bank rows?");
    expect(confirmQuestion(P(S({ transactions: 0, bankTransactions: 0 }), 1))).toBe("Import 1 transaction?");
  });

  it("the button says Replace when anything of the person's goes, else Import", () => {
    expect(confirmLabel(P(S()))).toBe("Replace");
    expect(confirmLabel(P(S({ transactions: 0, bankTransactions: 0, debts: 0, rules: 0, budgetLines: 0 })))).toBe("Replace");
    expect(confirmLabel(P(S({ transactions: 0, bankTransactions: 0, categories: 0, debts: 0, rules: 0, budgetLines: 0 })))).toBe("Import");
  });

  it("day spans: one day once; the year only off this year", () => {
    expect(daySpan("2026-10-01", "2026-10-01", 2026)).toBe("Oct 1");
    expect(daySpan("2026-07-01", "2026-10-16", 2026)).toBe("Jul 1 – Oct 16");
    expect(daySpan("2025-12-30", "2026-01-02", 2026)).toBe("Dec 30, 2025 – Jan 2, 2026");
    expect(daySpan(null, "2026-01-02", 2026)).toBeNull();
  });

  it("the adds and state lines", () => {
    expect(addsLine({ transactions: 1, from: "2026-10-01", to: "2026-10-01", categories: 1, budgetLines: 1, debts: 1, rules: 1, recurring: 0, monthlySnapshots: 0 }).replace(/, Oct 1/, "")).toBe("1 transaction · 1 category · 1 rule · 1 debt");
    expect(stateLine(S({ bankTransactions: 0, bankFrom: null, bankTo: null }))).toBe("2 transactions · 1 category · 1 rule · 1 debt");
  });

  it("success, kept and restored lines", () => {
    expect(importedLine({ transactions: 1 })).toBe("Imported 1 row · Restore available in History");
    expect(importedLine({})).toBe("Imported 0 rows · Restore available in History");
    expect(keptEditsLine({ mapping_rules_preserved: 0, transactions_preserved: 0 })).toBeNull();
    expect(keptEditsLine({ mapping_rules_preserved: 2, transactions_preserved: 1 })).toBe("Kept 2 rules and 1 category edit.");
    expect(keptLine(0)).toBeNull();
    expect(keptLine(2)).toBe("2 of your rules");
    expect(restoredLine(S({ transactions: 1 }))).toBe("Restored · 1 transaction back");
  });

  it("history rows and their status words", () => {
    const base: ImportHistoryItem = {
      batchId: "b", fileName: null, importedAt: "2026-10-16T17:12:00.000Z", counts: null, replaced: null,
      snapshotId: "s", restoredAt: null, restore: "available",
    };
    expect(historyLine(base)).toBe("Oct 16, 12:12 PM · Workbook");
    expect(historyLine({ ...base, fileName: "a.xlsx", counts: { transactions: 1 } })).toBe("Oct 16, 12:12 PM · a.xlsx · 1 row");
    expect(historyNote(base)).toBeNull();
    expect(historyNote({ ...base, restore: "later_import" })).toBe("Restore the newer import first");
    expect(historyNote({ ...base, restore: "too_old" })).toBe("Too old to restore");
    expect(historyNote({ ...base, restore: "none", snapshotId: null })).toBe("No copy kept");
    expect(historyNote({ ...base, restore: "restored", restoredAt: "2026-10-16T18:30:00.000Z" })).toBe("Restored Oct 16, 1:30 PM");
  });
});
