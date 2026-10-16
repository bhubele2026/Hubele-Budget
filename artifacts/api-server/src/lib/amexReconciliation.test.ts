// (Task 5) The partition of the Amex purchases, pure: one group per purchase,
// from the placement and evidence class the summary already read. Every
// amount below is made up.

import { describe, expect, it } from "vitest";
import { AMEX_RECONCILIATION_GROUPS, reconcileAmexPurchases, reconciliationKeyOf, type AmexReconciliationInput } from "./amexReconciliation";

const CARD = { accountId: "card-a", name: "Card A", mask: "1111" };
let n = 0;
const row = (cents: number, placed: AmexReconciliationInput["placed"], extra: Partial<AmexReconciliationInput> = {}): AmexReconciliationInput => ({
  id: `r${++n}`,
  date: "2026-10-12",
  displayName: `Shop ${n}`,
  cents,
  pending: false,
  card: CARD,
  hasCategory: true,
  placed,
  ...extra,
});
const at = (coverage: string, evidenceClass: "known_purchase" | "unresolved" | null = "known_purchase", spend = 1) => ({
  allowance: { coverage, spend, account: CARD.accountId },
  evidenceClass,
});
const totals = (rows: AmexReconciliationInput[], refunds = { cents: 0, count: 0 }) => ({
  purchases: { cents: rows.reduce((a, r) => a + r.cents, 0), count: rows.length },
  refunds,
});
const byKey = (rec: ReturnType<typeof reconcileAmexPurchases>) =>
  Object.fromEntries(rec.groups.map((g) => [g.key, `${g.amount}/${g.count}`]));

describe("(Task 5) reconcileAmexPurchases", () => {
  it("places each coverage in its one group; the evidence class splits the two plans", () => {
    expect(reconciliationKeyOf(at("allowance_weekly"))).toBe("weekly_known");
    expect(reconciliationKeyOf(at("needs_classification"))).toBe("weekly_known");
    expect(reconciliationKeyOf(at("needs_classification", "unresolved"))).toBe("weekly_unresolved");
    expect(reconciliationKeyOf(at("allowance_monthly"))).toBe("monthly_known");
    expect(reconciliationKeyOf(at("allowance_monthly", "unresolved"))).toBe("monthly_unresolved");
    expect(reconciliationKeyOf(at("bill_matched"))).toBe("bills");
    expect(reconciliationKeyOf(at("unplanned"))).toBe("unplanned");
    expect(reconciliationKeyOf(at("reimbursable"))).toBe("reimbursable");
    // An unresolved class outside the two plans changes nothing: the class only splits a plan.
    expect(reconciliationKeyOf(at("unplanned", "unresolved"))).toBe("unplanned");
    for (const c of ["transfer", "excluded", "debt_payment", "card_payment", "income"]) expect(reconciliationKeyOf(at(c, "unresolved"))).toBe("not_counted");
    expect(reconciliationKeyOf(null)).toBe("no_bucket");
  });

  it("Σ groups = purchases to the cent; all nine groups, in order; refunds beside, never inside", () => {
    const rows = [
      row(4800, at("allowance_weekly")),
      row(2250, at("needs_classification")),
      row(3500, at("needs_classification", "unresolved")),
      row(3000, at("allowance_monthly")),
      row(1599, at("bill_matched")),
      row(9000, at("unplanned")),
      row(6400, at("reimbursable")),
      row(2500, at("excluded")),
      row(1234, null),
    ];
    const rec = reconcileAmexPurchases(rows, totals(rows, { cents: 1200, count: 1 }), 10);
    expect(rec.groups.map((g) => g.key)).toEqual(AMEX_RECONCILIATION_GROUPS.map((g) => g.key));
    expect(byKey(rec)).toEqual({
      weekly_known: "70.50/2",
      weekly_unresolved: "35.00/1",
      monthly_known: "30.00/1",
      monthly_unresolved: "0.00/0",
      bills: "15.99/1",
      unplanned: "90.00/1",
      reimbursable: "64.00/1",
      not_counted: "25.00/1",
      no_bucket: "12.34/1",
    });
    expect(rec.purchases).toEqual({ amount: "342.83", count: 9 });
    expect(rec.ties).toBe(true);
    expect(rec.refunds).toEqual({ amount: "12.00", count: 1 });
    expect(rec.net).toBe("330.83");
    expect(rec.unresolved).toEqual({ amount: "35.00", count: 1 });
  });

  it("ties says so when the purchases it is handed are not the ones counted", () => {
    const rows = [row(1000, at("allowance_weekly"))];
    expect(reconcileAmexPurchases(rows, { purchases: { cents: 1001, count: 1 }, refunds: { cents: 0, count: 0 } }, 10).ties).toBe(false);
    expect(reconcileAmexPurchases(rows, { purchases: { cents: 1000, count: 2 }, refunds: { cents: 0, count: 0 } }, 10).ties).toBe(false);
  });

  it("rows: largest first, bounded per group (the amount still covers every row); notes say not filed, no category, pending", () => {
    const rows = [
      row(500, at("needs_classification"), { hasCategory: false, date: "2026-10-13" }),
      row(900, at("allowance_weekly"), { pending: true }),
      row(500, at("allowance_weekly"), { date: "2026-10-11" }),
    ];
    const rec = reconcileAmexPurchases(rows, totals(rows), 2);
    const wk = rec.groups.find((g) => g.key === "weekly_known")!;
    expect([wk.amount, wk.count, wk.truncated]).toEqual(["19.00", 3, true]);
    expect(wk.rows.map((r) => [r.amount, r.date, r.notes])).toEqual([
      ["9.00", "2026-10-12", ["pending"]],
      ["5.00", "2026-10-13", ["not_filed", "no_category"]],
    ]);
    expect(wk.rows[0]!.card).toEqual(CARD);
  });

  it("an empty period: every group $0.00 / 0, still ties", () => {
    const rec = reconcileAmexPurchases([], totals([]), 10);
    expect(rec.groups.every((g) => g.amount === "0.00" && g.count === 0 && g.rows.length === 0)).toBe(true);
    expect([rec.ties, rec.net, rec.unresolved.amount]).toEqual([true, "0.00", "0.00"]);
  });
});
