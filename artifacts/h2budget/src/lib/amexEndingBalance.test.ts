import { describe, it, expect } from "vitest";
import {
  computeAmexEndOfMonthBalance,
  makeAmexBalanceAtEndOf,
  resolveAmexAnchor,
  resolveAmexDebt,
  type AmexAnchor,
  type AmexDebtLike,
  type AmexTxnInput,
} from "./amexEndingBalance";
import { monthKeyFromISO } from "@/components/account-page";
import { openingCardBalance, walkCardBalancesBack, walkCardBalancesForward } from "./cardBalanceWalk";

// (#689) The user's dashboard tile reported "$20,000 Amex Ending
// Balance" — actually their Amex Pay-Over-Time / "Plan-It"
// installment LOAN balance, synced into the debts table with the
// name "Amex …" and `type='loan'`. The credit-card resolver must
// exclude loan-type debts so this tile shows the revolving credit
// card balance only.
describe("(#689) resolveAmexDebt excludes Amex installment LOAN debts", () => {
  it("ignores a loan-type Amex debt and returns the credit-card one instead", () => {
    const debts: AmexDebtLike[] = [
      {
        name: "Amex Pay Over Time",
        balance: "20000.00",
        plaidAccountId: null,
        lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
        plaidLastSyncedAt: null,
        type: "loan",
      },
      {
        name: "Amex Platinum",
        balance: "742.18",
        plaidAccountId: null,
        lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
        plaidLastSyncedAt: null,
        type: "credit",
      },
    ];
    const got = resolveAmexDebt({
      debts,
      amexPlaidAccountIds: new Set<string>(),
      plaidItemsForScope: [],
    });
    expect(got).not.toBeNull();
    expect(got!.name).toBe("Amex Platinum");
    expect(got!.balance).toBe("742.18");
  });

  it("returns null when the only Amex-named debt is a loan", () => {
    const debts: AmexDebtLike[] = [
      {
        name: "Amex Plan-It Loan",
        balance: "20000.00",
        plaidAccountId: null,
        lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
        plaidLastSyncedAt: null,
        type: "loan",
      },
    ];
    const got = resolveAmexDebt({
      debts,
      amexPlaidAccountIds: new Set<string>(),
      plaidItemsForScope: [],
    });
    expect(got).toBeNull();
  });

  it("excludes loan-type even when the debt is Plaid-linked to an amex-tagged account", () => {
    // Loan sub-account on the same Amex login had transactions tagged
    // source='plaid:amex', so its accountId is in amexPlaidAccountIds.
    // Pre-fix, the Plaid-link path would still pick it up.
    const debts: AmexDebtLike[] = [
      {
        name: "Amex Pay Over Time",
        balance: "20000.00",
        plaidAccountId: "plaid-acct-loan",
        lastBalanceUpdate: null,
        plaidLastSyncedAt: "2026-05-15T00:00:00.000Z",
        type: "loan",
      },
      {
        name: "Amex Platinum",
        balance: "742.18",
        plaidAccountId: "plaid-acct-card",
        lastBalanceUpdate: null,
        plaidLastSyncedAt: "2026-05-15T00:00:00.000Z",
        type: "credit",
      },
    ];
    const got = resolveAmexDebt({
      debts,
      amexPlaidAccountIds: new Set(["plaid-acct-loan", "plaid-acct-card"]),
      plaidItemsForScope: [],
    });
    expect(got).not.toBeNull();
    expect(got!.name).toBe("Amex Platinum");
    expect(got!.balance).toBe("742.18");
  });

  it("(round 3) excludes a manually entered 'Amex Loan' even when `type` is empty", () => {
    // Real production row that defeated round 2 of this fix:
    //   {name: "Amex Loan", balance: 20000.00, type: ""}
    // No Plaid link, no `type`, so the type-based filter was no help —
    // the name regex `/amex/i` matched and fed $20,000 into the
    // dashboard Amex Ending Balance tile.
    const debts: AmexDebtLike[] = [
      {
        name: "Amex Loan",
        balance: "20000.00",
        plaidAccountId: null,
        lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
        plaidLastSyncedAt: null,
        type: "",
      },
    ];
    const got = resolveAmexDebt({
      debts,
      amexPlaidAccountIds: new Set<string>(),
      plaidItemsForScope: [],
    });
    expect(got).toBeNull();
  });

  it("(round 3) excludes installment-name variants with empty/null type", () => {
    for (const name of [
      "Amex Pay Over Time",
      "Amex Plan-It",
      "Amex Plan It",
      "Amex Installment Loan",
      "American Express Installment",
    ]) {
      const debts: AmexDebtLike[] = [
        {
          name,
          balance: "5000.00",
          plaidAccountId: null,
          lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
          plaidLastSyncedAt: null,
          // No `type` — manual entry.
        },
      ];
      const got = resolveAmexDebt({
        debts,
        amexPlaidAccountIds: new Set<string>(),
        plaidItemsForScope: [],
      });
      expect(got, `expected null for name="${name}"`).toBeNull();
    }
  });

  it("(round 3) still resolves legitimate Amex credit-card names", () => {
    for (const name of [
      "Amex",
      "Amex Platinum",
      "Amex Gold",
      "Amex Blue Cash",
      "Amex Blue Cash Everyday",
      "American Express Gold",
      "American Express Platinum",
    ]) {
      const debts: AmexDebtLike[] = [
        {
          name,
          balance: "742.18",
          plaidAccountId: null,
          lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
          plaidLastSyncedAt: null,
        },
      ];
      const got = resolveAmexDebt({
        debts,
        amexPlaidAccountIds: new Set<string>(),
        plaidItemsForScope: [],
      });
      expect(got, `expected match for name="${name}"`).not.toBeNull();
      expect(got!.balance).toBe("742.18");
    }
  });

  it("(round 3) returns the credit card from a mixed list (one loan + one card, both manual)", () => {
    const debts: AmexDebtLike[] = [
      {
        name: "Amex Loan",
        balance: "20000.00",
        plaidAccountId: null,
        lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
        plaidLastSyncedAt: null,
        type: "",
      },
      {
        name: "Amex Platinum",
        balance: "742.18",
        plaidAccountId: null,
        lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
        plaidLastSyncedAt: null,
        // No type — also a manual entry, just not a loan.
      },
    ];
    const got = resolveAmexDebt({
      debts,
      amexPlaidAccountIds: new Set<string>(),
      plaidItemsForScope: [],
    });
    expect(got).not.toBeNull();
    expect(got!.name).toBe("Amex Platinum");
    expect(got!.balance).toBe("742.18");
  });

  it("treats unknown/missing `type` as a credit card (legacy / manual debts still resolve)", () => {
    const debts: AmexDebtLike[] = [
      {
        name: "Amex",
        balance: "500.00",
        plaidAccountId: null,
        lastBalanceUpdate: "2026-05-15T00:00:00.000Z",
        plaidLastSyncedAt: null,
        // No type — manual debt from before Plaid was linked.
      },
    ];
    const got = resolveAmexDebt({
      debts,
      amexPlaidAccountIds: new Set<string>(),
      plaidItemsForScope: [],
    });
    expect(got).not.toBeNull();
    expect(got!.balance).toBe("500.00");
  });
});

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

  // Anchor-month + neighboring-month activity. Workbook rows (`source:
  // "amex"`): charges are positive (they raise the card's outstanding
  // balance), payments/credits are negative. (Q3) The same activity from
  // Plaid carries the opposite sign — see the Plaid block below.
  const txns: AmexTxnInput[] = [
    { occurredOn: "2026-04-10", amount: "-50.00", source: "amex" }, // before anchor — ignored
    { occurredOn: "2026-04-20", amount: "200.00", source: "amex" }, // after anchor — adds $200
    { occurredOn: "2026-04-25", amount: "-30.00", source: "amex" }, // after anchor — subtracts $30
    { occurredOn: "2026-05-05", amount: "500.00", source: "amex" },
    { occurredOn: "2026-05-12", amount: "-100.00", source: "amex" },
    { occurredOn: "2026-03-20", amount: "-75.00", source: "amex" },
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
        { occurredOn: "2026-05-28", amount: "250.00", source: "amex" },
      ],
    });
    expect(after).toBeCloseTo((before as number) + 250, 2);
  });
});

// (PR2b) `/api/amex/anchor` source "computed" is the running sum of every Amex
// row, dated by the latest row's day. That day's rows are already inside the
// balance, so its month must end at the sum. The server sends the day as a bare
// YYYY-MM-DD, which the household calendar reads unchanged.
describe("(PR2b) a computed Amex anchor counts its latest day once", () => {
  const txns: AmexTxnInput[] = [
    { occurredOn: "2026-09-02", amount: "30.00", source: "amex" },
    { occurredOn: "2026-09-10", amount: "50.00", source: "amex" },
  ];

  it("resolves the server's bare-day asOf to an ending balance equal to the sum", () => {
    const anchor = resolveAmexAnchor({
      amexDebt: null,
      amexAnchorResp: {
        amexEndingBalance: 80,
        asOf: "2026-09-10",
        source: "computed",
      },
    });
    expect(anchor).toEqual({ balance: 80, asOf: "2026-09-10" });
    const balanceAtEndOf = makeAmexBalanceAtEndOf({
      anchor,
      amexTransactions: txns,
    });
    expect(balanceAtEndOf(monthKeyFromISO("2026-09-01"))).toBeCloseTo(80, 2);
  });

  it("reads a UTC-midnight instant as the evening before, so that day's rows count after it", () => {
    // 2026-09-10T00:00Z is 7pm on Sep 9 in Chicago. Right for a real 7pm
    // snapshot; $50 too high for a sum that already runs through Sep 10, which
    // is why the computed source must not send its day in this shape.
    const balanceAtEndOf = makeAmexBalanceAtEndOf({
      anchor: { balance: 80, asOf: "2026-09-10T00:00:00.000Z" },
      amexTransactions: txns,
    });
    expect(balanceAtEndOf(monthKeyFromISO("2026-09-01"))).toBeCloseTo(130, 2);
  });
});

// ⭐ (Q3) The same card activity from PLAID carries the bank sign: a purchase is
// stored NEGATIVE, a payment or a credit POSITIVE. The month walk reads each
// row's change to what is OWED (`cardOwedMoves`), so the Plaid rows give the
// very figures the workbook rows above give. Before Q3 the helper summed the
// raw amounts: the Plaid month-ends moved the wrong way.
describe("(Q3) Plaid card rows walk the same as workbook rows", () => {
  const anchor: AmexAnchor = { balance: 1000, asOf: "2026-04-15" };
  const plaid: AmexTxnInput[] = [
    { occurredOn: "2026-04-10", amount: "50.00", source: "plaid:amex" }, //   credit   −50
    { occurredOn: "2026-04-20", amount: "-200.00", source: "plaid:amex" }, // purchase +200
    { occurredOn: "2026-04-25", amount: "30.00", source: "plaid:amex" }, //   payment  −30
    { occurredOn: "2026-05-05", amount: "-500.00", source: "plaid:amex" }, // purchase +500
    { occurredOn: "2026-05-12", amount: "100.00", source: "plaid:amex" }, //  payment  −100
    { occurredOn: "2026-03-20", amount: "75.00", source: "plaid:amex" }, //   refund   −75
  ];
  const at = makeAmexBalanceAtEndOf({ anchor, amexTransactions: plaid });

  it("end of April = 1000 + 200 − 30 = 1170; May = 1170 + 500 − 100 = 1570; March = 1170 − (−50 + 200 − 30) = 1050", () => {
    expect(at(monthKeyFromISO("2026-04-01"))).toBe(1170);
    expect(at(monthKeyFromISO("2026-05-01"))).toBe(1570);
    expect(at(monthKeyFromISO("2026-03-01"))).toBe(1050);
    // February: before March's −75 refund the card owed 75 more.
    expect(at(monthKeyFromISO("2026-02-01"))).toBe(1125);
  });

  it("a pending row moves no month-end (the walk is on posted rows)", () => {
    const withPending = makeAmexBalanceAtEndOf({
      anchor,
      amexTransactions: [
        ...plaid,
        { occurredOn: "2026-05-28", amount: "-80.00", source: "plaid:amex", pending: true },
      ],
    });
    expect(withPending(monthKeyFromISO("2026-05-01"))).toBe(1570);
  });

  it("figures are whole cents (no float tails)", () => {
    const cents = makeAmexBalanceAtEndOf({
      anchor: { balance: 0.3, asOf: "2026-04-15" },
      amexTransactions: [
        { occurredOn: "2026-04-20", amount: "-0.10", source: "plaid:amex" },
        { occurredOn: "2026-04-21", amount: "-0.20", source: "plaid:amex" },
      ],
    });
    // 0.30 + 0.10 + 0.20 = 0.60 (in floats, 0.6000000000000001).
    expect(cents(monthKeyFromISO("2026-04-01"))).toBe(0.6);
    // March = 0.60 − April's 0.30 = 0.30.
    expect(cents(monthKeyFromISO("2026-03-01"))).toBe(0.3);
    // Back to nothing owed reads 0, never −0.
    const zero = makeAmexBalanceAtEndOf({
      anchor: { balance: 0.3, asOf: "2026-04-15" },
      amexTransactions: [
        { occurredOn: "2026-04-10", amount: "-0.10", source: "plaid:amex" },
        { occurredOn: "2026-04-12", amount: "-0.20", source: "plaid:amex" },
      ],
    });
    expect(Object.is(zero(monthKeyFromISO("2026-03-01")), 0)).toBe(true);
  });
});

// (#442/#449) A re-link can leave a second `plaid_accounts` row for one card
// (same institution + mask), with a debt on it. The combined resolver counts
// that card once. (Q3 moved these guards here from the relink e2e specs: "All
// cards" no longer walks a combined figure onto its rows, so the specs have no
// combined "bal" left to read.) Synthetic cards and balances.
describe("(#442/#449) resolveAmexDebt counts a re-linked card once", () => {
  const debt = (id: string, balance: string, updated: string): AmexDebtLike => ({
    name: `Amex ••${id}`,
    balance,
    plaidAccountId: id,
    lastBalanceUpdate: updated,
    plaidLastSyncedAt: null,
    type: "credit",
  });
  const debts = [
    debt("row-1001", "500.00", "2026-09-16T23:00:00.000Z"),
    debt("row-2002", "750.00", "2026-09-16T23:00:00.000Z"),
    debt("row-3003", "1250.00", "2026-09-16T23:00:00.000Z"),
    debt("row-1001-dup", "500.00", "2026-09-16T23:30:00.000Z"),
  ];
  const items = [
    {
      institutionName: "American Express",
      accounts: [
        { id: "row-1001", mask: "1001" },
        { id: "row-2002", mask: "2002" },
        { id: "row-3003", mask: "3003" },
        { id: "row-1001-dup", mask: "1001" },
      ],
    },
  ];

  it("(#442) a duplicate row with no transactions is not in scope: 500 + 750 + 1,250 = 2,500", () => {
    const got = resolveAmexDebt({
      debts,
      amexPlaidAccountIds: new Set(["row-1001", "row-2002", "row-3003"]),
      plaidItemsForScope: items,
    });
    expect(got!.balance).toBe("2500");
  });

  it("(#449) a duplicate row WITH a transaction is collapsed by institution + mask: still 2,500, never 3,000", () => {
    const got = resolveAmexDebt({
      debts,
      amexPlaidAccountIds: new Set(["row-1001", "row-2002", "row-3003", "row-1001-dup"]),
      plaidItemsForScope: items,
    });
    expect(got!.balance).toBe("2500");
    expect(got!.lastBalanceUpdate).toBe("2026-09-16T23:30:00.000Z");
  });
});

// ⭐ (F6 round 4, review finding 3 — merged onto Q3's walk) An expired hold
// counts nowhere on the card page either: not in the ending-balance tile, not in
// the 12-month chart, and the per-row walk skips it — so they agree, and each
// month's walk starts at the month before's ending balance. Synthetic Plaid rows
// (bank sign): the card read 10/03 at 1,000.00; 10/01 A 10 posted; 10/05 H 52 an
// expired hold (pending, the server's `expiredHold`); 10/06 B 20 posted.
describe("(F6 round 4) the tile, the chart and the walk leave out an expired hold together", () => {
  const anchor: AmexAnchor = { balance: 1000, asOf: "2026-10-03T15:00:00Z" };
  const rows = [
    { id: "A", occurredOn: "2026-10-01", amount: "-10.00", source: "plaid:amex" },
    { id: "H", occurredOn: "2026-10-05", amount: "-52.00", source: "plaid:amex", pending: true, expiredHold: true },
    { id: "B", occurredOn: "2026-10-06", amount: "-20.00", source: "plaid:amex" },
  ];
  it("October ends at 1,020.00 (the card's real balance; a counted 52 read 1,072.00); September at 990.00", () => {
    const at = makeAmexBalanceAtEndOf({ anchor, amexTransactions: rows });
    expect(at(monthKeyFromISO("2026-10-01"))).toBe(1020);
    expect(at(monthKeyFromISO("2026-09-01"))).toBe(990);
    // The server's flag alone (no pending flag on the row) still keeps it out: `isCounted`.
    const flagOnly = makeAmexBalanceAtEndOf({
      anchor,
      amexTransactions: rows.map(({ pending: _p, ...r }) => r),
    });
    expect(flagOnly(monthKeyFromISO("2026-10-01"))).toBe(1020);
    // Control — the same 52 as a posted, counted purchase: 1,072.00.
    const counted = makeAmexBalanceAtEndOf({
      anchor,
      amexTransactions: rows.map(({ pending: _p, expiredHold: _e, ...r }) => r),
    });
    expect(counted(monthKeyFromISO("2026-10-01"))).toBe(1072);
  });
  it("the October walk from its ending balance opens at September's ending balance; forward = backward", () => {
    const at = makeAmexBalanceAtEndOf({ anchor, amexTransactions: rows });
    const end = at(monthKeyFromISO("2026-10-01"))!;
    const back = walkCardBalancesBack(rows, end);
    expect(back.get("B")).toBe(1020);
    expect(back.has("H")).toBe(false);
    expect(back.get("A")).toBe(1000);
    const opening = openingCardBalance(rows, end);
    expect(opening).toBe(at(monthKeyFromISO("2026-09-01")));
    expect(walkCardBalancesForward(rows, opening)).toEqual(back);
  });
});
