import { describe, it, expect } from "vitest";
import {
  dashboardSourceLabel,
  detectChipSources,
  isTxnInBucket,
  nonAmexSourceLabel,
} from "./dashboard";
import type { Transaction } from "@workspace/api-client-react";

describe("nonAmexSourceLabel — WK/MO/UN row source badge (#28)", () => {
  it("returns null for Amex-flavored sources so the badge stays hidden by default", () => {
    expect(nonAmexSourceLabel("amex")).toBeNull();
    expect(nonAmexSourceLabel("plaid:amex")).toBeNull();
    expect(nonAmexSourceLabel("AMEX")).toBeNull();
    expect(nonAmexSourceLabel(null)).toBeNull();
    expect(nonAmexSourceLabel(undefined)).toBeNull();
    expect(nonAmexSourceLabel("")).toBeNull();
  });

  it("strips the `plaid:` prefix so the badge reads as the bank name", () => {
    expect(nonAmexSourceLabel("plaid:chase")).toBe("chase");
    expect(nonAmexSourceLabel("plaid:capitalone")).toBe("capitalone");
    expect(nonAmexSourceLabel("plaid:bank")).toBe("bank");
  });

  it("passes manual / non-Plaid sources through verbatim (lowercased)", () => {
    expect(nonAmexSourceLabel("manual")).toBe("manual");
    expect(nonAmexSourceLabel("Manual")).toBe("manual");
    expect(nonAmexSourceLabel("cash")).toBe("cash");
  });
});

describe("dashboardSourceLabel — chip label for any tagged source (#278)", () => {
  it("normalizes Amex-flavored sources to a single 'amex' chip", () => {
    expect(dashboardSourceLabel("amex")).toBe("amex");
    expect(dashboardSourceLabel("plaid:amex")).toBe("amex");
    expect(dashboardSourceLabel("AMEX")).toBe("amex");
  });

  it("strips the plaid: prefix for other banks and lowercases manual", () => {
    expect(dashboardSourceLabel("plaid:chase")).toBe("chase");
    expect(dashboardSourceLabel("Manual")).toBe("manual");
  });

  it("falls back to 'unknown' for missing sources rather than dropping the row", () => {
    expect(dashboardSourceLabel(null)).toBe("unknown");
    expect(dashboardSourceLabel(undefined)).toBe("unknown");
    expect(dashboardSourceLabel("")).toBe("unknown");
  });
});

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: "t",
    occurredOn: "2025-05-10",
    description: "x",
    amount: "-1",
    source: "amex",
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    isTransfer: false,
    isExternalCardPayment: false,
    ...over,
  } as Transaction;
}

describe("detectChipSources — chip row above WK/MO/UN buckets (#278)", () => {
  const start = "2025-05-01";
  const end = "2025-05-31";

  it("collects every distinct source from tagged in-month transactions", () => {
    const out = detectChipSources(
      [
        tx({ id: "1", source: "amex", weeklyAllowance: true }),
        tx({ id: "2", source: "plaid:chase", monthlyAllowance: true }),
        tx({ id: "3", source: "manual", unplannedAllowance: true }),
      ],
      start,
      end,
    );
    expect(out).toEqual(["amex", "chase", "manual"]);
  });

  it("ignores untagged or out-of-month transactions so the chip row stays clean", () => {
    const out = detectChipSources(
      [
        tx({ id: "1", source: "plaid:chase" }), // untagged
        tx({ id: "2", source: "manual", weeklyAllowance: true, occurredOn: "2025-04-30" }),
        tx({ id: "3", source: "amex", weeklyAllowance: true }),
      ],
      start,
      end,
    );
    expect(out).toEqual(["amex"]);
  });

  it("keeps 'amex' first then alphabetical so the chip order is stable", () => {
    const out = detectChipSources(
      [
        tx({ id: "1", source: "manual", weeklyAllowance: true }),
        tx({ id: "2", source: "plaid:chase", weeklyAllowance: true }),
        tx({ id: "3", source: "amex", weeklyAllowance: true }),
      ],
      start,
      end,
    );
    expect(out).toEqual(["amex", "chase", "manual"]);
  });
});

describe("isTxnInBucket — Unplanned excludes forecast-resolved transfers (#631)", () => {
  it("includes a non-transfer txn that is in the bucket via a forecast Unplanned resolution", () => {
    const t = tx({ id: "n", isTransfer: false });
    expect(isTxnInBucket(t, "unplanned", new Set(["n"]))).toBe(true);
  });

  it("excludes a transfer that only landed in Unplanned via a forecast resolution", () => {
    const t = tx({
      id: "x",
      description: "ONLINE TRANSFER FROM SAV ...9128",
      isTransfer: true,
    });
    expect(isTxnInBucket(t, "unplanned", new Set(["x"]))).toBe(false);
  });

  // (#632) Stricter than #631: a transfer-classified row is excluded
  // from every bucket regardless of allowance flags. The user can
  // still force the row into a bucket by clearing isTransfer first
  // (which sets isTransferUserOverridden=true).
  it("excludes a transfer from Unplanned even when unplannedAllowance is set", () => {
    const t = tx({ id: "x", isTransfer: true, unplannedAllowance: true });
    expect(isTxnInBucket(t, "unplanned", new Set(["x"]))).toBe(false);
  });

  it("excludes a transfer from Monthly even when monthlyAllowance is set", () => {
    const t = tx({ id: "m", monthlyAllowance: true, isTransfer: true });
    expect(isTxnInBucket(t, "monthly", new Set(["m"]))).toBe(false);
    const u = tx({ id: "u", isTransfer: false });
    expect(isTxnInBucket(u, "monthly", new Set(["u"]))).toBe(false);
  });

  // (#632 follow-up) The new per-row "Not in avalanche" toggle is a
  // belt-and-suspenders second short-circuit so an external card
  // payment is never real spend regardless of which flag put it in
  // the bucket.
  it("excludes a row marked isExternalCardPayment from Unplanned", () => {
    const t = tx({
      id: "e",
      isExternalCardPayment: true,
      unplannedAllowance: true,
    });
    expect(isTxnInBucket(t, "unplanned", new Set(["e"]))).toBe(false);
  });

  it("excludes a row marked isExternalCardPayment from Monthly", () => {
    const t = tx({
      id: "e",
      isExternalCardPayment: true,
      monthlyAllowance: true,
    });
    expect(isTxnInBucket(t, "monthly")).toBe(false);
  });
});

describe("detectChipSources — transfers don't surface a chip via forecast resolutions (#631)", () => {
  const start = "2025-05-01";
  const end = "2025-05-31";

  it("excludes a chase chip when the only chase row is a transfer marked Unplanned in the inbox", () => {
    const out = detectChipSources(
      [
        tx({
          id: "x",
          source: "plaid:chase",
          description: "ONLINE TRANSFER FROM SAV ...9128",
          isTransfer: true,
        }),
        tx({ id: "y", source: "amex", weeklyAllowance: true }),
      ],
      start,
      end,
      new Set(["x"]),
    );
    expect(out).toEqual(["amex"]);
  });

  it("still surfaces a chip for a non-transfer txn marked Unplanned in the inbox", () => {
    const out = detectChipSources(
      [
        tx({ id: "n", source: "plaid:chase", isTransfer: false }),
      ],
      start,
      end,
      new Set(["n"]),
    );
    expect(out).toEqual(["chase"]);
  });

  // (#632) Stricter than #631: a transfer is dropped from chip sources
  // regardless of how it got tagged — explicit unplannedAllowance no
  // longer keeps it on the chip row, since the bucket filter would
  // exclude it anyway and the chip would lead to an empty roll-up.
  it("drops the chip when the only matching row is a transfer, even with explicit unplannedAllowance", () => {
    const out = detectChipSources(
      [
        tx({
          id: "x",
          source: "plaid:chase",
          isTransfer: true,
          unplannedAllowance: true,
        }),
      ],
      start,
      end,
      new Set(["x"]),
    );
    expect(out).toEqual([]);
  });
});
