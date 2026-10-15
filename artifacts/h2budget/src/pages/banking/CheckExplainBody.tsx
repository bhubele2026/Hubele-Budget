import type { BankingCheckExplain } from "@workspace/api-client-react/features";
import { RefreshBanner } from "@/components/data-state";
import { dataState, type QueryLike } from "@/lib/queryState";
import { btnLink } from "@/ui";
import { checkExplainWords } from "./checkExplainWords";

/**
 * (T2) The body of "Review difference" (`CheckExplain.tsx`), a lazy chunk. It
 * only draws what `GET /banking/check-explain` said, in the words of
 * `checkExplainWords`. Loading says so; a failed first load offers Retry; a
 * failed refresh keeps the last answer under a banner that says how old it is.
 */
export interface CheckExplainQuery extends QueryLike {
  data: BankingCheckExplain | undefined;
  dataUpdatedAt?: number;
  refetch: () => unknown;
}

export default function CheckExplainBody({ query }: { query: CheckExplainQuery }) {
  const state = dataState(query);
  const e = query.data;
  if (e && (state === "loaded" || state === "refresh-failed")) {
    return (
      <div className="space-y-3">
        {state === "refresh-failed" ? (
          <RefreshBanner
            state={state}
            updatedAt={query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toISOString() : null}
            onRetry={() => void query.refetch()}
            refreshing={query.isFetching ?? false}
            data-testid="check-explain-refresh-banner"
          />
        ) : null}
        <Explanation e={e} />
      </div>
    );
  }
  if (state === "failed") {
    return (
      <p className="text-label text-neutral-600" role="alert" data-testid="check-explain-failed">
        The check did not load.{" "}
        <button type="button" className={btnLink} onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  }
  // Cold, or refreshing: never an older explanation shown as current.
  return <p className="text-label text-neutral-600" data-testid="check-explain-loading">Loading…</p>;
}

function Explanation({ e }: { e: BankingCheckExplain }) {
  const w = checkExplainWords(e);
  if (!e.record) {
    return <p className="text-body text-neutral-700" data-testid="check-explain-none">This account has not been checked yet. Sync to check it against the bank.</p>;
  }
  return (
    <div className="space-y-3" data-testid="check-explain-body">
      <div>
        <div className="text-label font-semibold text-brand-ink" data-testid="check-explain-title">{w.title}</div>
        {w.account ? <div className="text-micro text-neutral-600">{w.account}</div> : null}
      </div>
      <dl className="divide-y divide-brand-line rounded-control ring-1 ring-brand-line">
        {w.lines.map((l) => (
          <div key={l.key} className="px-3 py-2" data-testid={`check-explain-${l.key}`}>
            <dt className="text-micro font-semibold text-neutral-600">{l.label}</dt>
            <dd className="mt-0.5 text-label font-semibold tabular-nums text-brand-ink">{l.value}</dd>
            {l.rows.length ? (
              <ul className="mt-1 space-y-0.5 text-micro text-neutral-700">
                {l.rows.map((r) => (
                  <li key={r.id} className="[overflow-wrap:anywhere]">{r.text}</li>
                ))}
              </ul>
            ) : null}
            {l.note ? <p className="mt-1 text-micro text-neutral-600">{l.note}</p> : null}
          </div>
        ))}
      </dl>
      {w.verdict ? (
        <p className="text-body text-brand-ink" data-testid="check-explain-verdict">{w.verdict}</p>
      ) : null}
    </div>
  );
}
