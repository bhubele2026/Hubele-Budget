import { describe, it, expect } from "vitest";
import {
  computeAmexEndOfMonthBalance,
  makeAmexBalanceAtEndOf,
  type AmexAnchor,
  type AmexTxnInput,
} from "./amexEndingBalance";
import { monthKeyFromISO } from "@/components/account-page";

// (#476) Locks in: for the same anchor + Amex transaction list, the
// (future) dashboard "Amex ending balance" tile and the Amex page's
// header "Ending balance" produce the same number across past,
// current, and future months. Both surfaces call the same shared
// helper, so this test guards against future regressions where one
// page rolls a different number than the other.
describe("amexEndingBalance shared helper", () => {
  // A typical Plaid mid-month sync: anchor on Apr 15 with a $1,000
  // outstanding statement balance.
  const anchor: AmexAnchor = {
    balance: 1000,
    asOf: "2026-04-15",
  };

  // Anchor-month + neighboring-month activity. Charges are positive
  // (they raise the card's outstanding balance), payments/credits are
  // negative.
  const txns: AmexTxnInput[] = [
    { occurredOn: "2026-04-10", amount: "-50.00" }, // before anchor — ignored
    { occurredOn: "2026-04-20", amount: "200.00" }, // after anchor — adds $200
    { occurredOn: "2026-04-25", amount: "-30.00" }, // after anchor — subtracts $30
    { occurredOn: "2026-05-05", amount: "500.00" },
    { occurredOn: "2026-05-12", amount: "-100.00" },
    { occurredOn: "2026-03-20", amount: "-75.00" },
  ];

  it("matches the Amex page's per-month closure across past, current, future months", () => {
    const balanceAtEndOf = makeAmexBalanceAtEndOf({
      anchor,
      amexTransactions: txns,
    });

    for (const monthStart of [
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]) {
      const dashboardTile = computeAmexEndOfMonthBalance({
        monthStart,
        anchor,
        amexTransactions: txns,
      });
      const amexPageHeader = balanceAtEndOf(monthKeyFromISO(monthStart));
      expect(dashboardTile).not.toBeNull();
      expect(dashboardTile).toBeCloseTo(amexPageHeader as number, 2);
    }
  });

  it("reconstructs end-of-April from the mid-month anchor", () => {
    // 1000 (anchor Apr 15) + 200 (Apr 20) - 30 (Apr 25) = 1170. The
    // pre-anchor Apr 10 row is *not* applied — the anchor already
    // reflects it.
    const apr = computeAmexEndOfMonthBalance({
      monthStart: "2026-04-01",
      anchor,
      amexTransactions: txns,
    });
    expect(apr).toBeCloseTo(1170, 2);
  });

  it("rolls forward: end-of-May = end-of-April + May net change", () => {
    // end-April = 1170, May net = 500 - 100 = 400. End-May = 1570.
    const may = computeAmexEndOfMonthBalance({
      monthStart: "2026-05-01",
      anchor,
      amexTransactions: txns,
    });
    expect(may).toBeCloseTo(1570, 2);
  });

  it("rolls backward: end-of-March = end-of-April - full April net change", () => {
    // end-April reconstructed = 1170. April net (whole month) =
    // -50 + 200 - 30 = 120. end-March = 1170 - 120 = 1050.
    const mar = computeAmexEndOfMonthBalance({
      monthStart: "2026-03-01",
      anchor,
      amexTransactions: txns,
    });
    expect(mar).toBeCloseTo(1050, 2);
  });

  it("returns null when there is no anchor", () => {
    expect(
      computeAmexEndOfMonthBalance({
        monthStart: "2026-05-01",
        anchor: null,
        amexTransactions: txns,
      }),
    ).toBeNull();
  });

  it("falls back to the supplied fallback month when the anchor has no asOf", () => {
    // Anchor balance with no timestamp — caller passes the visible
    // month as the fallback. The anchor itself is treated as
    // end-of-fallback-month, so end-of-fallback-month equals the
    // anchor balance and adjacent months roll from there.
    const noAsOf: AmexAnchor = { balance: 800, asOf: null };
    const fallbackMonth = monthKeyFromISO("2026-05-01");
    const may = computeAmexEndOfMonthBalance({
      monthStart: "2026-05-01",
      anchor: noAsOf,
      amexTransactions: txns,
      fallbackMonth,
    });
    expect(may).toBeCloseTo(800, 2);
    // June = 800 + 0 (no June txns) = 800.
    const june = computeAmexEndOfMonthBalance({
      monthStart: "2026-06-01",
      anchor: noAsOf,
      amexTransactions: txns,
      fallbackMonth,
    });
    expect(june).toBeCloseTo(800, 2);
    // With no asOf, the 800 anchor is treated as end-of-fallback-month
    // (May), so April = end-of-May (800) - May net (400) = 400.
    const april = computeAmexEndOfMonthBalance({
      monthStart: "2026-04-01",
      anchor: noAsOf,
      amexTransactions: txns,
      fallbackMonth,
    });
    expect(april).toBeCloseTo(400, 2);
  });

  it("updates when new Amex transactions sync in (no anchor re-entry needed)", () => {
    const before = computeAmexEndOfMonthBalance({
      monthStart: "2026-05-01",
      anchor,
      amexTransactions: txns,
    });
    const after = computeAmexEndOfMonthBalance({
      monthStart: "2026-05-01",
      anchor,
      amexTransactions: [
        ...txns,
        { occurredOn: "2026-05-28", amount: "250.00" },
      ],
    });
    expect(after).toBeCloseTo((before as number) + 250, 2);
  });
});
