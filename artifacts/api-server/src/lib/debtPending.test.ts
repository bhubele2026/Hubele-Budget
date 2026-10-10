import { describe, it, expect } from "vitest";
import {
  balanceAsOfForDebt,
  debtIdForSyncedRow,
  pendingFromRows,
  type DebtRow,
  type PendingRowInput,
} from "./debtPending";

// ⭐ (WP2) THE PENDING RULE: a tagged row is "paid, not posted" when it pays the
// debt down (positive; a feed row must read as a payment), is not the bank row
// that confirmed a claim, and is dated AFTER the household day of the balance's
// as-of. One row per clause below.

const DEBT = "debt-plat";
const AS_OF_DAY = "2026-10-09";
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;

const row = (o: Partial<PendingRowInput> = {}): PendingRowInput => ({
  debtId: DEBT,
  amount: "2615.71",
  occurredOn: day(10),
  source: "plaid:amex",
  plaidTransactionId: "ptx-1",
  description: "ONLINE PAYMENT - THANK YOU",
  pfcPrimary: null,
  pfcDetailed: null,
  isExternalCardPayment: null,
  confirmsClaim: false,
  ...o,
});
const asOf = new Map([[DEBT, AS_OF_DAY]]);
const pendingOf = (rows: PendingRowInput[], m: ReadonlyMap<string, string | null> = asOf) => pendingFromRows(rows, m).get(DEBT) ?? null;

describe("pendingFromRows — the day rule", () => {
  it("⭐ a payment dated ON the as-of day is in the balance (Brad's Platinum: it was subtracted twice)", () => {
    expect(pendingOf([row({ occurredOn: AS_OF_DAY })])).toBeNull();
  });
  it("a payment dated the day AFTER the as-of day is pending", () => {
    expect(pendingOf([row({ occurredOn: day(10) })])).toEqual({ total: 2615.71, count: 1 });
  });
  it("a payment dated before the as-of day is in the balance", () => {
    expect(pendingOf([row({ occurredOn: day(8) })])).toBeNull();
  });
  it("no as-of (the balance was never read): every payment counts", () => {
    expect(pendingOf([row({ occurredOn: day(1) })], new Map([[DEBT, null]]))).toEqual({ total: 2615.71, count: 1 });
  });
});

describe("pendingFromRows — the shape rule", () => {
  it("a feed REFUND on the card is not a payment, even when the sync tagged it", () => {
    expect(pendingOf([row({ amount: "54.19", description: "TARGET T-1123 REFUND" })])).toBeNull();
  });
  it("a feed statement credit is not a payment", () => {
    expect(pendingOf([row({ amount: "25.00", description: "PLATINUM DINING CREDIT" })])).toBeNull();
  });
  it("a feed payment by its words counts", () => {
    expect(pendingOf([row({ description: "AUTOPAY PAYMENT RECEIVED" })])?.count).toBe(1);
  });
  it("a feed payment by Plaid's category counts, whatever its words", () => {
    expect(pendingOf([row({ description: "ACH CREDIT 0042", pfcPrimary: "LOAN_PAYMENTS" })])?.count).toBe(1);
  });
  it("a feed row the household marked as a card payment counts", () => {
    expect(pendingOf([row({ description: "TRANSFER 0042", isExternalCardPayment: true })])?.count).toBe(1);
  });
  it("a row the household typed in keeps counting: tagging it says it paid the debt", () => {
    const manual = { source: "manual", plaidTransactionId: null };
    expect(pendingOf([row({ ...manual, description: "Chase payment to Visa" })])?.count).toBe(1);
    expect(pendingOf([row({ ...manual, description: "returned item" })])?.count).toBe(1);
  });
  it("(WP2 review) a typed row a sync merge ADOPTED is still the household's: it counts whatever its words", () => {
    // The first-sync merge gave it Plaid's id and source but kept the typed words.
    const adopted = { source: "plaid:amex", plaidTransactionId: "ptx-merged", description: "Blue card" };
    expect(pendingOf([row({ ...adopted, adoptedFromHousehold: true })])?.count).toBe(1);
    // Without the stamp the same row would read as a feed credit.
    expect(pendingOf([row({ ...adopted, adoptedFromHousehold: false })])).toBeNull();
  });
  it("a workbook (amex) positive row is a CHARGE in that ledger, never a payment", () => {
    expect(pendingOf([row({ source: "amex", plaidTransactionId: null, description: "DELTA AIR LINES" })])).toBeNull();
  });
  it("money out (a purchase, or a claim / checking payment written negative) never counts", () => {
    expect(pendingOf([row({ amount: "-80.00", description: "DELTA AIR LINES" })])).toBeNull();
    expect(pendingOf([row({ amount: "-300.00", source: "manual", plaidTransactionId: null, description: "Payment — Visa" })])).toBeNull();
  });
});

describe("pendingFromRows — the claim rule and the totals", () => {
  it("the bank row that confirmed a payment claim never counts again", () => {
    expect(pendingOf([row({ confirmsClaim: true })])).toBeNull();
    expect(pendingOf([row({ confirmsClaim: true, source: "manual", plaidTransactionId: null })])).toBeNull();
  });
  it("sums only the rows that pass, per debt, and ignores debts it was not asked about", () => {
    const m = new Map<string, string | null>([[DEBT, AS_OF_DAY], ["debt-blue", null]]);
    const out = pendingFromRows(
      [
        row({ amount: "200.00", plaidTransactionId: "a" }),
        row({ amount: "50.00", plaidTransactionId: "b", occurredOn: day(11) }),
        row({ amount: "54.19", plaidTransactionId: "c", description: "TARGET REFUND" }),
        row({ amount: "75.00", plaidTransactionId: "d", occurredOn: AS_OF_DAY }),
        row({ debtId: "debt-blue", amount: "40.00", plaidTransactionId: "e" }),
        row({ debtId: "debt-other", amount: "999.00", plaidTransactionId: "f" }),
      ],
      m,
    );
    expect(out.get(DEBT)).toEqual({ total: 250, count: 2 });
    expect(out.get("debt-blue")).toEqual({ total: 40, count: 1 });
    expect(out.has("debt-other")).toBe(false);
  });
});

describe("balanceAsOfForDebt — when the balance was read", () => {
  const base = {
    id: DEBT,
    balanceSource: "plaid",
    plaidAccountId: "acct-row",
    plaidLastSyncedAt: new Date("2026-10-09T13:00:00Z"),
    lastBalanceUpdate: new Date("2026-10-01T13:00:00Z"),
  } as unknown as DebtRow;
  it("a Plaid-sourced linked debt: the later of the liability fetch and the last Plaid refresh", () => {
    expect(balanceAsOfForDebt(base, new Date("2026-10-09T15:00:00Z"))?.toISOString()).toBe("2026-10-09T15:00:00.000Z");
    expect(balanceAsOfForDebt(base, new Date("2026-10-08T15:00:00Z"))?.toISOString()).toBe("2026-10-09T13:00:00.000Z");
    expect(balanceAsOfForDebt({ ...base, plaidLastSyncedAt: null }, new Date("2026-10-08T15:00:00Z"))?.toISOString()).toBe(
      "2026-10-08T15:00:00.000Z",
    );
    expect(balanceAsOfForDebt({ ...base, plaidLastSyncedAt: null }, null)).toBeNull();
  });
  it("a manual balance (or a linked debt the household overrode): when it was last written", () => {
    expect(balanceAsOfForDebt({ ...base, balanceSource: "manual" }, new Date("2026-10-09T15:00:00Z"))?.toISOString()).toBe(
      "2026-10-01T13:00:00.000Z",
    );
    expect(balanceAsOfForDebt({ ...base, plaidAccountId: null }, null)?.toISOString()).toBe("2026-10-01T13:00:00.000Z");
    expect(balanceAsOfForDebt({ ...base, balanceSource: "manual", lastBalanceUpdate: null }, null)).toBeNull();
  });
});

describe("debtIdForSyncedRow — the sync tags payments only", () => {
  const r = (o: Partial<Parameters<typeof debtIdForSyncedRow>[1]> = {}) => ({
    source: "plaid:amex",
    amount: "500.00",
    description: "ONLINE PAYMENT - THANK YOU",
    pfcPrimary: null,
    pfcDetailed: null,
    ...o,
  });
  it("a payment on a debt-linked card is tagged to the debt", () => {
    expect(debtIdForSyncedRow(DEBT, r())).toBe(DEBT);
    expect(debtIdForSyncedRow(DEBT, r({ description: "ACH CREDIT", pfcPrimary: "LOAN_PAYMENTS" }))).toBe(DEBT);
  });
  it("a refund, a credit, a purchase or a zero row is not", () => {
    expect(debtIdForSyncedRow(DEBT, r({ amount: "54.19", description: "TARGET T-1123 REFUND" }))).toBeNull();
    expect(debtIdForSyncedRow(DEBT, r({ amount: "25.00", description: "PLATINUM DINING CREDIT" }))).toBeNull();
    expect(debtIdForSyncedRow(DEBT, r({ amount: "-200.00", description: "DELTA AIR LINES" }))).toBeNull();
    expect(debtIdForSyncedRow(DEBT, r({ amount: "0.00" }))).toBeNull();
  });
  it("no linked debt, no tag", () => {
    expect(debtIdForSyncedRow(null, r())).toBeNull();
  });
});
