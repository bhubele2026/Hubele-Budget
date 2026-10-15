import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * ⭐ (T1) BACK TO A TAB → THE BALANCE IS ASKED AGAIN, IF IT IS OLD.
 *
 * The money reads (`/api/spine`, the forecast family, the banking review, the
 * Chase ledger's balances) do not refetch on focus (App.tsx: the bundle is
 * expensive). A Sync in another tab moved the bank reading; this tab still
 * showed yesterday's. On `visibilitychange` (visible) or `focus`, each of
 * those queries whose answer is older than `MONEY_RETURN_MS` is marked stale
 * and, when on screen, fetched again. A quick tab switch costs nothing; a query
 * already fetching is left alone. No BroadcastChannel: the server is the truth.
 */
export const MONEY_RETURN_MS = 60_000;

/** The keys whose answers carry the checking balance. */
export function isMoneyKey(key: readonly unknown[]): boolean {
  const first = key[0];
  if (typeof first === "string" && (first === "/api/spine" || first.startsWith("/api/forecast") || first.startsWith("/api/banking/review"))) {
    return true;
  }
  // The Chase register's balances (its list pages are left alone: many pages, and the balance line reads these).
  return key.some((k) => typeof k === "string" && k.startsWith("/api/transactions/balances"));
}

/** Invalidate the money reads older than `MONEY_RETURN_MS` (refetching those on screen). */
export function refetchOldMoney(qc: QueryClient, now: number = Date.now()): Promise<void> {
  return qc.invalidateQueries({
    refetchType: "active",
    predicate: (q) =>
      isMoneyKey(q.queryKey) &&
      q.state.fetchStatus !== "fetching" &&
      q.state.dataUpdatedAt > 0 &&
      now - q.state.dataUpdatedAt > MONEY_RETURN_MS,
  });
}

export function useRefetchMoneyOnReturn(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      void refetchOldMoney(qc);
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [qc]);
}
