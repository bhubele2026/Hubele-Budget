import { describe, it, expect } from "vitest";
import {
  buildLineRegister,
  type Resolution,
  type Transaction,
} from "./forecastMatch";
import type { CashEvent } from "./forecast";

function ev(itemId: string, date: string, amount: number, label = "rent"): CashEvent {
  return { itemId, date, amount, label } as CashEvent;
}

function bankTxn(id: string, date: string, amount: string): Transaction {
  return {
    id,
    occurredOn: date,
    description: `tx-${id}`,
    amount,
    forecastFlag: true,
    plaidAccountId: "chase-acct",
  };
}

const baseOpts = {
  resolutions: [] as Resolution[],
  closedMonths: new Set<string>(),
  startBalance: 1000,
  fromISO: "2026-04-01",
  toISO: "2026-06-30",
  today: new Date("2026-05-15"),
};

describe("buildLineRegister visibleFromISO window", () => {
  it("with lingerPastDuePlans, hides prior-month BANK rows but keeps past-due pending PLAN rows in `rows` (and all in allPlan/allBank)", () => {
    const events = [
      ev("rec-old", "2026-04-20", -100, "old bill"),
      ev("rec-new", "2026-05-20", -200, "new bill"),
    ];
    const txns = [
      bankTxn("tx-old", "2026-04-25", "-50.00"),
      bankTxn("tx-new", "2026-05-18", "-75.00"),
    ];

    const { rows, allPlan, allBank } = buildLineRegister({
      ...baseOpts,
      events,
      txns,
      visibleFromISO: "2026-05-01",
      lingerPastDuePlans: true,
    });

    // Visible rows exclude prior-month BANK rows; past-due pending
    // PLAN rows always stay visible (#751) so the 2026-04-20 plan
    // row survives even though it sits before visibleFromISO.
    const rowDates = rows.map((r) => r.date).sort();
    expect(rowDates).toEqual(["2026-04-20", "2026-05-18", "2026-05-20"]);
    expect(rows.some((r) => r.date === "2026-04-20" && r.kind === "plan")).toBe(
      true,
    );
    expect(rows.some((r) => r.date === "2026-04-25")).toBe(false);

    // The wider window still has the prior-month rows so the
    // bucket / month-close / rescheduled flows can find them.
    expect(allPlan.map((p) => p.date).sort()).toEqual([
      "2026-04-20",
      "2026-05-20",
    ]);
    expect(allBank.map((b) => b.date).sort()).toEqual([
      "2026-04-25",
      "2026-05-18",
    ]);
  });

  it("without visibleFromISO, behavior matches the existing fromISO/toISO semantics (prior-month rows stay visible)", () => {
    const events = [
      ev("rec-old", "2026-04-20", -100, "old bill"),
      ev("rec-new", "2026-05-20", -200, "new bill"),
    ];
    const txns = [
      bankTxn("tx-old", "2026-04-25", "-50.00"),
      bankTxn("tx-new", "2026-05-18", "-75.00"),
    ];

    const { rows } = buildLineRegister({
      ...baseOpts,
      events,
      txns,
    });

    const rowDates = rows.map((r) => r.date).sort();
    expect(rowDates).toEqual([
      "2026-04-20",
      "2026-04-25",
      "2026-05-18",
      "2026-05-20",
    ]);
  });

  it("running balance for visible bank rows reflects prior-window bank rows already moving the balance", () => {
    // Prior month: -50 and -25 already hit the account → balance went 1000 → 925.
    // Visible rows in May should continue from 925, not reset to 1000.
    const txns = [
      bankTxn("tx-apr-1", "2026-04-10", "-50.00"),
      bankTxn("tx-apr-2", "2026-04-20", "-25.00"),
      bankTxn("tx-may-1", "2026-05-05", "-100.00"),
      bankTxn("tx-may-2", "2026-05-12", "-200.00"),
    ];

    const { rows, allBank } = buildLineRegister({
      ...baseOpts,
      events: [],
      txns,
      visibleFromISO: "2026-05-01",
    });

    // Sanity: only May rows are surfaced.
    const bankRows = rows.filter((r) => r.kind === "bank");
    expect(bankRows.map((b) => b.date)).toEqual(["2026-05-05", "2026-05-12"]);

    // Running balance carries forward from the April activity:
    //   1000 - 50 - 25 = 925 (April, hidden)
    //   925 - 100 = 825 (first visible row)
    //   825 - 200 = 625 (second visible row)
    expect(bankRows[0].runningBalance).toBe(825);
    expect(bankRows[1].runningBalance).toBe(625);

    // allBank still contains the prior-month rows.
    expect(allBank).toHaveLength(4);
  });

  it("with visibleFromISO equal to today, bank rows dated before today are excluded but past-due pending plans stay visible (#751)", () => {
    const events = [
      ev("rec-yesterday", "2026-05-14", -10, "yesterday bill"),
      ev("rec-today", "2026-05-15", -20, "today bill"),
      ev("rec-tomorrow", "2026-05-16", -30, "tomorrow bill"),
    ];
    const txns = [
      bankTxn("tx-yesterday", "2026-05-14", "-5.00"),
      bankTxn("tx-today", "2026-05-15", "-7.00"),
    ];
    const { rows } = buildLineRegister({
      ...baseOpts,
      events,
      txns,
      visibleFromISO: "2026-05-15",
      lingerPastDuePlans: true,
    });
    const dates = rows.map((r) => r.date).sort();
    // Bank row dated 2026-05-14 is hidden by visibleFromISO; the
    // 2026-05-14 PLAN row stays visible because it's a past-due
    // pending plan (the user still needs to resolve it).
    expect(dates).toEqual([
      "2026-05-14",
      "2026-05-15",
      "2026-05-15",
      "2026-05-16",
    ]);
    // The hidden one is the bank txn, not the plan.
    expect(rows.some((r) => r.date === "2026-05-14" && r.kind === "bank")).toBe(
      false,
    );
    expect(rows.some((r) => r.date === "2026-05-14" && r.kind === "plan")).toBe(
      true,
    );
  });

  it("past-due pending plans always show up in `rows` regardless of visibleFromISO; matched plans do not (#751)", () => {
    const events = [
      ev("rec-past-pending", "2026-05-15", -100, "past unmatched"),
      ev("rec-past-matched", "2026-05-15", -200, "past matched"),
      ev("rec-future", "2026-06-15", -300, "future"),
    ];
    const resolutions: Resolution[] = [
      {
        id: "res-1",
        recurringItemId: "rec-past-matched",
        occurrenceDate: "2026-05-15",
        status: "matched",
        matchedTxnId: "tx-match",
      } as Resolution,
    ];
    const { rows } = buildLineRegister({
      ...baseOpts,
      events,
      txns: [],
      resolutions,
      today: new Date("2026-05-27"),
      visibleFromISO: "2026-05-27",
      lingerPastDuePlans: true,
    });
    const planRows = rows.filter((r) => r.kind === "plan");
    const labels = planRows.map((r) => (r as { label: string }).label).sort();
    // Past unmatched stays; future stays; matched does not.
    expect(labels).toEqual(["future", "past unmatched"]);
  });

  it("WITHOUT lingerPastDuePlans (default /forecast view), a past-due pending plan is hidden once today passes its date", () => {
    // This is the #803 forward-looking default: the overall Forecast
    // register drops pre-today plans. The Review page opts back in via
    // lingerPastDuePlans (covered by the cases above).
    const events = [
      ev("rec-past-pending", "2026-05-10", -100, "past unmatched"),
      ev("rec-future", "2026-05-20", -300, "future"),
    ];
    const { rows } = buildLineRegister({
      ...baseOpts,
      events,
      txns: [],
      visibleFromISO: "2026-05-15", // today
    });
    const planDates = rows
      .filter((r) => r.kind === "plan")
      .map((r) => r.date)
      .sort();
    // Past-due 2026-05-10 dropped; only the future plan remains.
    expect(planDates).toEqual(["2026-05-20"]);
  });

  it("clamps visibleFromISO to fromISO when it is earlier than the window start", () => {
    const events = [ev("rec-1", "2026-04-15", -10, "early")];
    const { rows } = buildLineRegister({
      ...baseOpts,
      events,
      txns: [],
      visibleFromISO: "2026-01-01",
    });
    // Clamped to fromISO=2026-04-01, so the April row is still visible.
    expect(rows.map((r) => r.date)).toEqual(["2026-04-15"]);
  });
});
