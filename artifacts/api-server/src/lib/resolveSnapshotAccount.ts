import { eq } from "drizzle-orm";
import { db, plaidAccountsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * ⭐ WHICH ACCOUNT IS "THE BANK BALANCE"? One answer, shared by everything.
 *
 * `forecast_settings.bank_snapshot_account_id` is a pointer into
 * `plaid_accounts`, and two very ordinary events leave it useless:
 *
 *   - it was never set (the snapshot was typed in by hand), or
 *   - the row it names has been retired — exactly what the re-link dedupe does
 *     to a duplicate account.
 *
 * A null here is not a small thing. It is the input to BOTH halves of the bank
 * balance: `cashSignal.isBankRow` uses it to decide which ledger rows are
 * "bank" rows (null ⇒ none of them, so the balance freezes at the raw
 * snapshot), and `plaidSync` uses it to decide whether to re-anchor the
 * snapshot from Plaid (null ⇒ it doesn't, so pressing Sync cannot break the
 * freeze). Silently, on every screen at once.
 *
 * So when the pointer does not resolve, recover the account from what the
 * snapshot itself still remembers, in descending order of certainty. ⚠️ Every
 * step must identify the account UNIQUELY. A wrong guess here puts a
 * confidently wrong balance in front of someone making decisions with it,
 * which is worse than an obviously stale one — so ambiguity returns null and
 * says so in the log.
 */
export interface SnapshotAccountResolution {
  /** The Plaid `account_id` to treat as the bank account, or null if unknown. */
  externalId: string | null;
  /** The `plaid_accounts.id` behind it — what a caller would heal the pointer to. */
  rowId: string | null;
  /** How we got there. `pointer` means the stored pointer was fine. */
  via: "pointer" | "snapshot mask" | "sole checking" | "sole depository" | "unresolved";
}

function uniqueRow<T extends { accountId: string | null; id: string }>(
  rows: T[],
): T | null {
  const withId = rows.filter((r) => !!r.accountId);
  const distinct = new Set(withId.map((r) => r.accountId));
  return distinct.size === 1 ? withId[0]! : null;
}

export async function resolveSnapshotAccount(args: {
  householdId: string;
  bankSnapshotAccountId: string | null;
  bankSnapshotMask: string | null;
}): Promise<SnapshotAccountResolution> {
  const { householdId, bankSnapshotAccountId, bankSnapshotMask } = args;

  if (bankSnapshotAccountId) {
    const [acct] = await db
      .select({ id: plaidAccountsTable.id, accountId: plaidAccountsTable.accountId })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, bankSnapshotAccountId));
    if (acct?.accountId) {
      return { externalId: acct.accountId, rowId: acct.id, via: "pointer" };
    }
  }

  const householdAccounts = await db
    .select({
      id: plaidAccountsTable.id,
      accountId: plaidAccountsTable.accountId,
      mask: plaidAccountsTable.mask,
      subtype: plaidAccountsTable.subtype,
      type: plaidAccountsTable.type,
    })
    .from(plaidAccountsTable)
    .where(eq(plaidAccountsTable.householdId, householdId));

  // 1. The mask the snapshot was taken against. The pointer is gone; the
  //    identity is not — "··5526" still names one physical account.
  if (bankSnapshotMask) {
    const byMask = uniqueRow(
      householdAccounts.filter((a) => a.mask === bankSnapshotMask),
    );
    if (byMask) {
      logResolution(householdId, bankSnapshotAccountId, byMask.accountId, "snapshot mask");
      return { externalId: byMask.accountId, rowId: byMask.id, via: "snapshot mask" };
    }
  }

  // 2. The household's single checking account — unambiguous by definition
  //    when there is only one of them.
  const byChecking = uniqueRow(
    householdAccounts.filter((a) => a.subtype === "checking"),
  );
  if (byChecking) {
    logResolution(householdId, bankSnapshotAccountId, byChecking.accountId, "sole checking");
    return { externalId: byChecking.accountId, rowId: byChecking.id, via: "sole checking" };
  }

  // 3. Its single depository account (older links can arrive with a type but
  //    no subtype).
  const byDepository = uniqueRow(
    householdAccounts.filter((a) => a.type === "depository"),
  );
  if (byDepository) {
    logResolution(householdId, bankSnapshotAccountId, byDepository.accountId, "sole depository");
    return {
      externalId: byDepository.accountId,
      rowId: byDepository.id,
      via: "sole depository",
    };
  }

  logger.warn(
    {
      householdId,
      bankSnapshotAccountId,
      bankSnapshotMask,
      candidateCount: householdAccounts.length,
    },
    "[snapshot-account] no resolvable Plaid account for the bank snapshot — the balance cannot roll forward and Sync cannot re-anchor it",
  );
  return { externalId: null, rowId: null, via: "unresolved" };
}

function logResolution(
  householdId: string,
  bankSnapshotAccountId: string | null,
  recoveredExternalId: string | null,
  via: string,
): void {
  logger.info(
    { householdId, bankSnapshotAccountId, recoveredExternalId, via },
    "[snapshot-account] bank snapshot pointer was missing or dangling — recovered the account",
  );
}
