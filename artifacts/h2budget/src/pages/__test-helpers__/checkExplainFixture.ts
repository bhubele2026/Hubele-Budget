import type { BankingCheckExplain } from "@workspace/api-client-react/features";

/**
 * (T2) The owner's balance check, synthetic: the previous reading $432.00
 * (Oct 14, 7:00 AM), the Sync read $0.00 (Oct 15, 7:02 AM), H2 expected $432.00
 * and re-anchored to the bank — off by $432.00, bank lower, nothing explains it.
 */
export const T1 = "2026-10-14T12:00:00.000Z"; // Oct 14, 7:00 AM Chicago
export const T2 = "2026-10-15T12:02:00.000Z"; // Oct 15, 7:02 AM Chicago

export function ownerExplain(over: Partial<BankingCheckExplain> = {}): BankingCheckExplain {
  return {
    dataAsOf: { snapshotAt: T2, computedAt: "2026-10-15T14:00:00.000Z" },
    account: { externalId: "ext-1", institution: "Sample Bank", name: "Everyday Checking", mask: "0001" },
    check: {
      status: "off_by",
      reason: null,
      stale: false,
      staleReason: null,
      checkedAt: T2,
      bank: { balance: "0.00", at: T2, field: "available" },
      h2: { balance: "432.00" },
      difference: "432.00",
      direction: "bank_lower",
      lastDrift: null,
    },
    record: {
      checkedAt: T2,
      status: "drift",
      reason: null,
      prevAnchor: { balance: "432.00", at: T1, field: "available" },
      bank: { balance: "0.00", at: T2, field: "available" },
      anchor: { balance: "0.00", at: T2, field: "available" },
      predicted: "432.00",
      unexplained: "-432.00",
      fieldChanged: false,
    },
    counted: { listed: true, rowCount: 0, net: "0.00", addsUp: true, rows: [] },
    excluded: { amount: "0.00", rows: [] },
    added: { amount: "0.00", rows: [] },
    manualRows: { amount: "0.00", rows: [] },
    rowsSince: { count: 0, rows: [] },
    today: { h2Balance: "0.00", bankReading: "0.00", bankAsOf: T2, sameMoment: true },
    verdict: "unknown",
    ...over,
  };
}

