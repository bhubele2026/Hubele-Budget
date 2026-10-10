import { lazy, Suspense, useState } from "react";
import { Info } from "lucide-react";
import {
  useGetForecastBankBalanceExplain,
  getGetForecastBankBalanceExplainQueryKey,
} from "@workspace/api-client-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// (WP3, bundle) The explanation itself is a lazy chunk: it draws only once the
// popover is open, and the summary row on the landing carries this trigger.
const Body = lazy(() => import("./bank-balance-why-body"));

/**
 * ⭐ WHY THIS NUMBER? The bank balance, explained by the server's own diagnostic.
 *
 * Every figure, day and reason comes from `/forecast/bank-balance-explain`,
 * which is read-only and makes no Plaid call. The component only compares those
 * figures to the cent. The prose lives one tap away, where the word diet allows
 * it.
 *
 * ⚠️ NEVER AN OLDER EXPLANATION THAN THE TILE. The query runs only while the
 * popover is open, and is always asked afresh (`staleTime: 0`). Sync and every
 * write invalidate it too. While that answer is on its way the popover says
 * "Loading…"; a failed refresh keeps the last answer under a banner that says
 * how old it is.
 *
 * ⚠️ NO EQUATION. `displayed.bankToday` is the cash signal's roll-forward;
 * `ledger.sinceAnchor.net` is what that roll-forward adds, by the same rule over
 * the same rows (PR4e), and is absent when the snapshot has no read time. The
 * server reads them a moment apart, so they stay separate lines, and a note says
 * so whenever they don't add up to the cent.
 */
export function BankBalanceWhy() {
  const [open, setOpen] = useState(false);
  const query = useGetForecastBankBalanceExplain({
    query: {
      queryKey: getGetForecastBankBalanceExplainQueryKey(),
      enabled: open,
      staleTime: 0,
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="tile-in press absolute right-1 top-1 rounded-control p-1 text-neutral-500 hover:text-brand-navy focus-visible:ring-2 focus-visible:ring-brand-navy/40"
          aria-label="Why this number?"
          title="Why this number?"
          data-testid="button-bank-why"
        >
          <Info className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="end" data-testid="bank-why">
        <Suspense fallback={<p className="text-micro text-neutral-500" data-testid="bank-why-chunk">Loading…</p>}>
          <Body query={query} />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
