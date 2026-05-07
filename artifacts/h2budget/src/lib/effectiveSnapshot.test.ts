import { describe, it, expect } from "vitest";
import {
  deriveEffectiveSnapshot,
  type BankSnapshotInput,
  type EffectiveSnapshotEntry,
  type PlaidCheckingAccount,
} from "./effectiveSnapshot";

const PRIMARY_ID = "primary-acct-id";
const SURVIVOR_ID = "survivor-acct-id";

const PRIMARY_BANK_SNAPSHOT: BankSnapshotInput = {
  balance: "1234.56",
  at: "2026-04-30T12:00:00.000Z",
  source: "plaid",
  accountId: PRIMARY_ID,
  name: "Chase Total Checking",
  mask: "5526",
};

const PRIMARY_ACCT: PlaidCheckingAccount = {
  id: PRIMARY_ID,
  mask: "5526",
  institutionName: "Chase",
};
const SURVIVOR_ACCT: PlaidCheckingAccount = {
  id: SURVIVOR_ID,
  mask: "5526",
  institutionName: "Chase",
};

describe("deriveEffectiveSnapshot (#429)", () => {
  it("returns null for a Manual account (no plaid id selected)", () => {
    expect(
      deriveEffectiveSnapshot({
        bankSnapshot: PRIMARY_BANK_SNAPSHOT,
        accountSnapshots: {},
        selectedAccountInternalId: null,
        plaidCheckingAccounts: [PRIMARY_ACCT],
      }),
    ).toBeNull();
  });

  it("returns the bank snapshot when the user is on the snapshot account", () => {
    const out = deriveEffectiveSnapshot({
      bankSnapshot: PRIMARY_BANK_SNAPSHOT,
      accountSnapshots: {},
      selectedAccountInternalId: PRIMARY_ID,
      plaidCheckingAccounts: [PRIMARY_ACCT],
    });
    expect(out?.balance).toBe("1234.56");
    expect(out?.source).toBe("plaid");
  });

  it("returns the per-account entry when the selected account has one", () => {
    const entry: EffectiveSnapshotEntry = {
      balance: "987.65",
      at: "2026-05-01T12:00:00.000Z",
      source: "plaid",
      name: "Joint Checking",
      mask: "2222",
    };
    const out = deriveEffectiveSnapshot({
      bankSnapshot: PRIMARY_BANK_SNAPSHOT,
      accountSnapshots: { "joint-id": entry },
      selectedAccountInternalId: "joint-id",
      plaidCheckingAccounts: [
        PRIMARY_ACCT,
        { id: "joint-id", mask: "2222", institutionName: "Chase" },
      ],
    });
    expect(out).toEqual(entry);
  });

  it("falls back to the primary bank snapshot when survivor id is missing from accountSnapshots but (institutionName, mask) match", () => {
    // This is the post-dedupe scenario from #429: the user's loser id
    // was repointed onto SURVIVOR_ID, but that key is not (yet) in
    // accountSnapshots. Without the fallback, the Chase page would
    // render the "Unavailable" placeholder for Starting/Ending tiles.
    const out = deriveEffectiveSnapshot({
      bankSnapshot: PRIMARY_BANK_SNAPSHOT,
      accountSnapshots: {},
      selectedAccountInternalId: SURVIVOR_ID,
      plaidCheckingAccounts: [PRIMARY_ACCT, SURVIVOR_ACCT],
    });
    expect(out).not.toBeNull();
    expect(out?.balance).toBe("1234.56");
    expect(out?.source).toBe("plaid");
    expect(out?.mask).toBe("5526");
  });

  it("does NOT fall back when the selected account's mask differs", () => {
    const out = deriveEffectiveSnapshot({
      bankSnapshot: PRIMARY_BANK_SNAPSHOT,
      accountSnapshots: {},
      selectedAccountInternalId: SURVIVOR_ID,
      plaidCheckingAccounts: [
        PRIMARY_ACCT,
        { id: SURVIVOR_ID, mask: "9999", institutionName: "Chase" },
      ],
    });
    expect(out).toBeNull();
  });

  it("does NOT fall back when the selected account is at a different institution", () => {
    const out = deriveEffectiveSnapshot({
      bankSnapshot: PRIMARY_BANK_SNAPSHOT,
      accountSnapshots: {},
      selectedAccountInternalId: SURVIVOR_ID,
      plaidCheckingAccounts: [
        PRIMARY_ACCT,
        { id: SURVIVOR_ID, mask: "5526", institutionName: "BofA" },
      ],
    });
    expect(out).toBeNull();
  });

  it("does NOT fall back when there is no primary bank snapshot", () => {
    const out = deriveEffectiveSnapshot({
      bankSnapshot: null,
      accountSnapshots: {},
      selectedAccountInternalId: SURVIVOR_ID,
      plaidCheckingAccounts: [SURVIVOR_ACCT],
    });
    expect(out).toBeNull();
  });

  it("returns a Manual bank snapshot (accountId=null) when viewing the Manual account", () => {
    // Regression for the #429 refactor: the original page wired the
    // Manual snapshot through `usingSnapshotAccount`, which evaluated
    // true when on the synthetic "manual" key. The helper must keep
    // that behavior so the BankSnapshotFreshness "Set manually …" meta
    // line still renders on the Transactions Manual view (#333).
    const manualSnap: BankSnapshotInput = {
      balance: "100.00",
      at: "2026-04-30T12:00:00.000Z",
      source: "manual",
      accountId: null,
      name: null,
      mask: null,
    };
    const out = deriveEffectiveSnapshot({
      bankSnapshot: manualSnap,
      accountSnapshots: {},
      selectedAccountInternalId: null,
      plaidCheckingAccounts: [],
    });
    expect(out?.balance).toBe("100.00");
    expect(out?.source).toBe("manual");
  });

  it("prefers the per-account entry over the (institutionName, mask) fallback", () => {
    const entry: EffectiveSnapshotEntry = {
      balance: "42.00",
      at: "2026-05-02T00:00:00.000Z",
      source: "manual",
      name: "Survivor",
      mask: "5526",
    };
    const out = deriveEffectiveSnapshot({
      bankSnapshot: PRIMARY_BANK_SNAPSHOT,
      accountSnapshots: { [SURVIVOR_ID]: entry },
      selectedAccountInternalId: SURVIVOR_ID,
      plaidCheckingAccounts: [PRIMARY_ACCT, SURVIVOR_ACCT],
    });
    expect(out?.balance).toBe("42.00");
  });
});
