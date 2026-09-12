import { useQueryClient } from "@tanstack/react-query";
import {
  useAdoptDebtBankBalance,
  getListDebtsQueryKey,
  getListDebtBalanceHistoryQueryKey,
  getGetBillsSummaryQueryKey,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import type { Debt } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { btnLink } from "@/ui";
import { householdDayOfAt, householdToday } from "@/lib/householdDay";
import { isPlaidReauthCode } from "@/components/plaid-reconnect-button";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 10" on the household calendar; the year only when it isn't this year. */
export function balanceDayLabel(
  at: string | null | undefined,
  today: string = householdToday(),
): string {
  if (!at) return "date unknown";
  const day = householdDayOfAt(at);
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return "date unknown";
  const label = `${MONTHS[m - 1]} ${d}`;
  return day.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${day.slice(0, 4)}`;
}

/**
 * ⭐ WHOSE BALANCE IS THIS (PR-E). Debt detail rows only — never the landing or
 * the Future Goal hero, which show % paid and no amount owed.
 *
 * A balance someone entered is kept; the bank's balance keeps arriving beside
 * it. When they differ this shows both, dated, with the difference and the one
 * explicit way back to the bank's figure. It also says when the bank figure
 * could not be refreshed, or is old. Renders nothing when there is nothing to
 * say, so a healthy bank-sourced debt looks exactly as before.
 */
export function DebtBankBalance({
  debt,
  fmt,
}: {
  debt: Debt;
  fmt: (n: number) => string;
}) {
  const bank = debt.bankBalance == null ? null : Number(debt.bankBalance);
  const hasBank = bank != null && Number.isFinite(bank);
  const entered = Number(debt.balance);
  const kept = debt.balanceSource !== "plaid";
  const differs =
    kept && hasBank && Number.isFinite(entered) && Math.abs(entered - bank) >= 0.005;
  // The page-top reconnect banner already says this bank's figures may be out
  // of date; a second line under each of its debts would only repeat it.
  const bannerCovers =
    isPlaidReauthCode(debt.plaidLastSyncErrorCode) && !!debt.plaidAccount?.itemId;
  const failed = !bannerCovers && !!debt.bankRefreshError;
  const stale =
    !bannerCovers && !debt.bankRefreshError && hasBank && debt.bankBalanceStale === true;
  if (!differs && !failed && !stale) return null;
  const diff = differs ? Math.round((entered - bank) * 100) / 100 : 0;

  return (
    <div
      className="mt-1 flex flex-col items-end gap-0.5 text-micro text-neutral-500"
      data-testid={`debt-bank-balance-${debt.id}`}
    >
      {differs && (
        <>
          <div data-testid={`debt-balance-entered-${debt.id}`}>
            Entered{" "}
            <span className="font-mono tabular-nums text-neutral-700">{fmt(entered)}</span>
            {" · "}
            {balanceDayLabel(debt.lastBalanceUpdate)}
          </div>
          <div data-testid={`debt-balance-bank-${debt.id}`}>
            Bank{" "}
            <span className="font-mono tabular-nums text-neutral-700">{fmt(bank)}</span>
            {" · "}
            {balanceDayLabel(debt.bankBalanceAt)}
          </div>
          <div data-testid={`debt-balance-difference-${debt.id}`}>
            Difference{" "}
            <span className="font-mono tabular-nums text-neutral-700">
              {diff > 0 ? "+" : ""}
              {fmt(diff)}
            </span>
          </div>
          <UseBankBalanceButton debtId={debt.id} />
        </>
      )}
      {failed && (
        // A plain sentence, never the stored error text (which can be a
        // database message).
        <div className="text-bad" data-testid={`debt-bank-refresh-failed-${debt.id}`}>
          Couldn't refresh the bank balance · {balanceDayLabel(debt.bankRefreshFailedAt)}
        </div>
      )}
      {stale && (
        <div data-testid={`debt-bank-balance-stale-${debt.id}`}>
          Bank balance old · {balanceDayLabel(debt.bankBalanceAt)}
        </div>
      )}
    </div>
  );
}

/** Mounted only when there is a difference, so the hook exists only then. */
function UseBankBalanceButton({ debtId }: { debtId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const adopt = useAdoptDebtBankBalance({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
        qc.invalidateQueries({ queryKey: getListDebtBalanceHistoryQueryKey() });
        qc.invalidateQueries({ queryKey: getGetBillsSummaryQueryKey() });
        qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        qc.invalidateQueries({
          predicate: (q) => {
            const key = q.queryKey[0];
            return typeof key === "string" && key.startsWith("/api/forecast");
          },
        });
        toast({ title: "Using the bank balance" });
      },
      onError: (err) =>
        toast({
          title: "Could not use the bank balance",
          description: String(err),
          variant: "destructive",
        }),
    },
  });
  return (
    <button
      type="button"
      className={btnLink}
      disabled={adopt.isPending}
      onClick={(e) => {
        e.stopPropagation();
        adopt.mutate({ id: debtId });
      }}
      data-testid={`button-use-bank-balance-${debtId}`}
    >
      Use bank balance
    </button>
  );
}
