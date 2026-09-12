// (PR-D review H1, round 3 M1/L2/NIT4) A posted row that replaced a pending row
// carries the filing the household put on the pending row — at READ time, only
// for what it lacks, and a hand filing beats a rule's automatic one.
import { describe, it, expect } from "vitest";
import {
  effectiveFiling,
  needsRuleCheck,
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

  it("with no rules loaded, a posted row with its OWN category keeps it (review M2)", () => {
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

  it("(round 3 L2) the transfer flag carries over, and never switches off", () => {
    expect(effectiveFiling(posted(), replaced({ ...bare, isTransfer: true }), ctx).isTransfer).toBe(true);
    expect(effectiveFiling(posted({ isTransfer: true }), replaced(bare), ctx).isTransfer).toBe(true);
    expect(effectiveFiling(posted(), replaced(bare), ctx).isTransfer).toBe(false);
  });

  it("never mutates either row", () => {
    const p = posted();
    const r = replaced({ ...filed });
    effectiveFiling(p, r, ctx);
    expect(p).toEqual(posted());
    expect(r.filing).toEqual(filed);
  });
});

describe("(round 3 M1) a hand filing on the pending row beats a rule's category on the posted row", () => {
  // The household's rule: "COSTCO GAS" → Groceries.
  const rules: FilingContext = {
    uncategorizedIds: uncat,
    isRuleCategory: (description, categoryId) =>
      description.toUpperCase().includes("COSTCO GAS") && categoryId === "cat-groceries",
  };
  const costco = "COSTCO GAS #0123";

  it("⭐ pending re-filed by hand to Auto, posted with the rule's Groceries → Auto", () => {
    const p = posted({ categoryId: "cat-groceries" }, costco);
    expect(effectiveFiling(p, replaced({ ...bare, categoryId: "cat-auto" }, costco), rules).categoryId).toBe("cat-auto");
  });

  it("a posted row filed by hand away from its rule keeps its own", () => {
    const p = posted({ categoryId: "cat-dining" }, costco);
    expect(effectiveFiling(p, replaced({ ...bare, categoryId: "cat-auto" }, costco), rules).categoryId).toBe("cat-dining");
  });

  it("a pending row filed by the rule itself is not a hand filing: the posted row keeps its own", () => {
    // Rule says Groceries for the pending text; the posted text matches no rule.
    const p = posted({ categoryId: "cat-dining" }, "COSTCO WHSE 1035");
    expect(effectiveFiling(p, replaced({ ...bare, categoryId: "cat-groceries" }, costco), rules).categoryId).toBe("cat-dining");
  });

  it("with no rules at all, the posted row's category is its own (current behaviour)", () => {
    const p = posted({ categoryId: "cat-groceries" }, costco);
    expect(effectiveFiling(p, replaced({ ...bare, categoryId: "cat-auto" }, costco), ctx).categoryId).toBe("cat-groceries");
  });
});

describe("needsRuleCheck", () => {
  it("is true only when a posted row and its pending row both have real, different categories", () => {
    const pairs = new Map([
      ["same", replaced({ ...bare, categoryId: "cat-a" })],
      ["differ", replaced({ ...bare, categoryId: "cat-a" })],
      ["bare", replaced({ ...bare, categoryId: "cat-a" })],
      ["uncat", replaced({ ...bare, categoryId: "cat-a" })],
    ]);
    expect(needsRuleCheck([{ id: "same", categoryId: "cat-a" }], pairs, uncat)).toBe(false);
    expect(needsRuleCheck([{ id: "bare", categoryId: null }], pairs, uncat)).toBe(false);
    expect(needsRuleCheck([{ id: "uncat", categoryId: UNCAT }], pairs, uncat)).toBe(false);
    expect(needsRuleCheck([{ id: "unpaired", categoryId: "cat-b" }], pairs, uncat)).toBe(false);
    expect(needsRuleCheck([{ id: "same", categoryId: "cat-a" }, { id: "differ", categoryId: "cat-b" }], pairs, uncat)).toBe(true);
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
