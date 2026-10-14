// (S6) The household's credit-card accounts — what makes a row "on a card" for
// the refund rule (`classifyRefund`'s card-credit rule, through `onCardAccount`).
// It is `isCardLedgerRow`'s account test (`plaid_accounts.type === "credit"`,
// any issuer) — the one the categorizer's direction guard already reads
// (`categorizer/context.ts` `loadAccounts`) — read once per request for the
// whole household instead of per row. Standing data, not date-scoped.

import { and, eq } from "drizzle-orm";
import { db, plaidAccountsTable } from "@workspace/db";

/** `db` or a transaction on it: this only reads. */
type DbReader = Pick<typeof db, "select">;

/** External Plaid ids (`plaid_accounts.account_id`) of the household's credit accounts. */
export async function loadCardAccountIds(householdId: string, reader: DbReader = db): Promise<Set<string>> {
  const rows = await reader
    .select({ accountId: plaidAccountsTable.accountId })
    .from(plaidAccountsTable)
    .where(and(eq(plaidAccountsTable.householdId, householdId), eq(plaidAccountsTable.type, "credit")));
  return new Set(rows.map((r) => r.accountId));
}
