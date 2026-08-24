import { and, eq, gte, lte } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  forecastResolutionsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";

/**
 * The Review-inbox count: unmatched forecast-flagged BANK txns in the current
 * calendar month. Mirrors the client's `filterForecastTxns`/`isBankTxn`
 * semantics (h2budget/src/lib/forecastMatch.ts + useReviewInboxCount) with
 * three small queries — the layout used to pull the entire ~30-query
 * `/forecast` bundle on every route just to derive this integer.
 *
 * ⚠️ THIS BODY WAS LIFTED VERBATIM OUT OF `routes/forecast.ts` — it is the same
 * code, not a second copy of it. It moved into a lib the moment a SECOND caller
 * appeared (`/api/spine`), because the badge in the nav and the badge on the
 * landing hero are the same claim and must never be able to disagree. Two
 * hand-kept implementations of "how many things need looking at" is exactly the
 * class of drift the spine exists to end. `GET /forecast/review-count` now calls
 * this; so does the spine; there is one definition.
 */
export async function computeReviewCount(
  householdId: string,
  ownerUserId: string,
): Promise<number> {
  const [settings] = await db
    .select({
      bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  let checkingExternalId: string | null = null;
  if (settings?.bankSnapshotAccountId) {
    const [acct] = await db
      .select({ accountId: plaidAccountsTable.accountId })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, settings.bankSnapshotAccountId));
    checkingExternalId = acct?.accountId ?? null;
  }

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthStart = `${y}-${pad(m + 1)}-01`;
  const monthEnd = `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`;

  const txns = await db
    .select({
      id: transactionsTable.id,
      source: transactionsTable.source,
      plaidAccountId: transactionsTable.plaidAccountId,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        eq(transactionsTable.forecastFlag, true),
        gte(transactionsTable.occurredOn, monthStart),
        lte(transactionsTable.occurredOn, monthEnd),
      ),
    );

  const resolutions = await db
    .select({ matchedTxnId: forecastResolutionsTable.matchedTxnId })
    .from(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, householdId));
  const resolvedTxnIds = new Set(
    resolutions.map((r) => r.matchedTxnId).filter(Boolean),
  );

  // isBankTxn semantics: account metadata wins; amex/plaid:* without a
  // checking match are card-side; manual rows default to bank.
  let count = 0;
  for (const t of txns) {
    if (t.plaidAccountId) {
      if (!checkingExternalId || t.plaidAccountId !== checkingExternalId)
        continue;
    } else {
      const s = (t.source ?? "manual").toLowerCase();
      if (s === "amex" || s.startsWith("plaid:")) continue;
    }
    if (resolvedTxnIds.has(t.id)) continue;
    count++;
  }
  return count;
}
