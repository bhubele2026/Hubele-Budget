import { useMemo } from "react";
import { useGetForecast } from "@workspace/api-client-react";
import {
  filterForecastTxns,
  monthKey,
  type Resolution,
  type Transaction as MatchTxn,
} from "@/lib/forecastMatch";

export function useReviewInboxCount(): number {
  const { data } = useGetForecast({ days: 90 });

  return useMemo(() => {
    if (!data) return 0;

    const checkingPlaidAccountIds = new Set<string>();
    const snapshotRowId = data.bankSnapshot?.accountId ?? null;
    if (snapshotRowId) {
      const acct = (data.plaidCheckingAccounts ?? []).find(
        (a) => a.id === snapshotRowId,
      );
      if (acct?.accountId) checkingPlaidAccountIds.add(acct.accountId);
    }

    const txns = filterForecastTxns(
      (data.transactions ?? []) as unknown as MatchTxn[],
      checkingPlaidAccountIds,
    );

    const resolutions = (data.resolutions ?? []) as Resolution[];
    const resolvedTxnIds = new Set<string>();
    for (const r of resolutions) {
      if (r.matchedTxnId) resolvedTxnIds.add(r.matchedTxnId);
    }

    const today = new Date();
    const currentMonth = `${today.getFullYear()}-${String(
      today.getMonth() + 1,
    ).padStart(2, "0")}`;

    // (#751 — REVERTED in #803) The badge used to also count
    // past-due unresolved PLAN rows from any month — that surfaced
    // March/April zombies once old resolutions stopped key-matching.
    // Plan reconciliation now lives in the Weekly Debrief; the badge
    // is back to its original job: unmatched bank txns in the
    // CURRENT month that the user still has to triage.
    let count = 0;
    for (const t of txns) {
      if (!t.forecastFlag) continue;
      if (resolvedTxnIds.has(t.id)) continue;
      if (monthKey(t.occurredOn) !== currentMonth) continue;
      count++;
    }

    return count;
  }, [data]);
}
