// (PR-D review H1/H2, round 4; round 3 M1/L2/NIT4) A posted row that replaced
// a pending row carries the filing the household put on the pending row — at
// READ time, only for what it lacks, and a hand filing beats an automatic
// one. Round 4 decides "hand vs automatic" from the stored
// `isTransferUserOverridden` flag, never by re-reading the household's
// mapping rules (round 3's approach misread a row the user just re-filed,
// because `PATCH /transactions/:id` repoints matching rules onto the same
// pick — review H1). Round 4 also refuses to let an auto-tagged pending
// row's transfer flag override a posted row the user filed by hand, either
// way (review H2).
import { describe, it, expect } from "vitest";
import {
  effectiveFiling,
  uncategorizedCategoryIds,
  type Filing,
  type FilingContext,
} from "./pendingFiling";
import { UNCATEGORIZED_CATEGORY_NAME } from "./budgetSeed";

const UNCAT = "cat-uncategorized";
const uncat = new Set([UNCAT]);
const ctx: FilingContext = { uncategorizedIds: uncat };

const bare: Filing = {
  categoryId: null,
  weeklyAllowance: false,
  monthlyAllowance: false,
  unplannedAllowance: false,
  weeklyBucket: null,
  reimbursable: false,
  debtId: null,
  isTransfer: false,
  isTransferUserOverridden: false,
};
const filed: Filing = {
  ...bare,
  categoryId: "cat-eating-out",
  weeklyAllowance: true,
  weeklyBucket: "dining",
};
const posted = (f: Partial<Filing> = {}, description = "OLIVE GARDEN 1234") => ({
  ...bare,
  ...f,
  description,
});
const replaced = (filing: Filing, description = "OLIVE GARDEN 1234") => ({ description, filing });

describe("effectiveFiling", () => {
  it("with no replaced pending row, the posted row is what it is", () => {
    const p = { ...posted(), id: "t1" };
    expect(effectiveFiling(p, undefined, ctx)).toEqual(p);
    expect(effectiveFiling(p, null, ctx)).toEqual(p);
  });

  it("⭐ an unfiled posted row (sync's fresh insert) takes the pending row's category, allowance flags and slice", () => {
    const p = { ...posted(), id: "t-posted", amount: "-48.00" };
    expect(effectiveFiling(p, replaced(filed), ctx)).toEqual({
      ...p,
      categoryId: "cat-eating-out",
      weeklyAllowance: true,
      weeklyBucket: "dining",
    });
  });

  it("a posted row parked in the system Uncategorized category also takes the pending row's category", () => {
    expect(effectiveFiling(posted({ categoryId: UNCAT }), replaced(filed), ctx).categoryId).toBe("cat-eating-out");
  });

  it("with no replaced category, a posted row with its OWN category keeps it (review M2)", () => {
    expect(effectiveFiling(posted({ categoryId: "cat-groceries" }), replaced(filed), ctx).categoryId).toBe("cat-groceries");
  });

  it("a pending row with no category, or only Uncategorized, gives none", () => {
    expect(effectiveFiling(posted(), replaced({ ...bare, categoryId: UNCAT }), ctx).categoryId).toBeNull();
    expect(effectiveFiling(posted({ categoryId: UNCAT }), replaced(bare), ctx).categoryId).toBe(UNCAT);
  });

  it("allowance flags come over only when the posted row has none of the three (review M2)", () => {
    const pendingUnplanned: Filing = { ...bare, unplannedAllowance: true };
    const postedWeekly = posted({ weeklyAllowance: true, weeklyBucket: "misc" });
    expect(effectiveFiling(postedWeekly, replaced(pendingUnplanned), ctx)).toEqual(postedWeekly);
    expect(effectiveFiling(posted({ monthlyAllowance: true }), replaced(filed), ctx)).toMatchObject({
      weeklyAllowance: false,
      monthlyAllowance: true,
      weeklyBucket: null,
    });
    expect(effectiveFiling(posted(), replaced(pendingUnplanned), ctx)).toMatchObject({
      unplannedAllowance: true,
      weeklyAllowance: false,
      monthlyAllowance: false,
    });
  });

  it("the posted row's own slice is kept when it has one (mergeStatePatch fills blanks only)", () => {
    expect(effectiveFiling(posted({ weeklyBucket: "groceries" }), replaced(filed), ctx)).toMatchObject({
      weeklyAllowance: true,
      weeklyBucket: "groceries",
    });
  });

  it("(round 3 NIT4) a posted row with its OWN weekly flag but no slice takes the slice of a weekly pending row", () => {
    expect(effectiveFiling(posted({ weeklyAllowance: true }), replaced(filed), ctx)).toMatchObject({
      weeklyAllowance: true,
      weeklyBucket: "dining",
    });
    // A pending row that was not weekly has no slice to give.
    const monthlyWithSlice: Filing = { ...bare, monthlyAllowance: true, weeklyBucket: "dining" };
    expect(effectiveFiling(posted({ weeklyAllowance: true }), replaced(monthlyWithSlice), ctx).weeklyBucket).toBeNull();
  });

  it("reimbursable and a debt tag carry over when the posted row lacks them, and never switch off", () => {
    expect(effectiveFiling(posted(), replaced({ ...bare, reimbursable: true }), ctx).reimbursable).toBe(true);
    expect(effectiveFiling(posted({ reimbursable: true }), replaced(bare), ctx).reimbursable).toBe(true);
    expect(effectiveFiling(posted(), replaced({ ...bare, debtId: "debt-1" }), ctx).debtId).toBe("debt-1");
    expect(effectiveFiling(posted({ debtId: "debt-2" }), replaced({ ...bare, debtId: "debt-1" }), ctx).debtId).toBe("debt-2");
  });

  it("never mutates either row", () => {
    const p = posted();
    const r = replaced({ ...filed });
    effectiveFiling(p, r, ctx);
    expect(p).toEqual(posted());
    expect(r.filing).toEqual(filed);
  });
});

describe("(round 4) categoryId: an override on either row decides, never the mapping rules", () => {
  it("⭐ P overridden, Q not: P's own category stands even though it differs from Q's", () => {
    const p = posted({ categoryId: "cat-auto", isTransferUserOverridden: true });
    const q = replaced({ ...bare, categoryId: "cat-groceries" });
    expect(effectiveFiling(p, q, ctx).categoryId).toBe("cat-auto");
  });

  it("⭐ Q overridden, P not: Q's hand filing beats P's automatic category", () => {
    const p = posted({ categoryId: "cat-groceries" });
    const q = replaced({ ...bare, categoryId: "cat-auto", isTransferUserOverridden: true });
    expect(effectiveFiling(p, q, ctx).categoryId).toBe("cat-auto");
  });

  it("neither overridden: P's own category stands", () => {
    const p = posted({ categoryId: "cat-groceries" });
    const q = replaced({ ...bare, categoryId: "cat-auto" });
    expect(effectiveFiling(p, q, ctx).categoryId).toBe("cat-groceries");
  });

  it("both overridden: P's own category stands (P's hand filing is not overruled by another hand filing)", () => {
    const p = posted({ categoryId: "cat-groceries", isTransferUserOverridden: true });
    const q = replaced({ ...bare, categoryId: "cat-auto", isTransferUserOverridden: true });
    expect(effectiveFiling(p, q, ctx).categoryId).toBe("cat-groceries");
  });

  // The real-route regression the review found (H1): the mapping rule
  // COSTCO WHSE → Groceries stays untouched throughout — it must never be
  // consulted, and the outcome must not depend on it.
  it("H1 repro, PATCH the posted row: a rule-matched pending+posted pair, the posted row re-filed by hand to Auto → Auto stands", () => {
    // Both rows arrived via the rule (no override on either) before the PATCH.
    // The PATCH sets categoryId=Auto AND isTransferUserOverridden=true on P.
    const p = posted({ categoryId: "cat-auto", isTransferUserOverridden: true }, "COSTCO WHSE 1035");
    const q = replaced({ ...bare, categoryId: "cat-groceries" }, "COSTCO WHSE 1035");
    expect(effectiveFiling(p, q, ctx).categoryId).toBe("cat-auto");
  });

  it("H1 repro, PATCH the pending row instead: re-filing Q to Auto by hand carries onto an un-overridden posted row", () => {
    const p = posted({ categoryId: "cat-groceries" }, "COSTCO WHSE 1035");
    const q = replaced({ ...bare, categoryId: "cat-auto", isTransferUserOverridden: true }, "COSTCO WHSE 1035");
    expect(effectiveFiling(p, q, ctx).categoryId).toBe("cat-auto");
  });

  it("H1 repro, rule deleted/repointed with no PATCH: outcome is unaffected by rule state — neither row overridden, P's own stands", () => {
    const p = posted({ categoryId: "cat-groceries" }, "COSTCO WHSE 1035");
    const q = replaced({ ...bare, categoryId: "cat-groceries" }, "COSTCO WHSE 1035");
    expect(effectiveFiling(p, q, ctx).categoryId).toBe("cat-groceries");
  });
});

describe("(round 4, review H2) isTransfer only inherits a USER-SET flag, and never onto an overridden posted row", () => {
  it("Q's transfer flag was user-set, P is plain and un-overridden: P becomes a transfer", () => {
    const p = posted();
    const q = replaced({ ...bare, isTransfer: true, isTransferUserOverridden: true });
    expect(effectiveFiling(p, q, ctx).isTransfer).toBe(true);
  });

  it("⭐ H2 repro: Q's transfer flag was AUTO (sync heuristic, no override) → never inherited", () => {
    const p = posted();
    const q = replaced({ ...bare, isTransfer: true, isTransferUserOverridden: false });
    expect(effectiveFiling(p, q, ctx).isTransfer).toBe(false);
  });

  it("⭐ H2 repro: P was filed Dining with isTransfer explicitly false and overridden — Q's user-set transfer flag never flips it", () => {
    const p = posted({ categoryId: "cat-dining", isTransfer: false, isTransferUserOverridden: true });
    const q = replaced({ ...bare, isTransfer: true, isTransferUserOverridden: true });
    expect(effectiveFiling(p, q, ctx).isTransfer).toBe(false);
  });

  it("P already a transfer: stays a transfer regardless of Q", () => {
    expect(effectiveFiling(posted({ isTransfer: true }), replaced(bare), ctx).isTransfer).toBe(true);
  });

  it("neither is a transfer: false", () => {
    expect(effectiveFiling(posted(), replaced(bare), ctx).isTransfer).toBe(false);
  });
});

describe("uncategorizedCategoryIds", () => {
  it("finds the system category by its name, and nothing else", () => {
    const ids = uncategorizedCategoryIds([
      { id: "a", name: UNCATEGORIZED_CATEGORY_NAME },
      { id: "b", name: "Uncategorized — transfer" },
      { id: "c", name: "Dining" },
    ]);
    expect([...ids]).toEqual(["a"]);
  });
});
