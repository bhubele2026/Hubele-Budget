// (PR-D review H1) A posted row that replaced a pending row inherits the filing
// the household put on the pending row — at READ time, only for what it lacks.
import { describe, it, expect } from "vitest";
import { effectiveFiling, uncategorizedCategoryIds, type Filing } from "./pendingFiling";
import { UNCATEGORIZED_CATEGORY_NAME } from "./budgetSeed";

const UNCAT = "cat-uncategorized";
const uncat = new Set([UNCAT]);

const bare: Filing = {
  categoryId: null,
  weeklyAllowance: false,
  monthlyAllowance: false,
  unplannedAllowance: false,
  weeklyBucket: null,
  reimbursable: false,
  debtId: null,
};
const filed: Filing = {
  categoryId: "cat-eating-out",
  weeklyAllowance: true,
  monthlyAllowance: false,
  unplannedAllowance: false,
  weeklyBucket: "dining",
  reimbursable: false,
  debtId: null,
};

describe("effectiveFiling", () => {
  it("with no replaced pending row, the posted row is what it is", () => {
    const posted = { ...bare, id: "t1" };
    expect(effectiveFiling(posted, undefined, uncat)).toEqual(posted);
    expect(effectiveFiling(posted, null, uncat)).toEqual(posted);
  });

  it("⭐ an unfiled posted row (sync's fresh insert) takes the pending row's category, allowance flags and slice", () => {
    const posted = { ...bare, id: "t-posted", amount: "-48.00" };
    expect(effectiveFiling(posted, filed, uncat)).toEqual({
      ...posted,
      categoryId: "cat-eating-out",
      weeklyAllowance: true,
      weeklyBucket: "dining",
    });
  });

  it("a posted row parked in the system Uncategorized category also takes the pending row's category", () => {
    const posted = { ...bare, categoryId: UNCAT };
    expect(effectiveFiling(posted, filed, uncat).categoryId).toBe("cat-eating-out");
  });

  it("a posted row with its OWN category keeps it (review M2)", () => {
    const posted = { ...bare, categoryId: "cat-groceries" };
    expect(effectiveFiling(posted, filed, uncat).categoryId).toBe("cat-groceries");
  });

  it("a pending row with no category, or only Uncategorized, gives none", () => {
    expect(effectiveFiling(bare, { ...bare, categoryId: UNCAT }, uncat).categoryId).toBeNull();
    expect(effectiveFiling({ ...bare, categoryId: UNCAT }, bare, uncat).categoryId).toBe(UNCAT);
  });

  it("allowance flags come over only when the posted row has none of the three (review M2)", () => {
    const pendingUnplanned: Filing = { ...bare, unplannedAllowance: true };
    const postedWeekly: Filing = { ...bare, weeklyAllowance: true, weeklyBucket: "misc" };
    expect(effectiveFiling(postedWeekly, pendingUnplanned, uncat)).toEqual(postedWeekly);
    const postedMonthly: Filing = { ...bare, monthlyAllowance: true };
    expect(effectiveFiling(postedMonthly, filed, uncat)).toMatchObject({
      weeklyAllowance: false,
      monthlyAllowance: true,
      weeklyBucket: null,
    });
    expect(effectiveFiling(bare, pendingUnplanned, uncat)).toMatchObject({
      unplannedAllowance: true,
      weeklyAllowance: false,
      monthlyAllowance: false,
    });
  });

  it("the posted row's own slice is kept when it has one (mergeStatePatch fills blanks only)", () => {
    const posted: Filing = { ...bare, weeklyBucket: "groceries" };
    expect(effectiveFiling(posted, filed, uncat)).toMatchObject({
      weeklyAllowance: true,
      weeklyBucket: "groceries",
    });
  });

  it("reimbursable and a debt tag carry over when the posted row lacks them, and never switch off", () => {
    expect(effectiveFiling(bare, { ...bare, reimbursable: true }, uncat).reimbursable).toBe(true);
    expect(effectiveFiling({ ...bare, reimbursable: true }, bare, uncat).reimbursable).toBe(true);
    expect(effectiveFiling(bare, { ...bare, debtId: "debt-1" }, uncat).debtId).toBe("debt-1");
    expect(effectiveFiling({ ...bare, debtId: "debt-2" }, { ...bare, debtId: "debt-1" }, uncat).debtId).toBe("debt-2");
  });

  it("never mutates either row", () => {
    const posted = { ...bare };
    const pending = { ...filed };
    effectiveFiling(posted, pending, uncat);
    expect(posted).toEqual(bare);
    expect(pending).toEqual(filed);
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
