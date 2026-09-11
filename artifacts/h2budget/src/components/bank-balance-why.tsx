import { useState } from "react";
import { Info } from "lucide-react";
import {
  useGetForecastBankBalanceExplain,
  getGetForecastBankBalanceExplainQueryKey,
  type BankBalanceExplain,
} from "@workspace/api-client-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FreshnessLine, RefreshBanner, moneyFace } from "@/components/data-state";
import { dataState } from "@/lib/queryState";
import { formatDate } from "@/lib/utils";
import { btnLink } from "@/ui";

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
  const state = dataState(query);
  const explain = query.data;

  let body;
  if (state === "loaded" && explain) {
    body = <Explanation explain={explain} />;
  } else if (state === "refresh-failed" && explain) {
    body = (
      <div className="space-y-2">
        <RefreshBanner
          state={state}
          updatedAt={query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toISOString() : null}
          onRetry={() => void query.refetch()}
          refreshing={query.isFetching ?? false}
          data-testid="bank-why-refresh-banner"
        />
        <Explanation explain={explain} />
      </div>
    );
  } else if (state === "failed") {
    body = (
      <p className="text-micro text-neutral-500">
        Couldn't load.{" "}
        <button type="button" className={btnLink} onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  } else {
    // Cold, or refreshing: never an older explanation shown as current.
    body = <p className="text-micro text-neutral-500">Loading…</p>;
  }

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
        {body}
      </PopoverContent>
    </Popover>
  );
}

function Explanation({ explain }: { explain: BankBalanceExplain }) {
  const { snapshot, ledger, nextSync, freshness, displayed } = explain;
  const since = ledger.sinceAnchor;
  const cents = (v: string | number) => Math.round(Number(v) * 100);
  // With no rows figure (the snapshot's account did not resolve), the snapshot
  // alone is compared with the balance: they can still differ.
  const addsUp =
    snapshot.balance == null
      ? null
      : cents(snapshot.balance) + (since ? cents(since.net) : 0) === cents(displayed.bankToday);
  const where = [
    snapshot.source === "plaid" ? "Plaid" : snapshot.source === "manual" ? "Manual" : null,
    snapshot.name,
    snapshot.mask ? `••${snapshot.mask}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const net = since ? Number(since.net) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-label font-semibold text-brand-navy">Bank balance</div>
        <div
          className="font-mono text-label font-semibold tabular-nums text-brand-navy"
          data-testid="bank-why-displayed"
        >
          {moneyFace(displayed.bankToday)}
        </div>
      </div>

      {snapshot.balance == null ? (
        <p className="text-micro text-neutral-500" data-testid="bank-why-no-snapshot">
          No bank balance is set, so the forecast runs off the starting balance.
        </p>
      ) : (
        <>
          <dl className="space-y-1 text-micro text-neutral-500">
            <div className="flex justify-between gap-2" data-testid="bank-why-snapshot">
              <dt>
                {/* The server's household day for the snapshot, not a UTC slice. */}
                Snapshot{ledger.anchorDay ? `, ${formatDate(ledger.anchorDay)}` : ""}
                {where ? ` (${where})` : ""}
              </dt>
              <dd className="font-mono tabular-nums text-neutral-700">
                {moneyFace(snapshot.balance)}
              </dd>
            </div>
            {since && (
              <div className="flex justify-between gap-2" data-testid="bank-why-since">
                <dt>
                  {since.rowCount} row{since.rowCount === 1 ? "" : "s"} since then
                </dt>
                <dd className="font-mono tabular-nums text-neutral-700">
                  {net > 0 ? "+" : ""}
                  {moneyFace(since.net)}
                </dd>
              </div>
            )}
          </dl>

          {addsUp === false && (
            <p className="text-micro text-neutral-500" data-testid="bank-why-mismatch">
              The balance above and these lines do not add up to the cent.
            </p>
          )}

          <div className="text-micro text-neutral-400">
            <FreshnessLine
              bank={{
                source: freshness.source,
                asOfDate: snapshot.at,
                lastContactAt: freshness.lastContactAt,
                stale: freshness.stale,
                staleReason: freshness.staleReason,
              }}
            />
          </div>

          <p className="text-micro text-neutral-500" data-testid="bank-why-next-sync">
            {nextSync.willRefreshBalance
              ? "The next Sync asks the bank for this balance."
              : `The next Sync won't ask the bank for it: ${nextSync.whyNot ?? "no reason given"}.`}
          </p>
        </>
      )}
    </div>
  );
}
