import { describe, expect, it } from "vitest";
import { actualMonthFlow } from "./billsActual";

// (F6 round 4, finding 6) Bills › "Actual · this month": real transactions only.
// Synthetic rows: a grocery-pickup hold −52.00 (10/02) still pending on 10/15 —
// an expired hold — beside its final, posted under another name at −49.37.
const ROWS = [
  { occurredOn: "2026-10-02", amount: "-52.00", expiredHold: true },
  { occurredOn: "2026-10-03", amount: "-49.37", expiredHold: false },
  { occurredOn: "2026-10-09", amount: "1500.00" },
  { occurredOn: "2026-10-10", amount: "-300.00", isTransfer: true },
  { occurredOn: "2026-09-30", amount: "-10.00" },
];

describe("actualMonthFlow", () => {
  it("an expired hold adds to neither side: spend 49.37 (it read 101.37), net 1,450.63", () => {
    const r = actualMonthFlow(ROWS, "2026-10-01", "2026-11-01");
    expect(r.income).toBe(1500);
    expect(r.spend).toBeCloseTo(49.37, 2);
    expect(r.net).toBeCloseTo(1450.63, 2);
  });
  it("without the server's flag (an older response) the row counts, as before", () => {
    const r = actualMonthFlow(ROWS.map(({ expiredHold: _e, ...t }) => t), "2026-10-01", "2026-11-01");
    expect(r.spend).toBeCloseTo(101.37, 2);
  });
});
