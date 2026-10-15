import { describe, expect, it } from "vitest";
import { monthKeyFromISO } from "@/components/account-page/month-navigator";
import {
  cardWalkNote,
  openingCardBalance,
  owedDeltaCents,
  sumOwed,
  walkCardBalancesBack,
  walkCardBalancesForward,
  type CardBalanceRow,
} from "./cardBalanceWalk";
import { makeAmexBalanceAtEndOf } from "./amexEndingBalance";
import { buildBalanceWindow } from "./amexBalanceWindow";
import { computeRunningBalances, sortNewestFirst } from "./runningBalance";

/**
 * ⭐ (Q3) THE CARD-BALANCE WALK, on hand-worked fixtures (synthetic amounts).
 *
 * A card balance is what is OWED: a purchase, a fee or interest raises it; a
 * payment, a refund or a credit lowers it. Plaid rows carry the bank sign (a
 * purchase NEGATIVE); workbook rows (`source: "amex"`) the opposite. Every
 * figure below is worked by hand in its comment, and every walk is checked
 * both ways: back from the anchor and forward from the opening balance.
 */

const plaid = (id: string, occurredOn: string, amount: string, more: Partial<CardBalanceRow> = {}): CardBalanceRow => ({
  id,
  occurredOn,
  amount,
  source: "plaid:amex",
  ...more,
});
const asObject = (m: Map<string, number>) => Object.fromEntries(m);

/** Back from the anchor and forward from the opening balance give the same figures. */
function expectBothWays(rows: CardBalanceRow[], balanceAfterNewest: number, expected: Record<string, number>, opening: number) {
  const back = walkCardBalancesBack(rows, balanceAfterNewest);
  expect(asObject(back)).toEqual(expected);
  expect(openingCardBalance(rows, balanceAfterNewest)).toBe(opening);
  const forward = walkCardBalancesForward(rows, opening);
  expect(asObject(forward)).toEqual(expected);
}

describe("(Q3) the sign: every source on the owed sign", () => {
  it("a Plaid purchase raises what is owed; a Plaid payment lowers it", () => {
    expect(owedDeltaCents({ source: "plaid:amex", amount: "-64.00" })).toBe(6400);
    expect(owedDeltaCents({ source: "plaid:amex", amount: "250.00" })).toBe(-25000);
    // Any Plaid card (another bank's card on its own page) reads the same way.
    expect(owedDeltaCents({ source: "plaid:chase", amount: "-14.82" })).toBe(1482);
  });
  it("a workbook purchase is stored positive and raises it the same", () => {
    expect(owedDeltaCents({ source: "amex", amount: "64.00" })).toBe(6400);
    expect(owedDeltaCents({ source: "amex", amount: "-250.00" })).toBe(-25000);
  });
});

describe("(Q3) the worked example: four Plaid purchases, current owed $1,000.00", () => {
  // Newest first: −64.00, −38.75, −52.10, −86.40 (all purchases).
  //   after r1 (Sep 15)                     1,000.00
  //   after r2 (Sep 14)  1,000.00 − 64.00 =    936.00
  //   after r3 (Sep 12)    936.00 − 38.75 =    897.25
  //   after r4 (Sep 10)    897.25 − 52.10 =    845.15
  //   before r4            845.15 − 86.40 =    758.75  (opening)
  const rows = [
    plaid("r1", "2026-09-15", "-64.00"),
    plaid("r2", "2026-09-14", "-38.75"),
    plaid("r3", "2026-09-12", "-52.10"),
    plaid("r4", "2026-09-10", "-86.40"),
  ];

  it("walks back down from the anchor, and forward from the opening back up to it", () => {
    expectBothWays(rows, 1000, { r1: 1000, r2: 936, r3: 897.25, r4: 845.15 }, 758.75);
  });

  it("(before) the checking helper walked them the wrong way: 1,000 / 1,064 / 1,102.75 / 1,154.85", () => {
    // `computeRunningBalances` stays for checking (older = bal − amount); on
    // card rows it is wrong. Pinned here so the before/after is on record.
    expect(asObject(computeRunningBalances(sortNewestFirst(rows), 1000))).toEqual({
      r1: 1000,
      r2: 1064,
      r3: 1102.75,
      r4: 1154.85,
    });
  });
});

describe("(Q3) purchases, payments, refunds, credits, fees and interest", () => {
  // One card, newest first; the card owes $600.00 after the newest row.
  //   Sep 20 PAYMENT (partial)  +250.00 → owed −250.00   after: 600.00
  //   Sep 19 INTEREST CHARGE     −18.42 → owed  +18.42   after: 600.00 + 250.00 = 850.00
  //   Sep 18 LATE FEE            −39.00 → owed  +39.00   after: 850.00 −  18.42 = 831.58
  //   Sep 17 MERCHANT RETURN     +15.25 → owed  −15.25   after: 831.58 −  39.00 = 792.58
  //   Sep 16 STATEMENT CREDIT    +10.00 → owed  −10.00   after: 792.58 +  15.25 = 807.83
  //   Sep 15 GROCER             −120.00 → owed +120.00   after: 807.83 +  10.00 = 817.83
  //   opening                                            817.83 − 120.00 = 697.83
  // (Fees and interest have no kind of their own in the data model: they are
  // rows like any charge, and the sign rule reads them as charges.)
  const rows = [
    plaid("pay", "2026-09-20", "250.00"),
    plaid("int", "2026-09-19", "-18.42"),
    plaid("fee", "2026-09-18", "-39.00"),
    plaid("ret", "2026-09-17", "15.25"),
    plaid("crd", "2026-09-16", "10.00"),
    plaid("buy", "2026-09-15", "-120.00"),
  ];
  const expected = { pay: 600, int: 850, fee: 831.58, ret: 792.58, crd: 807.83, buy: 817.83 };

  it("each kind moves the balance its own way, both directions agree", () => {
    expectBothWays(rows, 600, expected, 697.83);
  });

  it("a partial payment leaves the rest owed: 850.00 − 250.00 = 600.00", () => {
    const m = walkCardBalancesBack(rows, 600);
    expect(m.get("int")! - m.get("pay")!).toBe(250);
    expect(m.get("pay")).toBe(600);
  });

  it("the same activity from the workbook (purchases positive) gives the same figures", () => {
    const workbook = rows.map((r) => ({ ...r, source: "amex", amount: String(-Number(r.amount)) }));
    expectBothWays(workbook, 600, expected, 697.83);
  });

  it("a card mixing both sources still walks one balance", () => {
    const mixed = rows.map((r, i) => (i % 2 ? { ...r, source: "amex", amount: String(-Number(r.amount)) } : r));
    expectBothWays(mixed, 600, expected, 697.83);
  });
});

describe("(Q3) pending rows: no figure, never counted twice", () => {
  // A $45.00 hold the card later posted as $47.50 (a tip). The sync could not
  // re-key it, so BOTH rows sit in /transactions. Only posted rows are walked.
  //   Sep 21 CAFE (posted)  −47.50  after: 500.00
  //   Sep 19 BOOKS          −20.00  after: 500.00 − 47.50 = 452.50
  //   opening                       452.50 − 20.00 = 432.50
  // Counted twice the BOOKS figure would read 407.50.
  const rows = [
    plaid("cafe-posted", "2026-09-21", "-47.50"),
    plaid("cafe-pending", "2026-09-20", "-45.00", { pending: true }),
    plaid("fuel-pending", "2026-09-21", "-30.00", { pending: true }),
    plaid("books", "2026-09-19", "-20.00"),
  ];

  it("pending rows get no figure; the posted charge counts once", () => {
    expectBothWays(rows, 500, { "cafe-posted": 500, books: 452.5 }, 432.5);
    const m = walkCardBalancesBack(rows, 500);
    expect(m.has("cafe-pending")).toBe(false);
    expect(m.has("fuel-pending")).toBe(false);
  });

  it("the month sum leaves pending rows out", () => {
    expect(sumOwed(rows)).toBe(67.5);
  });
});

describe("(Q3) same-day ordering", () => {
  // Sep 22, four rows. The page's order: timed rows newest first, then the
  // untimed ones by id, newest id first — the order the day list shows.
  //   tx-a 18:00  −10.00  after: 100.00
  //   tx-b 09:00  −20.00  after: 100.00 − 10.00 = 90.00
  //   tx-e  —      −5.00  after:  90.00 − 20.00 = 70.00
  //   tx-c  —     −30.00  after:  70.00 −  5.00 = 65.00
  //   opening                      65.00 − 30.00 = 35.00
  const rows = [
    plaid("tx-c", "2026-09-22", "-30.00", { occurredAt: null }),
    plaid("tx-b", "2026-09-22", "-20.00", { occurredAt: "2026-09-22T09:00:00.000Z" }),
    plaid("tx-e", "2026-09-22", "-5.00", { occurredAt: null }),
    plaid("tx-a", "2026-09-22", "-10.00", { occurredAt: "2026-09-22T18:00:00.000Z" }),
  ];
  const expected = { "tx-a": 100, "tx-b": 90, "tx-e": 70, "tx-c": 65 };

  it("follows the day list's order, whatever order the rows arrive in", () => {
    expectBothWays(rows, 100, expected, 35);
    expectBothWays([...rows].reverse(), 100, expected, 35);
  });
});

describe("(Q3) forward = backward on any card history", () => {
  // A seeded generator: 300 rows over 90 days, both sources, some pending.
  let seed = 20261014;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const rows: CardBalanceRow[] = Array.from({ length: 300 }, (_, i) => {
    const cents = Math.round(rand() * 40000) - 15000;
    const day = new Date(Date.UTC(2026, 6, 1) + Math.floor(rand() * 90) * 86_400_000).toISOString().slice(0, 10);
    return {
      id: `g-${String(i).padStart(3, "0")}`,
      occurredOn: day,
      occurredAt: rand() < 0.5 ? `${day}T${String(Math.floor(rand() * 24)).padStart(2, "0")}:00:00.000Z` : null,
      amount: (cents / 100).toFixed(2),
      source: rand() < 0.3 ? "amex" : "plaid:amex",
      pending: rand() < 0.1,
    };
  });

  it("back from the anchor and forward from the opening agree to the cent", () => {
    const anchor = 4321.09;
    const back = walkCardBalancesBack(rows, anchor);
    const opening = openingCardBalance(rows, anchor);
    const forward = walkCardBalancesForward(rows, opening);
    expect(back.size).toBe(rows.filter((r) => !r.pending).length);
    expect(asObject(forward)).toEqual(asObject(back));
    // The newest posted row carries the anchor; the walk ends on the opening.
    const posted = sortNewestFirst(rows.filter((r) => !r.pending));
    expect(back.get(posted[0]!.id)).toBe(anchor);
    const oldest = posted[posted.length - 1]!;
    expect(Math.round((back.get(oldest.id)! * 100 - owedDeltaCents(oldest)))).toBe(Math.round(opening * 100));
  });
});

// ⭐ (F6 ⇄ Q3 merge) An expired hold counts nowhere, the card's balance included:
// the walk reads posted rows that COUNT (`isCounted`). The server sends
// `expiredHold` on a row still pending more than 7 days after its date (or its
// reversal); it is pending, so the posted-only rule already leaves it out — and
// the explicit skip keeps the walk on the one shared answer even when a row
// carries the flag without `pending`. Synthetic, worked by hand.
describe("(F6 ⇄ Q3) an expired hold moves no card balance; forward = backward", () => {
  // Card owes 500.00 after the newest row. Plaid sign: a purchase negative.
  const rows: CardBalanceRow[] = [
    plaid("a", "2026-10-01", "-20.00"), //                                       +20.00
    plaid("h", "2026-10-02", "-150.00", { pending: true, expiredHold: true }), // expired hold: nothing
    plaid("r", "2026-10-09", "150.00", { pending: true, expiredHold: true }), //  its reversal: nothing
    plaid("b", "2026-10-10", "-30.00"), //                                       +30.00
    plaid("f", "2026-10-11", "-99.00", { expiredHold: true }), //               the flag alone: nothing
  ];
  it("only the posted, counted rows carry a figure: b 500.00, a 470.00; opening 450.00", () => {
    expectBothWays(rows, 500, { b: 500, a: 470 }, 450);
    expect(sumOwed(rows)).toBe(50);
  });
  it("on the seeded 300-row history, flagging rows expired takes exactly their moves out, both ways", () => {
    let seed = 20261015;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const history: CardBalanceRow[] = Array.from({ length: 300 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 6, 1) + Math.floor(rand() * 90) * 86_400_000).toISOString().slice(0, 10);
      const r = rand();
      return plaid(`e-${String(i).padStart(3, "0")}`, day, ((Math.round(rand() * 40000) - 15000) / 100).toFixed(2), {
        source: rand() < 0.3 ? "amex" : "plaid:amex",
        pending: r < 0.15,
        expiredHold: r < 0.08 ? true : r > 0.95 ? true : null, // some pending + expired, some flag-only
      });
    });
    const counted = history.filter((x) => x.pending !== true && x.expiredHold !== true);
    const back = walkCardBalancesBack(history, 2468.1);
    expect(asObject(back)).toEqual(asObject(walkCardBalancesBack(counted, 2468.1)));
    const opening = openingCardBalance(history, 2468.1);
    expect(opening).toBe(openingCardBalance(counted, 2468.1));
    expect(asObject(walkCardBalancesForward(history, opening))).toEqual(asObject(back));
    expect(back.size).toBe(counted.length);
  });
});

describe("(Q3) month-ends tie to the per-row walk — a past month and the anchor's month", () => {
  // Plaid rows; the card's current balance is $1,000.00, read Sep 16 06:00 in
  // Chicago (11:00 UTC). A pending row on the anchor day is not walked.
  //   Aug  5 −200.00 purchase   Aug 20 +300.00 payment   Aug 28 −45.67 purchase
  //   Sep  2  −64.00 purchase   Sep  9 +100.00 payment   Sep 15 −38.75 purchase
  // End of September = the anchor (no posted row after Sep 16) = 1,000.00.
  // September's rows from 1,000.00:  Sep 15 1,000.00 · Sep 9 961.25 · Sep 2 1,061.25
  //   opening of September = 1,061.25 − 64.00 = 997.25 = end of August.
  // August's rows from 997.25:  Aug 28 997.25 · Aug 20 951.58 · Aug 5 1,251.58
  //   opening of August = 1,251.58 − 200.00 = 1,051.58 = end of July.
  const anchor = { balance: 1000, asOf: "2026-09-16T11:00:00.000Z" };
  const sep = [
    plaid("s15", "2026-09-15", "-38.75"),
    plaid("s09", "2026-09-09", "100.00"),
    plaid("s02", "2026-09-02", "-64.00"),
    plaid("s16p", "2026-09-16", "-12.00", { pending: true }),
  ];
  const aug = [
    plaid("a28", "2026-08-28", "-45.67"),
    plaid("a20", "2026-08-20", "300.00"),
    plaid("a05", "2026-08-05", "-200.00"),
  ];
  const at = makeAmexBalanceAtEndOf({ anchor, amexTransactions: [...sep, ...aug] });
  const SEP = monthKeyFromISO("2026-09-01");
  const AUG = monthKeyFromISO("2026-08-01");
  const JUL = monthKeyFromISO("2026-07-01");

  it("the anchor's month: its end is the anchor, and its rows walk down to the end of August", () => {
    expect(at(SEP)).toBe(1000);
    expectBothWays(sep, at(SEP)!, { s15: 1000, s09: 961.25, s02: 1061.25 }, 997.25);
    expect(at(AUG)).toBe(997.25);
  });

  it("a past month: its end is where its rows start, and they walk down to the end of July", () => {
    expectBothWays(aug, at(AUG)!, { a28: 997.25, a20: 951.58, a05: 1251.58 }, 1051.58);
    expect(at(JUL)).toBe(1051.58);
  });

  it("the 12-month line passes through the same figures", () => {
    const now = new Date(2026, 8, 16, 12);
    const w = buildBalanceWindow({
      anchorPresent: true,
      currentMonth: SEP,
      balanceAtEndOf: at,
      transactions: [...sep, ...aug],
      now,
    })!;
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = (ms: number) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const byDay = new Map(w.series.map((p) => [day(p.x), p.balance]));
    expect(byDay.get("2026-08-29")).toBe(997.25); // Sat after Aug 28: end of August's figure
    expect(byDay.get("2026-09-05")).toBe(1061.25); // after Sep 2
    expect(byDay.get("2026-09-12")).toBe(961.25); //  after Sep 9
    expect(byDay.get("2026-09-16")).toBe(1000); //    today: the anchor
  });
});

describe("(Q3) no anchor: no running figures, never $0", () => {
  it("no month-end and no chart", () => {
    const at = makeAmexBalanceAtEndOf({ anchor: null, amexTransactions: [plaid("x", "2026-09-02", "-5.00")] });
    expect(at(monthKeyFromISO("2026-09-01"))).toBeNull();
    expect(
      buildBalanceWindow({
        anchorPresent: false,
        currentMonth: monthKeyFromISO("2026-09-01"),
        balanceAtEndOf: at,
        transactions: [],
      }),
    ).toBeNull();
  });
});

describe("(Q3) the note says what the figures count from", () => {
  const SEP = monthKeyFromISO("2026-09-01");
  const anchor = { balance: 1000, asOf: "2026-09-16T11:00:00.000Z" };
  const sep = [plaid("s15", "2026-09-15", "-38.75"), plaid("s02", "2026-09-02", "-64.00")];

  it("the anchor's month: back from the card's balance, with its date", () => {
    expect(
      cardWalkNote({ anchor, selectedMonth: SEP, monthEndBalance: 1000, monthRows: sep, fallbackMonth: SEP }),
    ).toBe("Balance after each row, counting back from $1,000.00 (as of Sep 16).");
  });

  it("a past month: back from that month's end", () => {
    expect(
      cardWalkNote({ anchor, selectedMonth: monthKeyFromISO("2026-08-01"), monthEndBalance: 997.25, monthRows: [], fallbackMonth: SEP }),
    ).toBe("Balance after each row, counting back from $997.25 at the end of August.");
    expect(
      cardWalkNote({ anchor, selectedMonth: monthKeyFromISO("2025-12-01"), monthEndBalance: 812.4, monthRows: [], fallbackMonth: SEP }),
    ).toBe("Balance after each row, counting back from $812.40 at the end of December 2025.");
  });

  it("a stale anchor shows its date; rows after it count forward from it", () => {
    const stale = { balance: 950, asOf: "2026-09-03T15:00:00.000Z" };
    expect(
      cardWalkNote({ anchor: stale, selectedMonth: SEP, monthEndBalance: 950, monthRows: [plaid("s02", "2026-09-02", "-64.00")], fallbackMonth: SEP }),
    ).toBe("Balance after each row, counting back from $950.00 (as of Sep 3).");
    expect(
      cardWalkNote({ anchor: stale, selectedMonth: SEP, monthEndBalance: 988.75, monthRows: sep, fallbackMonth: SEP }),
    ).toBe("Balance after each row, counting from $950.00 (as of Sep 3).");
    // A pending row after the anchor moves nothing, so it changes no words.
    expect(
      cardWalkNote({
        anchor: stale,
        selectedMonth: SEP,
        monthEndBalance: 950,
        monthRows: [plaid("s02", "2026-09-02", "-64.00"), plaid("p", "2026-09-10", "-9.00", { pending: true })],
        fallbackMonth: SEP,
      }),
    ).toBe("Balance after each row, counting back from $950.00 (as of Sep 3).");
    // An anchor from an earlier month: this month's rows all count forward from it.
    expect(
      cardWalkNote({ anchor: { balance: 700, asOf: "2026-08-28T15:00:00.000Z" }, selectedMonth: SEP, monthEndBalance: 802.75, monthRows: sep, fallbackMonth: SEP }),
    ).toBe("Balance after each row, counting from $700.00 (as of Aug 28).");
  });

  it("a debt row's figure prints the Summary's date; the walk keeps its own anchor date", () => {
    expect(
      cardWalkNote({
        anchor: { balance: 1000, asOf: "2026-09-16T11:00:00.000Z" },
        shownAsOf: "2026-09-15T20:00:00.000Z",
        selectedMonth: SEP,
        monthEndBalance: 1000,
        monthRows: sep,
        fallbackMonth: SEP,
      }),
    ).toBe("Balance after each row, counting back from $1,000.00 (as of Sep 15).");
  });

  it("an anchor with no date says no date", () => {
    expect(
      cardWalkNote({ anchor: { balance: 1000, asOf: null }, selectedMonth: SEP, monthEndBalance: 1000, monthRows: sep, fallbackMonth: SEP }),
    ).toBe("Balance after each row, counting back from $1,000.00.");
  });
});
