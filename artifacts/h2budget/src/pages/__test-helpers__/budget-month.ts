/**
 * A well-formed `GET /budget/months/:m` response for the Budget page specs.
 *
 * The page reads `lines` (flat, classified by `planSource`) rather than the
 * legacy `groups` array, and reads its headline off `planBySource`. Both are
 * built here from one list of lines so a spec declares only what it is testing
 * and cannot accidentally hand the page a month whose sections and total
 * disagree — which is the exact class of bug the server rollup exists to stop.
 *
 * ⚠️ `plannedTotal` here is bills + debts, matching the server. A spec that
 * wants an inconsistent payload should build it inline and say why.
 */

export type TestLine = {
  id: string | null;
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  actualAmount: string;
  note: string | null;
  groupName: string;
  sourceKind: string;
  sortOrder: number;
  kind: string;
  pinned: boolean;
  planSource: "income" | "bills" | "debts" | "unbacked";
  sourceBreakdown: Array<{ source: string; count: number; amount: string }>;
  plannedSource?: {
    kind: "bills" | "pinned" | "derived" | "manual";
    bills: Array<{
      id: string;
      name: string;
      amount: string;
      frequency: string;
      eventCount: number;
    }>;
  };
};

export function makeLine(over: Partial<TestLine> = {}): TestLine {
  return {
    id: "line-x",
    categoryId: "cat-x",
    categoryName: "Cat X",
    plannedAmount: "100",
    actualAmount: "0",
    note: null,
    groupName: "Variable",
    sourceKind: "manual",
    sortOrder: 0,
    kind: "expense",
    pinned: false,
    planSource: "unbacked",
    sourceBreakdown: [],
    ...over,
  };
}

const n = (v: string) => parseFloat(v) || 0;
const money = (v: number) => v.toFixed(2);

type Bucket = { planned: string; actual: string; lineCount: number };

type Pair = { budget: string; actual: string };
export type TestSummary = {
  income: Pair;
  expenses: Pair;
  net: Pair;
  percentSpent: Pair;
};

export type TestAllowanceLine = {
  bucket: "weekly" | "monthly" | "unplanned";
  planned: string;
  actual: string;
  count: number;
  subBuckets: Array<{ bucket: string; actual: string; count: number }>;
};

export function makeAllowance(
  lines: TestAllowanceLine[] = [],
  weeksInMonth = "4.43",
) {
  return {
    lines,
    planned: money(lines.reduce((a, l) => a + n(l.planned), 0)),
    actual: money(lines.reduce((a, l) => a + n(l.actual), 0)),
    weeksInMonth,
  };
}

export function makeBudgetMonth(opts: {
  monthStart?: string;
  lines: TestLine[];
  summary?: TestSummary;
  monthPinned?: boolean;
  allowance?: ReturnType<typeof makeAllowance>;
}) {
  const { lines } = opts;
  const roll = (key: TestLine["planSource"]): Bucket => {
    const rows = lines.filter((l) => l.planSource === key);
    return {
      planned: money(rows.reduce((a, l) => a + n(l.plannedAmount), 0)),
      actual: money(rows.reduce((a, l) => a + n(l.actualAmount), 0)),
      lineCount: rows.length,
    };
  };
  const income = roll("income");
  const bills = roll("bills");
  const debts = roll("debts");
  const unbacked = roll("unbacked");
  const plannedTotal = n(bills.planned) + n(debts.planned);

  // The legacy `groups` array is still on the response; keep it well-formed so
  // nothing downstream trips over it, even though the page no longer reads it.
  const groupNames = Array.from(new Set(lines.map((l) => l.groupName)));
  const groups = groupNames.map((groupName) => {
    const items = lines.filter((l) => l.groupName === groupName);
    return {
      groupName,
      plannedTotal: money(items.reduce((a, l) => a + n(l.plannedAmount), 0)),
      actualTotal: money(items.reduce((a, l) => a + n(l.actualAmount), 0)),
      lines: items,
    };
  });

  const expenses = lines.filter((l) => l.kind !== "income");
  const incomeLines = lines.filter((l) => l.kind === "income");
  const sum = (rows: TestLine[], k: "plannedAmount" | "actualAmount") =>
    money(rows.reduce((a, l) => a + n(l[k]), 0));

  return {
    monthStart: opts.monthStart ?? "2026-05-01",
    note: null,
    monthPinned: opts.monthPinned ?? false,
    lines,
    groups,
    summary:
      opts.summary ?? {
        income: {
          budget: sum(incomeLines, "plannedAmount"),
          actual: sum(incomeLines, "actualAmount"),
        },
        expenses: {
          budget: sum(expenses, "plannedAmount"),
          actual: sum(expenses, "actualAmount"),
        },
        net: { budget: "0.00", actual: "0.00" },
        percentSpent: { budget: "0.0", actual: "0.0" },
      },
    planBySource: {
      income,
      bills,
      debts,
      unbacked,
      plannedTotal: money(plannedTotal),
      actualTotal: money(n(bills.actual) + n(debts.actual)),
      net: money(n(income.planned) - plannedTotal),
    },
    allowance: opts.allowance ?? makeAllowance(),
  };
}
