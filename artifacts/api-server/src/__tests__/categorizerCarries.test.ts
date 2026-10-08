// (PR-A, PR-0 residuals) category_locked_by_user travels with a carried
// category: through a dedupe merge and through the pending → posted filing.
import { describe, it, expect } from "vitest";
import { mergeStatePatch } from "../lib/dedupeTransactions";
import { effectiveFiling, type Filing } from "../lib/pendingFiling";
import { transactionsTable } from "@workspace/db";

type Row = typeof transactionsTable.$inferSelect;
const base = { categoryId: null, categoryLockedByUser: false, isTransferUserOverridden: false, isTransfer: false } as unknown as Row;

describe("dedupe merge carries the lock with the category", () => {
  it("survivor without a category takes the loser's category AND its lock", () => {
    const p = mergeStatePatch({ ...base } as Row, { ...base, categoryId: "c1", categoryLockedByUser: true } as Row);
    expect(p).toMatchObject({ categoryId: "c1", categoryLockedByUser: true });
  });
  it("a survivor with its own category is not relabelled locked", () => {
    const p = mergeStatePatch({ ...base, categoryId: "c0" } as Row, { ...base, categoryId: "c1", categoryLockedByUser: true } as Row);
    expect(p.categoryLockedByUser).toBeUndefined();
    expect(p.categoryId).toBeUndefined();
  });
});

describe("pending → posted filing carries the lock with the category", () => {
  const filing = (o: Partial<Filing>): Filing => ({
    categoryId: null, weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false,
    weeklyBucket: null, reimbursable: false, debtId: null, isTransfer: false, isTransferUserOverridden: false, ...o,
  });
  const ctx = { uncategorizedIds: new Set<string>() };
  it("a hand-filed, locked pending row hands both to a bare posted row", () => {
    const out = effectiveFiling({ ...filing({}), description: "X" }, { description: "X", filing: filing({ categoryId: "c1", categoryLockedByUser: true, isTransferUserOverridden: true }) }, ctx);
    expect(out).toMatchObject({ categoryId: "c1", categoryLockedByUser: true });
  });
  it("no carry, no lock: the posted row's own category stands", () => {
    const out = effectiveFiling({ ...filing({ categoryId: "c0", isTransferUserOverridden: true }), description: "X" }, { description: "X", filing: filing({ categoryId: "c1", categoryLockedByUser: true, isTransferUserOverridden: true }) }, ctx);
    expect(out.categoryId).toBe("c0");
    expect(out.categoryLockedByUser).toBeUndefined();
  });
});
