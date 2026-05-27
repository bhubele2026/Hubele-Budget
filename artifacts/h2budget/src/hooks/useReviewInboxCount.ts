import { useMemo } from "react";
import { useGetForecast } from "@workspace/api-client-react";
import {
  buildLineRegister,
  filterForecastTxns,
  monthKey,
  type Resolution,
  type Transaction as MatchTxn,
} from "@/lib/forecastMatch";
import type { CashEvent } from "@/lib/forecast";

function fmtISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

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

    // (#751) The Review badge counts two distinct things:
    //   1) Unmatched bank transactions in the CURRENT month (existing
    //      behavior — the user is most likely to triage this month's
    //      activity).
    //   2) Past-due unresolved PLAN rows from ANY month — because
    //      pending plans now stick around on /forecast and /review
    //      until the user explicitly resolves them. Restricting these
    //      to the current month would hide last month's stragglers
    //      and let the badge silently under-report.
    let count = 0;
    for (const t of txns) {
      if (!t.forecastFlag) continue;
      if (resolvedTxnIds.has(t.id)) continue;
      if (monthKey(t.occurredOn) !== currentMonth) continue;
      count++;
    }

    const events = (data.events ?? []) as unknown as CashEvent[];
    const todayISO = fmtISODate(today);
    const register = buildLineRegister({
      events,
      txns,
      resolutions,
      closedMonths: new Set(),
      startBalance: 0, // not used for counting
      fromISO: data.fromDate,
      toISO: data.toDate,
      today,
      snapshotISO: data.bankSnapshot?.at?.slice(0, 10) ?? null,
      visibleFromISO: todayISO,
    });
    for (const p of register.allPlan) {
      if (p.status !== "pending_plan") continue;
      if (p.date > todayISO) continue; // only past-due, not future
      count++;
    }

    return count;
  }, [data]);
}
