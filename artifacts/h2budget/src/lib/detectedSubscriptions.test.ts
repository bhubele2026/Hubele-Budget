import { describe, it, expect } from "vitest";
import { detectSubscriptionsFromTransactions } from "./detectedSubscriptions";
import type { Transaction } from "@workspace/api-client-react";

function tx(
  date: string,
  amount: string,
  displayName: string,
  extra: Partial<Transaction> = {},
): Transaction {
  return {
    id: `${displayName}-${date}`,
    occurredOn: date,
    amount,
    description: displayName,
    displayName,
    isTransfer: false,
    ...extra,
  } as Transaction;
}

describe("detectSubscriptionsFromTransactions", () => {
  it("detects a steady monthly charge as a high-confidence subscription", () => {
    const txns = [
      tx("2026-01-05", "-17.99", "Netflix"),
      tx("2026-02-05", "-17.99", "Netflix"),
      tx("2026-03-05", "-17.99", "Netflix"),
      tx("2026-04-05", "-17.99", "Netflix"),
      tx("2026-05-05", "-17.99", "Netflix"),
      tx("2026-06-05", "-17.99", "Netflix"),
    ];
    const out = detectSubscriptionsFromTransactions(txns);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      merchant: "Netflix",
      cadence: "monthly",
      typical: 17.99,
      annual: 215.88,
      count: 6,
      confidence: "high",
    });
  });

  it("ignores variable everyday spend (groceries) — no steady amount/cadence", () => {
    const txns = [
      tx("2026-04-02", "-52.10", "Aldi"),
      tx("2026-04-19", "-127.84", "Aldi"),
      tx("2026-05-03", "-33.50", "Aldi"),
      tx("2026-05-27", "-96.00", "Aldi"),
    ];
    expect(detectSubscriptionsFromTransactions(txns)).toHaveLength(0);
  });

  it("skips transfers and income", () => {
    const txns = [
      tx("2026-04-01", "-15.00", "Hulu", { isTransfer: true }),
      tx("2026-05-01", "-15.00", "Hulu", { isTransfer: true }),
      tx("2026-04-15", "2500.00", "Payroll"),
      tx("2026-05-15", "2500.00", "Payroll"),
    ];
    expect(detectSubscriptionsFromTransactions(txns)).toHaveLength(0);
  });

  it("still detects a subscription through a price change, flagging amountVaries", () => {
    const txns = [
      tx("2026-03-10", "-9.99", "Spotify"),
      tx("2026-04-10", "-9.99", "Spotify"),
      tx("2026-05-10", "-14.99", "Spotify"),
      tx("2026-06-10", "-14.99", "Spotify"),
    ];
    const out = detectSubscriptionsFromTransactions(txns);
    expect(out).toHaveLength(1);
    expect(out[0].merchant).toBe("Spotify");
    expect(out[0].cadence).toBe("monthly");
    expect(out[0].amountVaries).toBe(true);
  });
});
