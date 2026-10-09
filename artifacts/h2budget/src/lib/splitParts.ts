import type { Transaction } from "@workspace/api-client-react";

/**
 * (F4b) CATEGORY SPLITS IN THE CLIENT'S GROUPINGS.
 *
 * `GET /transactions` list rows carry `splits` (each part's category and
 * signed amount, adding up to the charge to the cent) ONLY for a valid split.
 * A charge with no split, an invalid split, or parts that do not add up has no
 * `splits` key and counts whole under its own category: exactly how the
 * server's category totals read it. These helpers are the two groupings'
 * rules (Reports › Cash flow money flow; Budget actuals popover), kept pure so
 * a test can pin them against the old loops.
 */
type Row = Pick<Transaction, "id" | "occurredOn" | "amount" | "categoryId" | "isTransfer" | "description"> & {
  splits?: ReadonlyArray<{ categoryId: string; amount: string }>;
};

const cents = (a: string | number): number => Math.round((Number(a) || 0) * 100);

/** The parts of a valid split, or null (the charge counts whole). */
export function splitPartsOf(t: Pick<Row, "splits">): ReadonlyArray<{ categoryId: string; amount: string }> | null {
  return t.splits && t.splits.length > 0 ? t.splits : null;
}

/**
 * Cash flow money flow: expense per category name for one month, and income
 * per source. An expense charge with a valid split adds each part under its
 * own category; everything else is as it always was.
 */
export function monthMoneyFlow(
  txns: readonly Row[],
  flowMonth: string,
  catNameById: ReadonlyMap<string, string>,
): { incomeByDesc: Map<string, number>; expenseByCat: Map<string, number> } {
  const incomeByDesc = new Map<string, number>();
  const expenseByCat = new Map<string, number>();
  const nameOf = (categoryId: string | null | undefined) =>
    categoryId ? (catNameById.get(categoryId) ?? "Uncategorized") : "Uncategorized";
  for (const t of txns) {
    if (!t.occurredOn.startsWith(flowMonth)) continue;
    const a = Number(t.amount) || 0;
    if (a > 0) {
      const k = t.description?.split(" ")[0] ?? "Income";
      incomeByDesc.set(k, (incomeByDesc.get(k) ?? 0) + a);
    } else if (a < 0) {
      const parts = splitPartsOf(t);
      if (parts) {
        for (const p of parts) {
          const k = nameOf(p.categoryId);
          expenseByCat.set(k, (expenseByCat.get(k) ?? 0) + -(Number(p.amount) || 0));
        }
      } else {
        const k = nameOf(t.categoryId);
        expenseByCat.set(k, (expenseByCat.get(k) ?? 0) + -a);
      }
    }
  }
  return { incomeByDesc, expenseByCat };
}

/**
 * Budget actuals popover: the month's transactions indexed by category. A
 * charge with a valid split appears under each part's category as a row whose
 * amount is that part (same id; parts of one category are added up), so the
 * drill ties to the server's per-category actual. Other rows are filed as
 * before: under the category they inherited from a replaced pending row, else
 * their own.
 */
export function groupTxnsByCategory<T extends Row>(
  txns: readonly T[],
  opts: {
    replaced: ReadonlySet<string>;
    inherited: ReadonlyMap<string, string>;
    start: string;
    end: string;
  },
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  const add = (categoryId: string, row: T) => {
    const arr = map.get(categoryId) ?? [];
    arr.push(row);
    map.set(categoryId, arr);
  };
  for (const t of txns) {
    if (t.isTransfer) continue;
    if (opts.replaced.has(t.id)) continue;
    if (t.occurredOn < opts.start || t.occurredOn >= opts.end) continue;
    const parts = splitPartsOf(t);
    if (parts) {
      const sums = new Map<string, number>();
      for (const p of parts) sums.set(p.categoryId, (sums.get(p.categoryId) ?? 0) + cents(p.amount));
      for (const [categoryId, c] of sums) add(categoryId, { ...t, categoryId, amount: (c / 100).toFixed(2) });
      continue;
    }
    const categoryId = opts.inherited.get(t.id) ?? t.categoryId;
    if (!categoryId) continue;
    add(categoryId, t);
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
  return map;
}
