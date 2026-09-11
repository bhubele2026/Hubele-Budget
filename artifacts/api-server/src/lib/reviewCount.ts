import { and, eq, gte, lte } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  forecastResolutionsTable,
  transactionsTable,
} from "@workspace/db";
import { forecastTodayISO, inForecastWhere } from "./forecastInclusion";
import { resolveSnapshotAccount } from "./resolveSnapshotAccount";

/**
 * The Review-inbox count: unresolved BANK txns in the current calendar month
 * that are in the forecast (`inForecast`: already happened, or a future row
 * flagged for the forecast). Mirrors the client's `filterForecastTxns`/
 * `isBankTxn` semantics (h2budget/src/lib/forecastMatch.ts +
 * useReviewInboxCount) with three small queries — the layout used to pull the
 * entire ~30-query `/forecast` bundle on every route just to derive this
 * integer.
 *
 * ⚠️ THIS BODY WAS LIFTED VERBATIM OUT OF `routes/forecast.ts` — it is the same
 * code, not a second copy of it. It moved into a lib the moment a SECOND caller
 * appeared (`/api/spine`), because the badge in the nav and the badge on the
 * landing hero are the same claim and must never be able to disagree. Two
 * hand-kept implementations of "how many things need looking at" is exactly the
 * class of drift the spine exists to end. `GET /forecast/review-count` now calls
 * this; so does the spine; there is one definition.
 *
 * The bank account comes from `resolveSnapshotAccount` — the same resolution
 * the balance roll-forward uses — so a dangling snapshot pointer cannot zero
 * the badge while the curve keeps moving.
 */
export async function computeReviewCount(
  householdId: string,
  ownerUserId: string,
): Promise<number> {
  const [settings] = await db
    .select({
      bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId,
      bankSnapshotMask: forecastSettingsTable.bankSnapshotMask,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  const { externalId: checkingExternalId } = await resolveSnapshotAccount({
    householdId,
    bankSnapshotAccountId: settings?.bankSnapshotAccountId ?? null,
    bankSnapshotMask: settings?.bankSnapshotMask ?? null,
  });

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
        inForecastWhere(forecastTodayISO(now)),
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
