import type { AmexSummary } from "@workspace/api-client-react";
import { Panel } from "@/components/next/Panel";
import { moneyFace } from "@/components/data-state";

/**
 * ⭐ (Q3) "ALL CARDS" SHOWS EACH CARD'S BALANCE — never one combined running
 * balance or one combined chart. The cards' balances are read at different
 * times and from different sources (Plaid, a debt row, the workbook), and some
 * cards sit outside the combined figure, so a single line walked across all of
 * their rows would mean nothing. Each card's figure is the server's own
 * (`scope.cards[].owed`: that card's current balance, the same answer as
 * `GET /amex/anchor?accountId=`); unknown is "—", never $0. Picking a card
 * opens its balance history and its rows' "bal".
 */
export function AmexCardBalances({
  summary,
  failed,
  pending,
  masks,
  onSelect,
}: {
  /** The "All cards" summary. A card's summary still on screen (switching) is not used. */
  summary: AmexSummary | undefined;
  failed: boolean;
  /** The summary is on its way. */
  pending: boolean;
  /** External Plaid account_id → last four, from the linked items. */
  masks?: ReadonlyMap<string, string>;
  onSelect: (accountId: string) => void;
}) {
  const cards = summary?.scope.kind === "all" ? summary.scope.cards : null;
  return (
    <Panel
      title="Balance by card"
      sub="Pick a card to see its balance history."
      span={12}
      variant="static"
      accent="amex"
      data-testid="amex-card-balances"
    >
      {cards === null ? (
        failed ? (
          <p className="text-label text-neutral-600" role="status">
            Card balances did not load.
          </p>
        ) : pending ? (
          <div className="space-y-2" aria-busy="true" data-testid="amex-card-balances-loading">
            <span className="block h-4 w-2/3 animate-pulse rounded bg-platinum-2" />
            <span className="block h-4 w-1/2 animate-pulse rounded bg-platinum-2" />
          </div>
        ) : null
      ) : cards.length === 0 ? (
        <p className="text-label text-neutral-600">No cards yet.</p>
      ) : (
        <ul className="divide-y divide-brand-line">
          {cards.map((c) => {
            const mask = masks?.get(c.accountId) || c.mask || "";
            const label = mask ? `${c.name} ••${mask}` : c.name;
            return (
              <li key={c.accountId}>
                <button
                  type="button"
                  onClick={() => onSelect(c.accountId)}
                  className="press flex min-h-10 w-full items-center justify-between gap-3 rounded-control px-1 py-2 text-left hover:bg-platinum-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
                  data-testid={`amex-card-balance-${c.accountId}`}
                  aria-label={`${label}: current balance ${moneyFace(c.owed)}`}
                >
                  <span className="min-w-0 text-label text-brand-navy [overflow-wrap:anywhere]">{label}</span>
                  <span className="shrink-0 font-mono text-label font-semibold tabular-nums text-brand-navy">
                    {moneyFace(c.owed)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
