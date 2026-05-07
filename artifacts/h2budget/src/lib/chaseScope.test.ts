import { describe, it, expect } from "vitest";
import {
  CHASE_FALLBACK_SOURCES,
  chaseMonthTotals,
  dedupeTransactionsByIdentity,
  isChaseFallbackSource,
} from "./chaseScope";
import { computeBalanceAtEndOf } from "./accountBalance";
import { monthKeyFromISO, shiftMonth } from "@/components/account-page";

type Row = {
  id: string;
  plaidTransactionId?: string | null;
  occurredOn: string;
  amount: string | number;
};

describe("dedupeTransactionsByIdentity", () => {
  it("collapses rows that share a plaidTransactionId", () => {
    const rows: Row[] = [
      { id: "row-a", plaidTransactionId: "ptx-1", occurredOn: "2026-05-03", amount: "-12.34" },
      { id: "row-b", plaidTransactionId: "ptx-1", occurredOn: "2026-05-03", amount: "-12.34" },
      { id: "row-c", plaidTransactionId: "ptx-2", occurredOn: "2026-05-04", amount: "100.00" },
    ];
    const out = dedupeTransactionsByIdentity(rows);
    expect(out.map((r) => r.id)).toEqual(["row-a", "row-c"]);
  });

  it("treats a missing plaidTransactionId as the row id (manual rows survive)", () => {
    const rows: Row[] = [
      { id: "manual-1", plaidTransactionId: null, occurredOn: "2026-05-01", amount: "-5" },
      { id: "manual-2", plaidTransactionId: null, occurredOn: "2026-05-01", amount: "-5" },
    ];
    expect(dedupeTransactionsByIdentity(rows)).toHaveLength(2);
  });
});

describe("chaseMonthTotals", () => {
  it("counts only rows whose occurredOn is inside the selected month", () => {
    const rows: Row[] = [
      { id: "april-late", occurredOn: "2026-04-30", amount: 9999 }, // ignored
      { id: "may-1", occurredOn: "2026-05-01", amount: 100 },
      { id: "may-2", occurredOn: "2026-05-15", amount: -40 },
      { id: "may-3", occurredOn: "2026-05-31", amount: -10 },
      { id: "june-1", occurredOn: "2026-06-01", amount: 9999 }, // ignored
    ];
    const totals = chaseMonthTotals(rows, monthKeyFromISO("2026-05-15"));
    expect(totals.moneyIn).toBeCloseTo(100, 2);
    expect(totals.moneyOut).toBeCloseTo(50, 2);
    expect(totals.netChange).toBeCloseTo(50, 2);
  });

  it("handles string amounts the same as numbers", () => {
    const rows: Row[] = [
      { id: "x", occurredOn: "2026-05-02", amount: "200.50" },
      { id: "y", occurredOn: "2026-05-02", amount: "-50.25" },
    ];
    const totals = chaseMonthTotals(rows, monthKeyFromISO("2026-05-15"));
    expect(totals.moneyIn).toBeCloseTo(200.5, 2);
    expect(totals.moneyOut).toBeCloseTo(50.25, 2);
    expect(totals.netChange).toBeCloseTo(150.25, 2);
  });
});

describe("isChaseFallbackSource (#448)", () => {
  it("includes Chase + manual sources", () => {
    for (const s of CHASE_FALLBACK_SOURCES) {
      expect(isChaseFallbackSource(s)).toBe(true);
    }
  });

  it("excludes Amex sources so debt rows don't leak into the Chase page", () => {
    expect(isChaseFallbackSource("amex")).toBe(false);
    expect(isChaseFallbackSource("plaid:amex")).toBe(false);
  });

  it("excludes other Plaid institutions", () => {
    expect(isChaseFallbackSource("plaid:capitalone")).toBe(false);
    expect(isChaseFallbackSource("plaid:bank")).toBe(false);
  });

  it("treats null/empty source as a manual row (legacy entries survive)", () => {
    expect(isChaseFallbackSource(null)).toBe(true);
    expect(isChaseFallbackSource(undefined)).toBe(true);
    expect(isChaseFallbackSource("")).toBe(true);
  });

  it("filters a mixed-source list down to Chase + manual rows in the no-Plaid fallback", () => {
    type SourcedRow = {
      id: string;
      source: string | null;
      plaidAccountId: string | null;
    };
    const all: SourcedRow[] = [
      { id: "manual-1", source: "manual", plaidAccountId: null },
      { id: "chase-plaid", source: "plaid:chase", plaidAccountId: null },
      { id: "amex-manual", source: "amex", plaidAccountId: null },
      { id: "amex-plaid", source: "plaid:amex", plaidAccountId: null },
      { id: "other-debt", source: "plaid:capitalone", plaidAccountId: null },
      // Rows with a plaidAccountId set are scoped by id, not source —
      // they should not be considered by the fallback predicate.
      { id: "linked-chase", source: "plaid:chase", plaidAccountId: "acct-1" },
    ];
    const fallback = all.filter(
      (t) => !t.plaidAccountId && isChaseFallbackSource(t.source),
    );
    expect(fallback.map((r) => r.id)).toEqual(["manual-1", "chase-plaid"]);
  });
});

describe("Chase summary bubbles for May 2026 (#443)", () => {
  // The end-of-April balance is the snapshot anchor (Task #137).
  const aprilEndingBalance = 3565.09;
  const aprilSnapshotAt = "2026-04-30T23:59:59Z";
  const aprilMonth = monthKeyFromISO(aprilSnapshotAt);
  const mayMonth = shiftMonth(aprilMonth, 1);

  // Fixture mimics the production-style leak: clean May activity, plus
  //   - a duplicate Plaid row (same plaid_transaction_id) that previously
  //     double-counted in Money in / Money out, and
  //   - a cross-month row whose occurredOn is in April. Both must NOT
  //     leak into May's totals.
  const fixture: Array<Row & { plaidTransactionId?: string | null }> = [
    // April rows (irrelevant to May totals; should be excluded by month
    // scoping). They live inside the same chaseTransactions list because
    // the page loads the full history.
    { id: "apr-1", plaidTransactionId: "apr-ptx-1", occurredOn: "2026-04-29", amount: -123.45 },
    // May activity
    { id: "may-payroll", plaidTransactionId: "may-ptx-payroll", occurredOn: "2026-05-01", amount: 4036.29 },
    { id: "may-rent", plaidTransactionId: "may-ptx-rent", occurredOn: "2026-05-02", amount: -1989.81 },
    { id: "may-amex", plaidTransactionId: "may-ptx-amex", occurredOn: "2026-05-05", amount: -2186.96 },
    { id: "may-coffee", plaidTransactionId: "may-ptx-coffee", occurredOn: "2026-05-10", amount: -7.5 },
    { id: "may-bonus", plaidTransactionId: "may-ptx-bonus", occurredOn: "2026-05-15", amount: 250.0 },
    // Duplicate of `may-payroll` (same plaidTransactionId) — pre-fix this
    // row was double-counted in Money in and broke Starting balance.
    { id: "may-payroll-dup", plaidTransactionId: "may-ptx-payroll", occurredOn: "2026-05-01", amount: 4036.29 },
  ];

  // Expected May-only totals after dedupe:
  //   in:  4036.29 + 250.00              = 4286.29
  //   out: 1989.81 + 2186.96 + 7.50      = 4184.27
  //   net: 4286.29 - 4184.27             = 102.02
  const expectedMoneyIn = 4286.29;
  const expectedMoneyOut = 4184.27;
  const expectedNetChange = expectedMoneyIn - expectedMoneyOut;

  it("dedupes duplicates and excludes cross-month rows in the bubble math", () => {
    const deduped = dedupeTransactionsByIdentity(fixture);
    const totals = chaseMonthTotals(deduped, mayMonth);
    expect(totals.moneyIn).toBeCloseTo(expectedMoneyIn, 2);
    expect(totals.moneyOut).toBeCloseTo(expectedMoneyOut, 2);
    expect(totals.netChange).toBeCloseTo(expectedNetChange, 2);
  });

  it("Starting balance falls out as the known $3,565.09 from the snapshot anchor", () => {
    const deduped = dedupeTransactionsByIdentity(fixture);

    // Build netChangeByMonth the same way the page does, off the deduped
    // list — this is the input that feeds computeBalanceAtEndOf.
    const netChangeByMonth = new Map<string, number>();
    for (const t of deduped) {
      const mk = monthKeyFromISO(t.occurredOn);
      const k = `${mk.year}-${mk.month}`;
      netChangeByMonth.set(
        k,
        (netChangeByMonth.get(k) ?? 0) + (Number(t.amount) || 0),
      );
    }
    const anchorMonthTxns = deduped.filter(
      (t) => monthKeyFromISO(t.occurredOn).month === aprilMonth.month &&
        monthKeyFromISO(t.occurredOn).year === aprilMonth.year,
    );

    // End-of-April == anchor balance (snapshot taken at end of day April 30,
    // so all April activity is already reflected in the snapshot).
    const endOfApril = computeBalanceAtEndOf({
      anchorBalance: aprilEndingBalance,
      anchorMonth: aprilMonth,
      netChangeByMonth,
      target: aprilMonth,
      anchorAt: aprilSnapshotAt,
      anchorMonthTxns,
    });
    expect(endOfApril).toBeCloseTo(3565.09, 2);

    // May ending = April ending + May net change.
    const endOfMay = computeBalanceAtEndOf({
      anchorBalance: aprilEndingBalance,
      anchorMonth: aprilMonth,
      netChangeByMonth,
      target: mayMonth,
      anchorAt: aprilSnapshotAt,
      anchorMonthTxns,
    });
    expect(endOfMay).toBeCloseTo(3565.09 + expectedNetChange, 2);

    // Starting balance for May == end-of-April == 3565.09. This is the
    // exact regression #443 was about: pre-dedupe the duplicate
    // `may-payroll-dup` row inflated netChange(May) by +4036.29, which
    // then made Starting (= Ending − netChange(May)) wildly off.
    const mayStarting = computeBalanceAtEndOf({
      anchorBalance: aprilEndingBalance,
      anchorMonth: aprilMonth,
      netChangeByMonth,
      target: aprilMonth, // end of (May - 1) == end of April
      anchorAt: aprilSnapshotAt,
      anchorMonthTxns,
    });
    expect(mayStarting).toBeCloseTo(3565.09, 2);

    // And the bubble identity holds: Net change == Ending − Starting.
    const totals = chaseMonthTotals(deduped, mayMonth);
    expect(totals.netChange).toBeCloseTo(endOfMay - mayStarting, 2);
  });
});
