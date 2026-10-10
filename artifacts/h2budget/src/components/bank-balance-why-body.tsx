import type { BankBalanceExplain } from "@workspace/api-client-react";
import { FreshnessLine, RefreshBanner, moneyFace } from "@/components/data-state";
import { dataState, type QueryLike } from "@/lib/queryState";
import { formatDate } from "@/lib/utils";
import { btnLink } from "@/ui";

/**
 * The body of "Why this number?" (`bank-balance-why.tsx`), its own LAZY chunk:
 * it renders only once the popover opens, so none of it rides on the landing.
 * (WP3, bundle) The trigger, the popover and the query stay in the shell, so
 * nothing is fetched while it is closed and the answer is asked afresh on open;
 * this module only draws what the server said. Unchanged from the shell's old
 * body, moved whole.
 */
/** The shell's query, as this body reads it (a TanStack result satisfies it). */
export interface ExplainQuery extends QueryLike {
  data: BankBalanceExplain | undefined;
  dataUpdatedAt?: number;
  refetch: () => unknown;
}

export default function BankBalanceWhyBody({ query }: { query: ExplainQuery }) {
  const state = dataState(query);
  const explain = query.data;
  if (state === "loaded" && explain) return <Explanation explain={explain} />;
  if (state === "refresh-failed" && explain) {
    return (
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
  }
  if (state === "failed") {
    return (
      <p className="text-micro text-neutral-500">
        Couldn't load.{" "}
        <button type="button" className={btnLink} onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  }
  // Cold, or refreshing: never an older explanation shown as current.
  return <p className="text-micro text-neutral-500">Loading…</p>;
}

function Explanation({ explain }: { explain: BankBalanceExplain }) {
  const { snapshot, ledger, nextSync, freshness, displayed } = explain;
  const since = ledger.sinceAnchor;
  const cents = (v: string | number) => Math.round(Number(v) * 100);
  // With no rows figure (the snapshot has no read time), the snapshot
  // alone is compared with the balance: they can still differ.
  // (WP10) No snapshot means no bank balance (`displayed.bankToday` is null,
  // never "0.00"): nothing to compare.
  const addsUp =
    snapshot.balance == null || displayed.bankToday == null
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
