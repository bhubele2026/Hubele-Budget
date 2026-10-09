import { describe, expect, it } from "vitest";
import { groupTxnsByCategory, monthMoneyFlow, splitPartsOf } from "./splitParts";

type T = Parameters<typeof groupTxnsByCategory>[0][number];
const tx = (id: string, occurredOn: string, amount: string, categoryId: string | null, o: Record<string, unknown> = {}): T =>
  ({ id, occurredOn, amount, categoryId, description: `MERCH${id} X`, isTransfer: false, ...o }) as T;

// The two loops as they were on main before F4b (reference copies).
function oldMoneyFlow(txns: readonly T[], flowMonth: string, names: ReadonlyMap<string, string>) {
  const incomeByDesc = new Map<string, number>();
  const expenseByCat = new Map<string, number>();
  for (const t of txns) {
    if (!t.occurredOn.startsWith(flowMonth)) continue;
    const a = Number(t.amount) || 0;
    if (a > 0) {
      const k = t.description?.split(" ")[0] ?? "Income";
      incomeByDesc.set(k, (incomeByDesc.get(k) ?? 0) + a);
    } else if (a < 0) {
      const k = t.categoryId ? names.get(t.categoryId) ?? "Uncategorized" : "Uncategorized";
      expenseByCat.set(k, (expenseByCat.get(k) ?? 0) + -a);
    }
  }
  return { incomeByDesc, expenseByCat };
}
function oldGroup(txns: readonly T[], replaced: Set<string>, inherited: Map<string, string>, start: string, end: string) {
  const map = new Map<string, T[]>();
  for (const t of txns) {
    if (t.isTransfer) continue;
    if (replaced.has(t.id)) continue;
    const categoryId = inherited.get(t.id) ?? t.categoryId;
    if (!categoryId) continue;
    if (t.occurredOn < start || t.occurredOn >= end) continue;
    const arr = map.get(categoryId) ?? [];
    arr.push(t);
    map.set(categoryId, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
  return map;
}

const NAMES = new Map([["g", "Groceries"], ["h", "Household"], ["f", "Gifts"]]);
const PLAIN: T[] = [
  tx("1", "2026-09-03", "-40.10", "g"),
  tx("2", "2026-09-09", "-12.00", "h"),
  tx("3", "2026-09-09", "-7.25", null),
  tx("4", "2026-09-10", "1500.00", "g", { description: "PAYROLL ACME" }),
  tx("5", "2026-09-11", "-99.99", "g", { isTransfer: true }),
  tx("6", "2026-09-12", "-5.00", "zz"),
  tx("7", "2026-08-30", "-8.00", "g"),
  tx("8", "2026-09-14", "-3.30", "g"),
  tx("9", "2026-09-15", "-20.00", null),
  tx("10", "2026-09-16", "-61.00", "h"),
];
const OPTS = { replaced: new Set(["8"]), inherited: new Map([["9", "f"]]), start: "2026-09-01", end: "2026-10-01" };

describe("with NO splits every figure is identical to main", () => {
  it("money flow", () => {
    expect(monthMoneyFlow(PLAIN, "2026-09", NAMES)).toEqual(oldMoneyFlow(PLAIN, "2026-09", NAMES));
  });
  it("the Budget category index (same Map, same rows, same order)", () => {
    const now = groupTxnsByCategory(PLAIN, OPTS);
    const was = oldGroup(PLAIN, OPTS.replaced, OPTS.inherited, OPTS.start, OPTS.end);
    expect([...now.keys()].sort()).toEqual([...was.keys()].sort());
    for (const [k, rows] of was) expect(now.get(k)).toEqual(rows);
    for (const rows of now.values()) for (const r of rows) expect(PLAIN).toContain(r); // the very same row objects
  });
});

const SPLIT = tx("s", "2026-09-12", "-100.00", "g", {
  splits: [
    { categoryId: "h", amount: "-60.00" },
    { categoryId: "f", amount: "-40.00" },
  ],
});

describe("a valid split files each part under its own category", () => {
  it("money flow: the parts land in their categories and the month total is unchanged", () => {
    const whole = monthMoneyFlow([...PLAIN, { ...SPLIT, splits: undefined } as T], "2026-09", NAMES);
    const parts = monthMoneyFlow([...PLAIN, SPLIT], "2026-09", NAMES);
    expect(parts.expenseByCat.get("Gifts")).toBeCloseTo(40, 6);
    expect(parts.expenseByCat.get("Household")).toBeCloseTo(61 + 12 + 60, 6);
    expect(parts.expenseByCat.get("Groceries")).toBeCloseTo((whole.expenseByCat.get("Groceries") ?? 0) - 100, 6);
    const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
    expect(sum(parts.expenseByCat)).toBeCloseTo(sum(whole.expenseByCat), 6);
    expect(parts.incomeByDesc).toEqual(whole.incomeByDesc);
  });

  it("Budget index: the parent is under each part's category with the part's amount; the sums tie", () => {
    const m = groupTxnsByCategory([...PLAIN, SPLIT], OPTS);
    const own = (k: string) => m.get(k)!.find((r) => r.id === "s")!;
    expect(own("h").amount).toBe("-60.00");
    expect(own("f").amount).toBe("-40.00");
    expect(own("h").categoryId).toBe("h");
    expect(m.get("g")!.some((r) => r.id === "s")).toBe(false); // the parent's own category no longer holds the whole charge
    const total = [...m.values()].flat().filter((r) => r.id === "s").reduce((s, r) => s + Number(r.amount), 0);
    expect(total).toBeCloseTo(-100, 6);
  });

  it("two parts in one category are added up into one row", () => {
    const t = tx("d", "2026-09-05", "-30.00", "g", {
      splits: [{ categoryId: "h", amount: "-10.10" }, { categoryId: "h", amount: "-19.90" }],
    });
    const rows = groupTxnsByCategory([t], OPTS).get("h")!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe("-30.00");
  });
});

describe("an invalid split counts whole (the server sends no `splits`)", () => {
  const invalid = { ...SPLIT, splits: undefined } as T;
  it("money flow files it whole under the parent's category", () => {
    const m = monthMoneyFlow([invalid], "2026-09", NAMES);
    expect(m.expenseByCat).toEqual(new Map([["Groceries", 100]]));
  });
  it("the Budget index files it whole under the parent's category", () => {
    const m = groupTxnsByCategory([invalid], OPTS);
    expect([...m.keys()]).toEqual(["g"]);
    expect(m.get("g")![0]).toBe(invalid);
  });
  it("splitPartsOf treats absent and empty as whole", () => {
    expect(splitPartsOf({})).toBeNull();
    expect(splitPartsOf({ splits: [] })).toBeNull();
  });
});
