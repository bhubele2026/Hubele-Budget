// (F3) The bank balance check's own rules — pure, no database.
//   bankCheckLedger:   rules 1–3 on top of the cash rule (pending deposits on
//                      both sides; the check's own days at a later recompute).
//   bankBalanceCheckOf: the review's answer (status, reason, staleness, direction).
// Synthetic rows only.

import { describe, expect, it } from "vitest";
import {
  bankBalanceCheckOf,
  bankCheckLedger,
  classifyCashRows,
  sameAnchorMoment,
  type BankBalanceCheckArgs,
  type BankCheckLedgerInputs,
  type CashAnchor,
  type CashRow,
} from "@workspace/avalanche-core";

// The previous anchor: read 10:00 CT on 10/10 (15:00Z). The check: Wed 10/14 at 14:00 CT.
const ANCHOR: CashAnchor = { at: new Date("2026-10-10T15:00:00Z"), day: "2026-10-10" };
const CHECK_DAY = "2026-10-14";
const CHECK_AT = new Date("2026-10-14T19:00:00Z");
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
    description: "ROW",
    source: "plaid:chase",
    plaidAccountId: CHASE,
    plaidTransactionId: null,
    ...extra,
  };
}

function ledger(rows: CashRow[], over: Partial<BankCheckLedgerInputs> = {}) {
  const { rows: outcomes } = classifyCashRows(rows, { anchor: ANCHOR, accountExternalId: CHASE, todayISO: CHECK_DAY, expiredHolds: true });
  return bankCheckLedger({
    rows,
    outcomes,
    accountExternalId: CHASE,
    checkDay: CHECK_DAY,
    checkAt: CHECK_AT,
    bankField: "available",
    ...over,
  });
}
/** What the cash rule alone adds through the check's day (Plaid rows), for comparison. */
function cashRuleNet(rows: CashRow[]): number {
  const r = classifyCashRows(rows, { anchor: ANCHOR, accountExternalId: CHASE, todayISO: CHECK_DAY, expiredHolds: true });
  return r.rows.reduce((a, o, i) => a + (o.counts && o.occurredOn <= CHECK_DAY && rows[i]!.plaidAccountId ? o.contribution : 0), 0);
}

describe("bankCheckLedger — the ledger's side of the check", () => {
  it("with no pending deposit it is exactly the cash rule's Plaid rows through the check's day", () => {
    const rows = [
      row("held", "2026-10-09", -40), // before the anchor's day: held
      row("a", "2026-10-11", -25.5),
      row("b", "2026-10-12", 1200), // a posted paycheck
      row("p", "2026-10-13", -9.99, { pending: true }),
      row("manual", "2026-10-12", -500, { plaidAccountId: null, source: "manual" }),
      row("other", "2026-10-12", -70, { plaidAccountId: "savings-ext" }),
    ];
    const l = ledger(rows);
    expect(l.net).toBeCloseTo(cashRuleNet(rows), 10);
    expect(l.net).toBeCloseTo(-25.5 + 1200 - 9.99, 10);
    expect(l).toMatchObject({ excluded: { ids: [] }, added: { ids: [] }, pendingDeposits: { ids: [] }, lateRows: 0 });
    // (T2) The rows behind `net`, each with what it added; they sum to `net` (nothing added by rule 2 here).
    expect(l.counted.map((c) => c.id)).toEqual(["a", "b", "p"]);
    expect(l.counted.every((c) => !c.late)).toBe(true);
    expect(l.counted.reduce((a, c) => a + c.contribution, 0)).toBeCloseTo(l.net, 10);
    // (T2) The typed-in row is counted by H2's balance, listed here, and left out of the check's `net`.
    expect(l.manual).toEqual({ ids: ["manual"], amount: -500 });
  });

  it("(T2) a typed-in row dated before the anchor's day is already in the reading: not listed", () => {
    const rows = [
      row("paidBefore", "2026-10-09", -432, { plaidAccountId: null, source: "manual" }),
      row("paidAfter", "2026-10-13", -432, { plaidAccountId: null, source: "manual" }),
      // After the check's day: not the check's.
      row("later", "2026-10-15", -10, { plaidAccountId: null, source: "manual" }),
      // A card's row with no Plaid account is not the bank's at all.
      row("amex", "2026-10-12", -60, { plaidAccountId: null, source: "amex" }),
    ];
    const l = ledger(rows);
    expect(l.manual).toEqual({ ids: ["paidAfter"], amount: -432 });
    expect(l.net).toBe(0);
    expect(l.counted).toEqual([]);
  });

  it("⭐ rule 1: an unpaired pending deposit is left out when the bank figure is `available` (the false drift)", () => {
    const rows = [row("pay", "2026-10-13", 2000, { pending: true }), row("a", "2026-10-12", -30)];
    const l = ledger(rows);
    // The cash rule counts the pending paycheck; `available` does not hold it.
    expect(cashRuleNet(rows)).toBe(1970);
    expect(l.net).toBe(-30);
    expect(l.excluded).toEqual({ ids: ["pay"], amount: 2000 });
    expect(l.pendingDeposits).toEqual({ ids: ["pay"], amount: 2000 });
    // Compared with `current` the rule does not apply.
    expect(ledger(rows, { bankField: "current" }).net).toBe(1970);
  });

  it("a pending deposit its posted row replaced is not pending any more: it counts once, in full", () => {
    const rows = [
      row("payP", "2026-10-12", 2000, { pending: true, description: "PAYROLL" }),
      row("payQ", "2026-10-13", 2000, { description: "PAYROLL" }),
    ];
    const l = ledger(rows);
    expect(l.net).toBe(2000);
    expect(l.pendingDeposits.ids).toEqual([]);
  });

  it("pending charges stay in (`available` holds them)", () => {
    expect(ledger([row("c", "2026-10-13", -45, { pending: true })]).net).toBe(-45);
  });

  it("⭐ rule 2: a deposit pending at the anchor's read that has since posted adds its amount", () => {
    // Pending on 10/09 at the read (not in `available`), re-keyed to posted, still dated 10/09: the cash rule holds it.
    const rows = [row("dep", "2026-10-09", 300)];
    expect(cashRuleNet(rows)).toBe(0);
    const l = ledger(rows, { anchorPendingDepositIds: new Set(["dep"]) });
    expect(l.net).toBe(300);
    expect(l.added).toEqual({ ids: ["dep"], amount: 300 });
    // Still pending: still not in `available` — nothing added.
    expect(ledger([row("dep", "2026-10-09", 300, { pending: true })], { anchorPendingDepositIds: new Set(["dep"]) }).net).toBe(0);
    // Not known to have been pending at the read: the cash rule alone.
    expect(ledger(rows).net).toBe(0);
    // A recompute adds only what the check added (a deposit that posted after the check was not in its figure).
    expect(ledger(rows, { anchorPendingDepositIds: new Set(["dep"]), addedIds: new Set() }).net).toBe(0);
  });

  it("rule 2 through a separate posted row: the held posted row that replaced the pending one", () => {
    const rows = [
      row("depP", "2026-10-08", 300, { pending: true, description: "MOBILE DEPOSIT" }),
      row("depQ", "2026-10-09", 300, { description: "MOBILE DEPOSIT" }),
    ];
    const l = ledger(rows, { anchorPendingDepositIds: new Set(["depP"]) });
    expect(l.added).toEqual({ ids: ["depQ"], amount: 300 });
    expect(l.net).toBe(300);
  });

  it("⭐ rule 3 at a recompute: a charge on the ledger at the check, re-dated by its posting, still counts; a late row is counted and said", () => {
    const rows = [
      // Pending on 10/14 at the check, posted 10/16 (re-keyed: created_at kept).
      row("tip", "2026-10-16", -55, { createdAt: new Date("2026-10-14T18:00:00Z") }),
      // A deposit that reached the ledger after the check, dated 10/13: the late row.
      row("late", "2026-10-13", 169.9, { createdAt: new Date("2026-10-15T12:00:00Z") }),
      // Created after the check and dated after its day: not the check's.
      row("next", "2026-10-15", -12, { createdAt: new Date("2026-10-15T12:00:00Z") }),
    ];
    const l = ledger(rows, { excludedIds: new Set(), addedIds: new Set() });
    expect(l.net).toBeCloseTo(-55 + 169.9, 10);
    expect(l.lateRows).toBe(1);
    // (T2) The late row is marked, so the investigation can say it arrived after the check.
    expect(l.counted).toEqual([
      { id: "tip", contribution: -55, late: false },
      { id: "late", contribution: 169.9, late: true },
    ]);
  });

  it("rule 3 through a separate posted row: the pending charge was dated on the check's day", () => {
    const rows = [
      row("cP", "2026-10-14", -48.2, { pending: true, description: "TST* CORNER BISTRO", createdAt: new Date("2026-10-14T18:00:00Z") }),
      row("cQ", "2026-10-16", -55, { description: "CORNER BISTRO", createdAt: new Date("2026-10-16T12:00:00Z") }),
    ];
    expect(ledger(rows, { excludedIds: new Set(), addedIds: new Set() }).net).toBe(-55);
  });

  it("a recompute keeps leaving out what was a pending deposit at the check, even once posted", () => {
    const rows = [row("pay", "2026-10-13", 2000)]; // posted since (re-keyed)
    expect(ledger(rows, { excludedIds: new Set(["pay"]) }).net).toBe(0);
    // A posted row that replaced it, dated after the check's day, is not the check's either.
    const pair = [row("payP", "2026-10-13", 2000, { pending: true, description: "PAYROLL" }), row("payQ", "2026-10-15", 2000, { description: "PAYROLL" })];
    expect(ledger(pair, { excludedIds: new Set(["payP"]) }).net).toBe(0);
  });
});

describe("bankBalanceCheckOf — the review's answer", () => {
  const NOW = new Date("2026-10-15T15:00:00Z");
  const base = {
    checkedAt: "2026-10-14T19:00:00.000Z",
    accountId: CHASE,
    bank: { balance: "1069.90", at: "2026-10-14T18:59:00.000Z", field: "available" as const },
    anchor: { balance: "1069.90", at: "2026-10-14T18:59:00.000Z", field: "available" as const },
  };
  const args = (over: Partial<BankBalanceCheckArgs> = {}): BankBalanceCheckArgs => ({
    record: { ...base, status: "drift", unexplained: "169.90", predicted: "900.00" },
    isForecastAccount: true,
    accountIds: [CHASE],
    now: NOW,
    currentAnchorAt: base.anchor.at,
    recompute: { predicted: 900, lateRows: 0 },
    ...over,
  });

  it("off by: the difference and which side is higher, the two figures", () => {
    expect(bankBalanceCheckOf(args())).toEqual({
      status: "off_by",
      reason: null,
      stale: false,
      staleReason: null,
      checkedAt: base.checkedAt,
      bank: { balanceCents: 106990, at: base.bank.at, field: "available" },
      h2: { balanceCents: 90000 },
      differenceCents: 16990,
      direction: "bank_higher",
      lastDrift: null,
    });
    const lower = bankBalanceCheckOf(args({ record: { ...base, status: "drift", unexplained: "-12.34", predicted: "1082.24" } }));
    expect(lower).toMatchObject({ status: "off_by", differenceCents: 1234, direction: "bank_lower" });
  });

  it("matches: no direction", () => {
    const r = bankBalanceCheckOf(args({ record: { ...base, status: "ties", unexplained: "0.00", predicted: "1069.90" } }));
    expect(r).toMatchObject({ status: "matches", differenceCents: 0, direction: null, stale: false });
  });

  it("resolved since: recomputed now it ties (late rows); off by stays while it does not", () => {
    // (T2) The late rows ARE the explanation: `rows_since` does not make a resolved check stale.
    expect(bankBalanceCheckOf(args({ recompute: { predicted: 1069.9, lateRows: 1 } }))).toMatchObject({
      status: "resolved_since",
      differenceCents: 16990,
      direction: "bank_higher",
      stale: false,
      staleReason: null,
    });
    // Still stale for its other reasons: a newer anchor, or age.
    expect(bankBalanceCheckOf(args({ currentAnchorAt: "2026-10-15T01:00:00.000Z", recompute: { predicted: 1069.9, lateRows: 1 } }))).toMatchObject({
      status: "resolved_since",
      stale: true,
      staleReason: "anchor_changed",
    });
    expect(bankBalanceCheckOf(args({ now: new Date("2026-10-21T19:00:01Z"), recompute: { predicted: 1069.9, lateRows: 1 } }))).toMatchObject({
      status: "resolved_since",
      stale: true,
      staleReason: "age",
    });
    // An off-by check with late rows that do not tie it is still out of date.
    expect(bankBalanceCheckOf(args({ recompute: { predicted: 1000, lateRows: 1 } }))).toMatchObject({
      status: "off_by",
      stale: true,
      staleReason: "rows_since",
    });
    expect(bankBalanceCheckOf(args({ recompute: { predicted: 1069.9000000001, lateRows: 1 } })).status).toBe("resolved_since");
    expect(bankBalanceCheckOf(args({ recompute: { predicted: 1000, lateRows: 1 } })).status).toBe("off_by");
    expect(bankBalanceCheckOf(args({ recompute: null })).status).toBe("off_by");
  });

  it("stale: a newer anchor first, then late rows, then age (over 7 days)", () => {
    expect(bankBalanceCheckOf(args({ currentAnchorAt: "2026-10-15T01:00:00.000Z", recompute: { predicted: 900, lateRows: 2 } }))).toMatchObject({
      stale: true,
      staleReason: "anchor_changed",
    });
    expect(bankBalanceCheckOf(args({ now: new Date("2026-10-21T19:00:01Z") }))).toMatchObject({ stale: true, staleReason: "age" });
    expect(bankBalanceCheckOf(args({ now: new Date("2026-10-21T18:59:59Z") }))).toMatchObject({ stale: false, staleReason: null });
  });

  it("(Final #13) the same anchor written another way is the same anchor: moments compare, not strings", () => {
    const ties = { ...base, status: "ties" as const, unexplained: "0.00", predicted: "1069.90" };
    // The check read "…T13:59:00-05:00"; the settings hold the same moment in Z form (and back).
    const offset = { ...ties, anchor: { ...ties.anchor, at: "2026-10-14T13:59:00-05:00" } };
    expect(bankBalanceCheckOf(args({ record: offset, currentAnchorAt: "2026-10-14T18:59:00.000Z" }))).toMatchObject({
      status: "matches",
      stale: false,
      staleReason: null,
    });
    expect(bankBalanceCheckOf(args({ record: ties, currentAnchorAt: "2026-10-14T13:59:00-05:00" }))).toMatchObject({ stale: false, staleReason: null });
    // A different moment in the offset form is still a newer anchor.
    expect(bankBalanceCheckOf(args({ record: offset, currentAnchorAt: "2026-10-14T19:59:00.000Z" }))).toMatchObject({
      stale: true,
      staleReason: "anchor_changed",
    });
    // No anchor now: changed. A time that does not parse compares as written.
    expect(bankBalanceCheckOf(args({ record: ties, currentAnchorAt: null }))).toMatchObject({ stale: true, staleReason: "anchor_changed" });
    expect(sameAnchorMoment("not a time", "not a time")).toBe(true);
    expect(sameAnchorMoment("not a time", "2026-10-14T18:59:00.000Z")).toBe(false);
    expect(sameAnchorMoment("2026-10-14T18:59:00.000Z", "2026-10-14T18:59:00Z")).toBe(true);
  });

  it("not checked: never, another account, the forecast account changed, and the Sync's own reasons", () => {
    expect(bankBalanceCheckOf(args({ record: null }))).toMatchObject({ status: "not_checked", reason: "never", checkedAt: null, bank: null });
    expect(bankBalanceCheckOf(args({ isForecastAccount: false }))).toMatchObject({ status: "not_checked", reason: "not_forecast_account" });
    expect(bankBalanceCheckOf(args({ accountIds: ["new-ext"] }))).toMatchObject({ status: "not_checked", reason: "never" });
    const tooOld = bankBalanceCheckOf(args({ record: { ...base, status: "not_checked", reason: "anchor_too_old", unexplained: null } }));
    expect(tooOld).toMatchObject({ status: "not_checked", reason: "anchor_too_old", checkedAt: base.checkedAt, h2: null, differenceCents: null, direction: null });
    expect(tooOld.bank).toMatchObject({ balanceCents: 106990 });
    const noBalance = bankBalanceCheckOf(
      args({ record: { ...base, bank: null, status: "not_checked", reason: "balance_unavailable", unexplained: null }, now: new Date("2026-10-30T00:00:00Z") }),
    );
    expect(noBalance).toMatchObject({ status: "not_checked", reason: "balance_unavailable", bank: null, stale: true, staleReason: "age" });
  });

  it("a record written before F3 (four fields) still reads: off by, no figures to compare", () => {
    const r = bankBalanceCheckOf(
      args({ record: { checkedAt: base.checkedAt, accountId: CHASE, unexplained: "-12.34", status: "drift" }, recompute: null }),
    );
    expect(r).toMatchObject({ status: "off_by", bank: null, h2: null, differenceCents: 1234, direction: "bank_lower", stale: false });
  });

  it("the last earlier drift is kept beside a later check", () => {
    const r = bankBalanceCheckOf(
      args({
        record: {
          ...base,
          status: "ties",
          unexplained: "0.00",
          predicted: "1069.90",
          lastDrift: { checkedAt: "2026-10-10T15:00:00.000Z", accountId: CHASE, unexplained: "169.90" },
        },
      }),
    );
    expect(r.status).toBe("matches");
    expect(r.lastDrift).toEqual({ checkedAt: "2026-10-10T15:00:00.000Z", differenceCents: 16990, direction: "bank_higher" });
  });
});
