import { useMemo } from "react";
import { Link } from "wouter";
import { useListPlaidItems, type BankBalanceExplain, type BankBalanceExplainRow } from "@workspace/api-client-react";
import { FreshnessLine, RefreshBanner, moneyFace } from "@/components/data-state";
import { dataState, type QueryLike } from "@/lib/queryState";
import { formatDate } from "@/lib/utils";
import { dayTimeOf } from "@/lib/checkingWords";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries } from "@/pages/next/accounts/entries";
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

export default function BankBalanceWhyBody({ query, onReviewDifference }: { query: ExplainQuery; onReviewDifference?: () => void }) {
  const state = dataState(query);
  const explain = query.data;
  if (state === "loaded" && explain) return <Explanation explain={explain} onReviewDifference={onReviewDifference} />;
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
        <Explanation explain={explain} onReviewDifference={onReviewDifference} />
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-14" → "Oct 14": the row's household day, as the server sent it. */
const shortDay = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : iso);
/** "+$3,500.00" · "-$125.40" · "$0.00": a row's signed figure. */
const signed = (v: string) => `${Number(v) > 0 ? "+" : ""}${moneyFace(v)}`;

/**
 * ⭐ (Task 4, D) WHY A ROW IS NOT IN CHECKING TODAY — the cash rule's own verdict
 * (`classifyCashRows`, sent as `reason`), in words. Nothing here judges a row.
 */
export const NOT_COUNTED_WORDS: Record<string, string> = {
  held: "In the bank's reading",
  not_bank: "Another account",
  claim_confirmed: "Logged payment · the bank's row counts",
  superseded: "Replaced by its posted row",
  expired: "Expired hold",
  duplicate: "Repeated bank row",
};

function Explanation({ explain, onReviewDifference }: { explain: BankBalanceExplain; onReviewDifference?: () => void }) {
  const { snapshot, ledger, nextSync, freshness, displayed } = explain;
  const since = ledger.sinceAnchor;
  const cents = (v: string | number) => Math.round(Number(v) * 100);
  // ⭐ (Task 4, D) The rows behind the figure, as the server judged them (absent from an older server).
  const rows = ledger.rows ?? null;
  const counted = rows?.filter((r) => r.counted) ?? [];
  const notCounted = rows?.filter((r) => !r.counted) ?? [];
  // Rows on the household's other accounts (the server's `onAccount`, the rule's own `isBankRow`) go on one line.
  const notOwn = notCounted.filter((r) => r.onAccount ?? r.reason !== "not_bank");
  const otherAccounts = notCounted.length - notOwn.length;
  const pendingCounted = counted.filter((r) => r.pending).length;
  // The display check, summed once: the counted rows add up to the server's own "since" figure.
  const rowsTie = rows == null || !since || counted.reduce((s, r) => s + cents(r.contribution), 0) === cents(since.net);
  // With no rows figure (the snapshot has no read time), the snapshot
  // alone is compared with the balance: they can still differ.
  // (WP10) No snapshot means no bank balance (`displayed.bankToday` is null,
  // never "0.00"): nothing to compare.
  const addsUp =
    snapshot.balance == null || displayed.bankToday == null
      ? null
      : rowsTie && cents(snapshot.balance) + (since ? cents(since.net) : 0) === cents(displayed.bankToday);
  // (T1) The account it was read from; the reading's own name says where it came from.
  const where = [snapshot.name, snapshot.mask ? `••${snapshot.mask}` : null].filter(Boolean).join(" · ");
  const typed = snapshot.source === "manual";
  const readingName = typed ? "Typed balance (not from the bank)" : "Bank's last reading";
  // The reading's time on the household clock (a typed balance is dated by its day only).
  const readTime = !typed ? (dayTimeOf(snapshot.at)?.split(", ")[1] ?? null) : null;
  const net = since ? Number(since.net) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-label font-semibold text-brand-navy">Checking today</div>
        <div
          className="font-mono text-label font-semibold tabular-nums text-brand-navy"
          data-testid="bank-why-displayed"
        >
          {moneyFace(displayed.bankToday)}
        </div>
      </div>
      {/* (Task 4, D) A pending row can still change: the figure is an estimate until it posts — never "confirmed". */}
      {pendingCounted > 0 && (
        <p className="text-micro font-semibold text-neutral-600" data-testid="bank-why-estimate">
          Estimate: {pendingCounted} pending row{pendingCounted === 1 ? "" : "s"}
        </p>
      )}

      {snapshot.balance == null ? (
        <p className="text-micro text-neutral-500" data-testid="bank-why-no-snapshot">
          No bank reading yet, so the forecast runs off the starting balance.
        </p>
      ) : (
        <>
          <dl className="space-y-1 text-micro text-neutral-500">
            <div className="flex justify-between gap-2" data-testid="bank-why-snapshot">
              <dt>
                {/* The server's household day for the reading, not a UTC slice. */}
                {readingName}{ledger.anchorDay ? `, ${formatDate(ledger.anchorDay)}` : ""}{readTime ? `, ${readTime}` : ""}
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

          {counted.length > 0 && <RowList rows={counted} testid="bank-why-rows" />}

          {addsUp === true && since && since.rowCount > 0 && (
            <p className="flex justify-between gap-2 text-micro font-semibold text-brand-navy" data-testid="bank-why-sum">
              <span>
                {typed ? "Typed balance" : "Bank's last reading"} {moneyFace(snapshot.balance)} + {since.rowCount} row
                {since.rowCount === 1 ? "" : "s"} = Checking today
              </span>
              <span className="font-mono tabular-nums">{moneyFace(displayed.bankToday)}</span>
            </p>
          )}
          {addsUp === false && (
            <p className="text-micro text-neutral-500" data-testid="bank-why-mismatch">
              The balance above and these lines do not add up to the cent.
            </p>
          )}

          {notCounted.length > 0 && (
            <details className="text-micro text-neutral-500" data-testid="bank-why-not-counted">
              <summary className="cursor-pointer font-semibold text-neutral-600">Not counted ({notCounted.length})</summary>
              <div className="mt-1 space-y-1.5">
                {notOwn.length > 0 && <RowList rows={notOwn} testid="bank-why-not-counted-rows" />}
                {/* Rows on the household's other accounts (cards, savings) add nothing here: one line, not a list. */}
                {otherAccounts > 0 && (
                  <p data-testid="bank-why-other-accounts">
                    {otherAccounts} row{otherAccounts === 1 ? "" : "s"} · {NOT_COUNTED_WORDS.not_bank}
                  </p>
                )}
              </div>
            </details>
          )}

          <div className="text-micro text-neutral-400">
            <FreshnessLine
              bank={{
                source: freshness.source,
                stale: freshness.stale,
                staleReason: freshness.staleReason,
              }}
              fetchedAt={freshness.fetchedAt}
            />
          </div>

          <p className="text-micro text-neutral-500" data-testid="bank-why-next-sync">
            {nextSync.willRefreshBalance
              ? "The next Sync asks the bank for this balance."
              : `The next Sync won't ask the bank for it: ${nextSync.whyNot ?? "no reason given"}.`}
          </p>
          {/* (T2) The last check is off: this explains today's balance; the check has its own investigation. */}
          {onReviewDifference ? (
            <button type="button" className={btnLink} onClick={onReviewDifference} data-testid="bank-why-review-difference">
              Review difference
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The rows, each where it lives: date · description (a link to the row, by the
 * one route rule `txnRoute` — `?tx=` lands on it, highlighted) · Pending/Posted ·
 * the figure it adds (a counted row) or the rule's word (a row left out).
 */
function RowList({ rows, testid }: { rows: readonly BankBalanceExplainRow[]; testid: string }) {
  const items = useListPlaidItems({ query: { staleTime: 60_000 } as never });
  const entries = useMemo(() => buildEntries(items.data), [items.data]);
  const entriesKnown = items.data !== undefined;
  return (
    <ul className="space-y-1.5 text-micro" data-testid={testid}>
      {rows.map((r) => {
        const href = txnRoute(
          { id: r.id, occurredOn: r.date, plaidAccountId: r.accountExternalId, source: r.source },
          entries,
          { entriesKnown },
        ).href;
        const name = r.description?.trim() || "Bank row";
        return (
          <li key={r.id} className="flex items-start justify-between gap-2" data-testid="bank-why-row" data-row-id={r.id}>
            <div className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 font-mono tabular-nums text-neutral-400">{shortDay(r.date)}</span>
                {href ? (
                  <Link href={href} className="truncate font-medium text-brand-navy underline" data-testid="bank-why-row-link">
                    {name}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-neutral-700">{name}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 text-neutral-500">
                <span className={r.pending ? "chip warn" : "chip gray"}>{r.pending ? "Pending" : "Posted"}</span>
                {r.counted && r.pending && <span data-testid="bank-why-row-may-change">may still change</span>}
                {r.counted && r.reason === "adjusted" && <span>Adds the change from its pending charge</span>}
                {!r.counted && <span data-testid="bank-why-row-reason">{NOT_COUNTED_WORDS[r.reason] ?? "Not counted"}</span>}
              </div>
            </div>
            <span
              className={`shrink-0 font-mono tabular-nums ${r.counted ? "text-neutral-700" : "text-neutral-400"}`}
              data-testid="bank-why-row-amount"
            >
              {signed(r.counted ? r.contribution : r.amount)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
