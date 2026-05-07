import { describe, it, expect } from "vitest";
import {
  computeChaseEndOfMonthBalance,
  makeChaseBalanceAtEndOf,
  scopeChaseTransactions,
  type ChaseTxnInput,
} from "./chaseEndingBalance";
import type { EffectiveSnapshotEntry } from "./effectiveSnapshot";
import { monthKeyFromISO } from "@/components/account-page";

// (#475) Locks in: for the same effective snapshot + Chase transaction
// list, the dashboard's "Chase ending balance" tile and the Chase
// page's header "Ending balance" produce the same number across past,
// current, and future months. Both surfaces call the same shared
// helper, so this test guards against future regressions where one
// page rolls a different number than the other.
describe("chaseEndingBalance shared helper", () => {
  // A typical Plaid mid-month sync: anchor on Apr 15 with $1,000.
  const effectiveSnapshot: EffectiveSnapshotEntry = {
    balance: "1000.00",
    at: "2026-04-15",
    source: "plaid",
    name: "Chase Total Checking",
    mask: "1234",
  };

  // Anchor-month + neighboring-month activity scoped to the Plaid
  // checking account. Includes pre-anchor April rows (already
  // reflected in the snapshot — must be ignored), post-anchor April
  // rows (which roll the snapshot up to end-of-April), May activity
  // for forward roll, and March activity for backward roll.
  const txns: ChaseTxnInput[] = [
    {
      id: "t1",
      occurredOn: "2026-04-10", // before anchor — ignored
      amount: "-50.00",
      plaidAccountId: "chase-acct",
    },
    {
      id: "t2",
      occurredOn: "2026-04-20", // after anchor — adds $200
      amount: "200.00",
      plaidAccountId: "chase-acct",
    },
    {
      id: "t3",
      occurredOn: "2026-04-25", // after anchor — subtracts $30
      amount: "-30.00",
      plaidAccountId: "chase-acct",
    },
    {
      id: "t4",
      occurredOn: "2026-05-05",
      amount: "500.00",
      plaidAccountId: "chase-acct",
    },
    {
      id: "t5",
      occurredOn: "2026-05-12",
      amount: "-100.00",
      plaidAccountId: "chase-acct",
    },
    {
      id: "t6",
      occurredOn: "2026-03-20",
      amount: "-75.00",
      plaidAccountId: "chase-acct",
    },
  ];

  it("matches the Chase page's per-month closure across past, current, future months", () => {
    const balanceAtEndOf = makeChaseBalanceAtEndOf({
      effectiveSnapshot,
      chaseTransactions: txns,
    });

    for (const monthStart of ["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]) {
      const dashboardTile = computeChaseEndOfMonthBalance({
        monthStart,
        effectiveSnapshot,
        chaseTransactions: txns,
      });
      const chasePageHeader = balanceAtEndOf(monthKeyFromISO(monthStart));
      expect(dashboardTile).not.toBeNull();
      expect(dashboardTile).toBeCloseTo(chasePageHeader as number, 2);
    }
  });

  it("reconstructs end-of-April from the mid-month Plaid snapshot", () => {
    // 1000 (snapshot Apr 15) + 200 (Apr 20) - 30 (Apr 25) = 1170.
    // The pre-anchor Apr 10 row is *not* applied — the snapshot
    // already reflects it.
    const apr = computeChaseEndOfMonthBalance({
      monthStart: "2026-04-01",
      effectiveSnapshot,
      chaseTransactions: txns,
    });
    expect(apr).toBeCloseTo(1170, 2);
  });

  it("rolls forward: end-of-May = end-of-April + May net change", () => {
    // end-April = 1170, May net = 500 - 100 = 400. End-May = 1570.
    const may = computeChaseEndOfMonthBalance({
      monthStart: "2026-05-01",
      effectiveSnapshot,
      chaseTransactions: txns,
    });
    expect(may).toBeCloseTo(1570, 2);
  });

  it("rolls backward: end-of-March = end-of-April - full April net change", () => {
    // end-April reconstructed = 1170. April net (whole month) =
    // -50 + 200 - 30 = 120. end-March = 1170 - 120 = 1050. The
    // pre-anchor April row participates here because it lands in
    // the past: end-of-March must reflect "before the Apr 10 row".
    const mar = computeChaseEndOfMonthBalance({
      monthStart: "2026-03-01",
      effectiveSnapshot,
      chaseTransactions: txns,
    });
    expect(mar).toBeCloseTo(1050, 2);
  });

  it("returns null when there is no effective snapshot", () => {
    expect(
      computeChaseEndOfMonthBalance({
        monthStart: "2026-05-01",
        effectiveSnapshot: null,
        chaseTransactions: txns,
      }),
    ).toBeNull();
  });

  it("updates when new Chase transactions sync in (no snapshot re-entry needed)", () => {
    // Simulate a freshly synced May transaction landing after the
    // dashboard already rendered. The tile must reflect it without
    // the user touching the snapshot.
    const before = computeChaseEndOfMonthBalance({
      monthStart: "2026-05-01",
      effectiveSnapshot,
      chaseTransactions: txns,
    });
    const after = computeChaseEndOfMonthBalance({
      monthStart: "2026-05-01",
      effectiveSnapshot,
      chaseTransactions: [
        ...txns,
        {
          id: "t7",
          occurredOn: "2026-05-28",
          amount: "-250.00",
          plaidAccountId: "chase-acct",
        },
      ],
    });
    expect(after).toBeCloseTo((before as number) - 250, 2);
  });
});

describe("scopeChaseTransactions", () => {
  it("filters by plaid account id when one is provided, then dedupes", () => {
    const txns: ChaseTxnInput[] = [
      { id: "a", occurredOn: "2026-05-01", amount: "10", plaidAccountId: "chase" },
      { id: "b", occurredOn: "2026-05-02", amount: "20", plaidAccountId: "amex" },
      // Duplicate of `a` by plaidTransactionId — must be deduped.
      {
        id: "a-dup",
        occurredOn: "2026-05-01",
        amount: "10",
        plaidAccountId: "chase",
        plaidTransactionId: "ptx-1",
      },
      {
        id: "a-orig",
        occurredOn: "2026-05-01",
        amount: "10",
        plaidAccountId: "chase",
        plaidTransactionId: "ptx-1",
      },
    ];
    const out = scopeChaseTransactions(txns, "chase");
    expect(out.map((t) => t.id)).toEqual(["a", "a-dup"]);
  });

  it("falls back to chase + manual sources when no plaid checking is linked", () => {
    const txns: ChaseTxnInput[] = [
      { id: "m", occurredOn: "2026-05-01", amount: "5", source: "manual" },
      { id: "c", occurredOn: "2026-05-01", amount: "5", source: "plaid:chase" },
      // Amex/debt rows must NOT be swept into the Chase fallback.
      { id: "x", occurredOn: "2026-05-01", amount: "5", source: "amex" },
      { id: "y", occurredOn: "2026-05-01", amount: "5", source: "plaid:amex" },
    ];
    const out = scopeChaseTransactions(txns, null);
    expect(out.map((t) => t.id).sort()).toEqual(["c", "m"]);
  });
});
