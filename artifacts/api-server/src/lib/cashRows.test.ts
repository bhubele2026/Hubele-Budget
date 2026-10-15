import { describe, expect, it } from "vitest";
import {
  classifyCashRows,
  isBankRow,
  type CashAnchor,
  type CashRow,
} from "@workspace/avalanche-core";

// Balance read at 10:00 CT on 05-01 (15:00Z); today 05-14.
const ANCHOR: CashAnchor = { at: new Date("2026-05-01T15:00:00Z"), day: "2026-05-01" };
const TODAY = "2026-05-14";
const CHASE = "chase-ext";

const noon = (iso: string) => new Date(`${iso}T17:00:00Z`);
function row(id: string, occurredOn: string, amount: number, extra: Partial<CashRow> = {}): CashRow {
  return {
    id,
    occurredOn,
    amount,
    createdAt: noon(occurredOn),
    occurredAt: null,
    pending: false,
    description: "CORNER BISTRO",
    source: "plaid:chase",
    plaidAccountId: CHASE,
    plaidTransactionId: null,
    ...extra,
  };
}
const classify = (rows: CashRow[], anchor: CashAnchor | null = ANCHOR, account: string | null = CHASE) =>
  classifyCashRows(rows, { anchor, accountExternalId: account, todayISO: TODAY, expiredHolds: true });
const byId = (r: ReturnType<typeof classify>) => Object.fromEntries(r.rows.map((o) => [o.id, o]));

describe("isBankRow", () => {
  it("a Plaid row belongs only to the resolved account", () => {
    expect(isBankRow("plaid:chase", CHASE, CHASE)).toBe(true);
    expect(isBankRow("plaid:chase", "other", CHASE)).toBe(false);
    expect(isBankRow("plaid:chase", CHASE, null)).toBe(false);
  });

  it("a row with no Plaid account counts unless its source names a card", () => {
    expect(isBankRow("manual", null, CHASE)).toBe(true);
    expect(isBankRow(null, null, null)).toBe(true);
    expect(isBankRow("AMEX", null, CHASE)).toBe(false);
    expect(isBankRow("plaid:amex", null, CHASE)).toBe(false);
  });
});

describe("classifyCashRows", () => {
  it("counts a row after the read, and holds one dated before the snapshot day", () => {
    const r = classify([row("old", "2026-04-30", -10), row("new", "2026-05-03", -20)]);
    expect(byId(r).old).toMatchObject({ reason: "held", counts: false, contribution: 0 });
    expect(byId(r).new).toMatchObject({ reason: "counted", counts: true, contribution: -20 });
    expect(r.throughToday).toEqual({ rowCount: 1, net: -20 });
  });

  it("holds a Plaid charge dated ahead that the ledger had at the read (PR4b rule 3)", () => {
    const r = classify([row("ahead", "2026-05-03", -25, { createdAt: new Date("2026-05-01T14:00:00Z") })]);
    expect(byId(r).ahead!.reason).toBe("held");
    expect(r.throughToday).toEqual({ rowCount: 0, net: 0 });
  });

  it("names rows off the account: another account, a card source, and every Plaid row when the account is unresolved", () => {
    const rows = [
      row("other", "2026-05-03", -5, { plaidAccountId: "other" }),
      row("amex", "2026-05-03", -6, { plaidAccountId: null, source: "amex" }),
      row("manual", "2026-05-03", -7, { plaidAccountId: null, source: "manual" }),
      row("chase", "2026-05-03", -8),
    ];
    const resolved = byId(classify(rows));
    expect(resolved.other!.reason).toBe("not_bank");
    expect(resolved.amex!.reason).toBe("not_bank");
    expect(resolved.manual!.reason).toBe("counted");
    expect(resolved.chase!.reason).toBe("counted");

    const unresolved = classify(rows, ANCHOR, null);
    expect(byId(unresolved).chase!.reason).toBe("not_bank");
    expect(unresolved.throughToday).toEqual({ rowCount: 1, net: -7 });
  });

  it("pending held, posted after the read: the pending row is superseded and the posted row adds the tip", () => {
    const r = classify([
      row("p", "2026-05-01", -48.2, { pending: true, description: "TST* CORNER BISTRO", createdAt: new Date("2026-05-01T14:00:00Z") }),
      row("q", "2026-05-02", -55),
    ]);
    // Held comes first: a pending row the snapshot holds is "held", not "superseded".
    expect(byId(r).p).toMatchObject({ reason: "held", contribution: 0 });
    expect(byId(r).q).toMatchObject({ reason: "adjusted", counts: true, replacedId: "p" });
    expect(byId(r).q!.contribution).toBeCloseTo(-6.8, 10);
    expect(r.throughToday.rowCount).toBe(1);
    expect(r.throughToday.net).toBeCloseTo(-6.8, 10);
  });

  it("a held posted row whose pending half is not held still counts, in full", () => {
    // Both dated on the snapshot day. The pending row happened (16:07Z) and
    // arrived (16:10Z) after the 15:00Z read, so it is not held; the posted row
    // has no time, so rule 2 holds it for want of evidence.
    const r = classify([
      row("p", "2026-05-01", -48.2, {
        pending: true,
        description: "TST* CORNER BISTRO",
        occurredAt: new Date("2026-05-01T16:07:00Z"),
        createdAt: new Date("2026-05-01T16:10:00Z"),
      }),
      row("q", "2026-05-01", -55, { createdAt: new Date("2026-05-01T18:00:00Z") }),
    ]);
    expect(byId(r).p).toMatchObject({ reason: "superseded", contribution: 0 });
    expect(byId(r).q).toMatchObject({ reason: "counted", contribution: -55, replacedId: "p" });
    expect(r.throughToday).toEqual({ rowCount: 1, net: -55 });
  });

  it("a posted row and its pending half both held add nothing", () => {
    const r = classify([
      row("p", "2026-04-29", -48.2, { pending: true }),
      row("q", "2026-04-30", -55),
    ]);
    expect(byId(r).p!.reason).toBe("held");
    expect(byId(r).q).toMatchObject({ reason: "held", contribution: 0, replacedId: "p" });
    expect(r.throughToday).toEqual({ rowCount: 0, net: 0 });
  });

  it("a pending deposit the snapshot held never leaves only a difference: the posted deposit counts in full", () => {
    // `available` does not hold pending deposits.
    const r = classify([
      row("p", "2026-05-01", 500, { pending: true, description: "PAYROLL ACME", createdAt: new Date("2026-05-01T14:00:00Z") }),
      row("q", "2026-05-02", 500, { description: "PAYROLL ACME" }),
    ]);
    expect(byId(r).p!.reason).toBe("held");
    expect(byId(r).q).toMatchObject({ reason: "counted", contribution: 500, replacedId: "p" });
  });

  it("a snapshot-day pending charge with no evidence it was in the balance: the posting counts in full", () => {
    // Held by rule 2 for want of a time, but it arrived after the read.
    const r = classify([
      row("p", "2026-05-01", -48.2, { pending: true, createdAt: new Date("2026-05-01T16:00:00Z") }),
      row("q", "2026-05-02", -55),
    ]);
    expect(byId(r).p!.reason).toBe("held");
    expect(byId(r).q).toMatchObject({ reason: "counted", contribution: -55 });
  });

  it("neither half held: the pending row is superseded and the charge counts once, at the posted amount", () => {
    const r = classify([
      row("p", "2026-05-03", -48.2, { pending: true }),
      row("q", "2026-05-04", -55),
    ]);
    expect(byId(r).p).toMatchObject({ reason: "superseded", counts: false, contribution: 0 });
    expect(byId(r).q).toMatchObject({ reason: "counted", contribution: -55, replacedId: "p" });
    expect(r.throughToday).toEqual({ rowCount: 1, net: -55 });
  });

  it("a posted row dated after today still supersedes today's pending row; only rows through today are totalled", () => {
    const r = classify([
      row("p", "2026-05-14", -30, { pending: true }),
      row("q", "2026-05-16", -30),
    ]);
    expect(byId(r).p!.reason).toBe("superseded");
    expect(byId(r).q).toMatchObject({ reason: "counted", contribution: -30 });
    expect(r.throughToday).toEqual({ rowCount: 0, net: 0 });
  });

  it("a posted row that adds 0.00 still counts as a row on the ledger", () => {
    const r = classify([
      row("p", "2026-05-01", -20, { pending: true, createdAt: new Date("2026-05-01T14:00:00Z") }),
      row("q", "2026-05-02", -20),
    ]);
    expect(byId(r).q).toMatchObject({ reason: "adjusted", counts: true, contribution: 0 });
    expect(r.throughToday).toEqual({ rowCount: 1, net: 0 });
  });

  it("skips a second row with the same Plaid transaction id, keeping the first in input order", () => {
    const r = classify([
      row("a", "2026-05-03", -9, { plaidTransactionId: "t1" }),
      row("b", "2026-05-03", -9, { plaidTransactionId: "t1" }),
    ]);
    expect(r.rows.map((o) => [o.id, o.reason])).toEqual([
      ["a", "counted"],
      ["b", "duplicate"],
    ]);
  });

  it("⚠️ the lower bound is the ledger's, not a complete one: a row before anchor − 7 can change a later pair", () => {
    // All rows: q1 takes p1 (closer amount), leaving p2 — held, a charge — for q2,
    // which adds only −5.00. From anchor − 7 (04-24) p1 is gone, q1 takes p2, and
    // q2 counts in full. The ledger reads from the same bound, so it agrees.
    const rows = [
      row("p1", "2026-04-22", -54, { pending: true }),
      row("q1", "2026-04-28", -55),
      row("p2", "2026-04-26", -50, { pending: true }),
      row("q2", "2026-05-03", -55),
    ];
    expect(classify(rows).throughToday).toEqual({ rowCount: 1, net: -5 });
    expect(classify(rows.filter((r) => r.occurredOn >= "2026-04-24")).throughToday).toEqual({ rowCount: 1, net: -55 });
  });

  it("with no anchor nothing is held, and pairing still applies", () => {
    const r = classify(
      [
        row("old", "2026-04-20", -10),
        row("p", "2026-05-03", -48.2, { pending: true }),
        row("q", "2026-05-04", -55),
      ],
      null,
    );
    expect(byId(r).old!.reason).toBe("counted");
    expect(byId(r).p!.reason).toBe("superseded");
    expect(r.throughToday).toEqual({ rowCount: 2, net: -65 });
  });
});

describe("classifyCashRows — a confirmed payment claim (PR-D)", () => {
  // The user logs "Payment — Visa" in the app (a manual checking row), then the
  // bank's own debit for that payment arrives. One payment, two rows.
  const claim = (extra: Partial<CashRow> = {}) =>
    row("claim", "2026-05-10", -250, {
      source: "manual",
      plaidAccountId: null,
      description: "Payment — Visa",
      ...extra,
    });
  const bank = row("bank", "2026-05-11", -250, { description: "VISA ONLINE PAYMENT" });

  it("before PR-D both left cash: the same 250.00 counted twice", () => {
    const r = classify([claim(), bank]);
    expect(byId(r).claim).toMatchObject({ reason: "counted", contribution: -250 });
    expect(r.throughToday).toEqual({ rowCount: 2, net: -500 });
  });

  it("confirmed, the claim adds 0 and the bank row is the payment: 250.00 once", () => {
    const r = classify([claim({ claimConfirmed: true }), bank]);
    expect(byId(r).claim).toMatchObject({ reason: "claim_confirmed", counts: false, contribution: 0 });
    expect(byId(r).bank).toMatchObject({ reason: "counted", contribution: -250 });
    expect(r.throughToday).toEqual({ rowCount: 1, net: -250 });
  });

  it("an UNconfirmed claim still counts: until a bank row says so, the payment is the claim", () => {
    const r = classify([claim({ claimConfirmed: false })]);
    expect(r.throughToday).toEqual({ rowCount: 1, net: -250 });
  });

  it("a confirmed claim the snapshot already holds stays held (adds 0 either way)", () => {
    const r = classify([claim({ claimConfirmed: true, occurredOn: "2026-04-28" })]);
    expect(byId(r).claim!.reason).toBe("held");
  });
});

// ⭐ (F6 round 3) THE CASH RULE'S STEP 3b: an expired hold and its reversal add 0 —
// except a reversal whose hold the anchor holds (`available` held the hold: the
// reversal is the money coming back). Today 05-14: rows dated before 05-07 are
// more than 7 days old. Synthetic rows.
describe("classifyCashRows — expired holds (F6 round 3)", () => {
  const p = (id: string, on: string, amount: number, extra: Partial<CashRow> = {}) => row(id, on, amount, { pending: true, ...extra });

  it("an unpaired expired hold dated after the snapshot day adds 0 (reason expired); 7 days old still counts", () => {
    const r = byId(classify([p("old", "2026-05-06", -30), p("edge", "2026-05-07", -20)]));
    expect(r.old).toMatchObject({ reason: "expired", counts: false, contribution: 0 });
    expect(r.edge).toMatchObject({ reason: "counted", contribution: -20 });
  });

  it("a hold and its younger reversal, both after the snapshot: both add 0 (before the rule: −50 + 50, the same cash)", () => {
    const rows = [p("h", "2026-05-04", -50), p("v", "2026-05-10", 50, { description: "Restaurant Transaction" })];
    const r = classify(rows);
    expect(byId(r).h!.reason).toBe("expired");
    expect(byId(r).v!.reason).toBe("expired");
    expect(r.throughToday).toEqual({ rowCount: 0, net: 0 });
    const before = classifyCashRows(rows, { anchor: ANCHOR, accountExternalId: CHASE, todayISO: TODAY, expiredHolds: false });
    expect(before.throughToday).toEqual({ rowCount: 2, net: 0 });
  });

  it("⭐ the snapshot held the hold (dated before its day): the reversal still counts — the money coming back", () => {
    // The hold is 14 days old and held; its reversal (7 days old) is young.
    const r = byId(classify([p("h", "2026-04-30", -50), p("v", "2026-05-07", 50)]));
    expect(r.h).toMatchObject({ reason: "held", contribution: 0 });
    expect(r.v).toMatchObject({ reason: "counted", contribution: 50 });
  });

  it("no anchor (the register): the pair adds 0", () => {
    const r = byId(classify([p("h", "2026-04-30", -50), p("v", "2026-05-07", 50)], null));
    expect([r.h!.reason, r.v!.reason]).toEqual(["expired", "expired"]);
  });

  it("a pending row its posted row replaced stays superseded (never expired); another account's row stays not_bank", () => {
    const rows = [
      p("pend", "2026-05-03", -40, { description: "CORNER BISTRO" }),
      row("post", "2026-05-04", -48, { createdAt: noon("2026-05-05") }),
      p("twin", "2026-05-03", -10, { plaidAccountId: "other" }),
    ];
    const r = byId(classify(rows));
    expect(r.pend!.reason).toBe("superseded");
    expect(r.twin!.reason).toBe("not_bank");
  });

  it("kill switch (expiredHolds: false): every row reads as before the rule", () => {
    const rows = [p("old", "2026-05-06", -30), p("h", "2026-05-04", -50), p("v", "2026-05-10", 50)];
    const off = classifyCashRows(rows, { anchor: ANCHOR, accountExternalId: CHASE, todayISO: TODAY, expiredHolds: false });
    expect(off.rows.map((o) => o.reason)).toEqual(["counted", "counted", "counted"]);
    expect(off.throughToday).toEqual({ rowCount: 3, net: -30 });
    expect(off.rows.every((o) => o.reversalOf === null)).toBe(true);
  });

  it("(F6 round 4) a reversal names its hold (`reversalOf`), counted or not; other rows name none", () => {
    const counted = byId(classify([p("h", "2026-04-30", -50), p("v", "2026-05-07", 50)]));
    expect(counted.v).toMatchObject({ reason: "counted", reversalOf: "h" });
    expect(counted.h!.reversalOf).toBeNull();
    const expired = byId(classify([p("h", "2026-05-04", -50), p("v", "2026-05-10", 50)]));
    expect(expired.v).toMatchObject({ reason: "expired", reversalOf: "h" });
  });

  it("⭐ (F6 round 4) a reversal 31 days after its hold, the hold BEFORE the rows passed in (`priorRows`): held, so the reversal counts", () => {
    // Snapshot read 05-01; today 05-14; the ledger reads from 04-24 (anchor day − 7).
    // A car-rental hold 04-10 (held by the snapshot), its reversal 05-05 (9 days old, 25 days after it).
    const hold = p("h", "2026-04-10", -80, { description: "CAR RENTAL HOLD" });
    const rev = p("v", "2026-05-05", 80, { description: "Car Rental Transaction" });
    // Without the prior rows the reversal reads as an orphan expired credit: 0.
    expect(byId(classify([rev])).v).toMatchObject({ reason: "expired", contribution: 0, reversalOf: null });
    // With them it pairs with its held hold and counts — the money coming back.
    const r = classifyCashRows([rev], { anchor: ANCHOR, accountExternalId: CHASE, todayISO: TODAY, expiredHolds: true, priorRows: [hold] });
    expect(r.rows).toHaveLength(1);
    expect(byId(r).v).toMatchObject({ reason: "counted", contribution: 80, reversalOf: "h" });
    expect(r.throughToday).toEqual({ rowCount: 1, net: 80 });
    // A prior pending row its posted twin replaced is no hold: the credit stays an orphan.
    const replaced = [hold, row("posted", "2026-04-12", -80, { description: "CAR RENTAL HOLD", createdAt: noon("2026-04-13") })];
    const r2 = classifyCashRows([rev], { anchor: ANCHOR, accountExternalId: CHASE, todayISO: TODAY, expiredHolds: true, priorRows: replaced });
    expect(byId(r2).v).toMatchObject({ reason: "expired", reversalOf: null });
    // Prior rows on another account are not read; with the rule off they change nothing.
    const other = classifyCashRows([rev], { anchor: ANCHOR, accountExternalId: CHASE, todayISO: TODAY, expiredHolds: true, priorRows: [{ ...hold, plaidAccountId: "other" }] });
    expect(byId(other).v!.reason).toBe("expired");
    const off = classifyCashRows([rev], { anchor: ANCHOR, accountExternalId: CHASE, todayISO: TODAY, expiredHolds: false, priorRows: [hold] });
    expect(byId(off).v).toMatchObject({ reason: "counted", contribution: 80, reversalOf: null });
  });
});
