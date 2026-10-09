import { useMemo } from "react";
import { useSpine, type SpineRead } from "@/hooks/useSpine";
import { bankBalanceView, type BankBalanceView } from "@/lib/bankBalance";

/**
 * ⭐ THE CHECKING BALANCE FOR A SCREEN (WP1): the spine's `bank` read through
 * `bankBalanceView` — the balance today, the bank snapshot under it, what rolled
 * since, and whose account it is. NO NEW REQUEST: it is the spine every first
 * screen already holds (`useSpine`, one key, one staleTime), so a page that
 * shows the checking balance and the dashboard can never quote two moments.
 *
 * `view` is null until the spine answers (and keeps its identity until the
 * spine changes); `state` says loading, failed or a failed refresh (the last
 * good view stays), as `useSpine` does. Pick the account out of a list with
 * `isSpineAccount(acct, view.account, all)` from `lib/bankBalance` — by id,
 * never by mask.
 */
export function useBankBalanceView(): { view: BankBalanceView | null } & Pick<SpineRead, "state" | "refetch"> {
  const spine = useSpine();
  const bank = spine.data?.bank;
  const view = useMemo(() => (bank ? bankBalanceView(bank) : null), [bank]);
  return { view, state: spine.state, refetch: spine.refetch };
}
