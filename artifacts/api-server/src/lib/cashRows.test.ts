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
  classifyCashRows(rows, { anchor, accountExternalId: account, todayISO: TODAY });
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
