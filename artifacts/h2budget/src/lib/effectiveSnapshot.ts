// (#429) Pure helper that derives the per-account "effective snapshot"
// rendered by the Chase Transactions page. Extracted from
// `pages/transactions.tsx` so we can unit-test the
// post-dedupe fallback without booting the full page.
//
// Resolution order:
//   1. If the user is viewing the bank-snapshot's primary account,
//      the legacy `bankSnapshot` row wins (this matches the
//      pre-#429 behavior and keeps the snapshot meta line stable).
//   2. Otherwise, look up the per-account entry in `accountSnapshots`
//      keyed by the selected `plaid_accounts.id`.
//   3. If neither resolves AND the selected account is a real linked
//      Plaid checking account whose (institutionName, mask) matches
//      the bank-snapshot's account, fall back to `bankSnapshot`.
//      This is the post-dedupe safety net: when a survivor row's id
//      is briefly missing from `accountSnapshots` we keep the
//      Starting / Ending balance tiles populated instead of falling
//      through to the "Unavailable" placeholder.
//   4. Otherwise return null (Manual accounts, no snapshot available).

export type EffectiveSnapshotEntry = {
  balance: string;
  at: string;
  source: "manual" | "plaid";
  name: string | null;
  mask: string | null;
};

// Inputs accept `undefined` for nullable fields too — the generated
// API client types model optional fields as `T | null | undefined`,
// while the persisted snapshot entries use `T | null`. Both shapes
// flow through this helper.
export type BankSnapshotInput = {
  balance: string;
  at: string;
  source: "manual" | "plaid";
  accountId?: string | null;
  name?: string | null;
  mask?: string | null;
} | null;

type AccountSnapshotInputEntry = {
  balance: string;
  at: string;
  source: "manual" | "plaid";
  name?: string | null;
  mask?: string | null;
};

export type PlaidCheckingAccount = {
  id: string;
  mask?: string | null;
  institutionName?: string | null;
};

export function deriveEffectiveSnapshot(args: {
  bankSnapshot: BankSnapshotInput;
  accountSnapshots: Record<string, AccountSnapshotInputEntry>;
  selectedAccountInternalId: string | null;
  plaidCheckingAccounts: readonly PlaidCheckingAccount[];
}): EffectiveSnapshotEntry | null {
  const {
    bankSnapshot,
    accountSnapshots,
    selectedAccountInternalId,
    plaidCheckingAccounts,
  } = args;

  // The "snapshot account" the primary bankSnapshot anchors. For a
  // Plaid-backed snapshot this is the linked account's internal id;
  // for a Manual snapshot this is the synthetic "manual" key, which
  // we represent as `null` (matching `effectiveAccountInternalId`'s
  // null-when-manual convention in the page).
  const bankSnapshotKey = bankSnapshot
    ? (bankSnapshot.accountId ?? null)
    : undefined;
  const usingSnapshotAccount =
    !!bankSnapshot && selectedAccountInternalId === bankSnapshotKey;
  if (usingSnapshotAccount && bankSnapshot) {
    return {
      balance: bankSnapshot.balance,
      at: bankSnapshot.at,
      source: bankSnapshot.source,
      name: bankSnapshot.name ?? null,
      mask: bankSnapshot.mask ?? null,
    };
  }

  // Manual accounts (no Plaid id) past this point have no anchor.
  if (!selectedAccountInternalId) return null;

  const direct = accountSnapshots[selectedAccountInternalId];
  if (direct) {
    return {
      balance: direct.balance,
      at: direct.at,
      source: direct.source,
      name: direct.name ?? null,
      mask: direct.mask ?? null,
    };
  }

  // Post-dedupe fallback: survivor row is briefly missing from
  // accountSnapshots but matches the primary bank snapshot by
  // (institutionName, mask). Keep the tiles populated.
  if (!bankSnapshot || !bankSnapshot.accountId) return null;
  const selectedAcct = plaidCheckingAccounts.find(
    (a) => a.id === selectedAccountInternalId,
  );
  const snapshotAcct = plaidCheckingAccounts.find(
    (a) => a.id === bankSnapshot.accountId,
  );
  if (!selectedAcct || !snapshotAcct) return null;
  const sameMask =
    !!selectedAcct.mask &&
    !!snapshotAcct.mask &&
    selectedAcct.mask.toLowerCase() === snapshotAcct.mask.toLowerCase();
  const selInst = (selectedAcct.institutionName ?? "").toLowerCase();
  const snapInst = (snapshotAcct.institutionName ?? "").toLowerCase();
  const sameInstitution =
    selInst.length > 0 && snapInst.length > 0 && selInst === snapInst;
  if (sameMask && sameInstitution) {
    return {
      balance: bankSnapshot.balance,
      at: bankSnapshot.at,
      source: bankSnapshot.source,
      name: bankSnapshot.name ?? null,
      mask: bankSnapshot.mask ?? null,
    };
  }
  return null;
}
