import type { AmexSummary, AmexSummaryCard } from "@workspace/api-client-react";
import { moneyFace } from "@/components/data-state";
import { payWordShort } from "@/components/amex-pay-mode";

/**
 * ⭐ (Q3) "ALL CARDS" SHOWS EACH CARD'S BALANCE — never one combined running
 * balance or one combined chart. The cards' balances are read at different
 * times and from different sources (Plaid, a debt row, the workbook), and some
 * cards sit outside the combined figure, so a single line walked across all of
 * their rows would mean nothing. Each card's figure is the server's own
 * (`scope.cards[].owed`: that card's current balance, the same answer as
 * `GET /amex/anchor?accountId=`); unknown is "—", never $0.
 *
 * (P1) THE SUMMARY'S "BY CARD" LIST. Inside the All cards Summary, one line per
 * card: its name ••last4, what it owes, this period's purchases and how it is
 * paid — the band's tiles and the old "Balance by card" panel in one place.
 * A line opens that card (as its tab does). The cards' owed may not add up to
 * the total above: the cards' balances are read at different times.
 */

/** The pay word, only where the server knows the card's payoff (never a guess). */
function payWord(c: AmexSummaryCard): { text: string; choose: boolean } | null {
  if (c.paidAs == null && c.payoffMode == null) return null;
  const text = payWordShort(c);
  return { text, choose: text === "Not chosen yet" };
}

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
  const head = "text-micro font-semibold uppercase tracking-wide text-neutral-600";
  return (
    <section aria-labelledby="amex-by-card-title" className="space-y-1" data-testid="amex-card-balances">
      <h3 id="amex-by-card-title" className="text-label text-neutral-600">
        By card
      </h3>
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
        <div>
          {/* Column heads on a wide panel; a phone reads each figure's own label. */}
          <div
            className="hidden grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_10rem] gap-3 border-b border-brand-line px-1 pb-1 sm:grid"
            aria-hidden
          >
            <span className={head}>Card</span>
            <span className={`${head} text-right`}>Owed</span>
            <span className={`${head} text-right`}>Purchases</span>
            <span className={head}>Paid</span>
          </div>
          <ul className="m-0 list-none divide-y divide-brand-line p-0">
            {cards.map((c) => {
              const mask = masks?.get(c.accountId) || c.mask || "";
              const label = mask ? `${c.name} ••${mask}` : c.name;
              const word = payWord(c);
              const owed = moneyFace(c.owed);
              const bought = moneyFace(c.purchases?.amount);
              return (
                <li key={c.accountId}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.accountId)}
                    className="press grid min-h-10 w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 rounded-control px-1 py-2 text-left hover:bg-platinum-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_10rem]"
                    data-testid={`amex-card-balance-${c.accountId}`}
                    aria-label={`${label}: owed ${owed}, purchases ${bought}${word ? `, ${word.text}` : ""}`}
                  >
                    <span className="min-w-0 text-label font-medium text-brand-navy [overflow-wrap:anywhere]">{label}</span>
                    <span className="text-right font-mono text-label font-semibold tabular-nums text-brand-navy" data-testid={`amex-card-owed-${c.accountId}`}>
                      {owed}
                    </span>
                    <span className="text-micro text-neutral-600 sm:text-right sm:font-mono sm:text-label sm:tabular-nums sm:text-brand-ink" data-testid={`amex-card-purchases-${c.accountId}`}>
                      <span className="sm:hidden">Purchases </span>
                      {bought}
                    </span>
                    <span className="text-right text-micro text-neutral-600 sm:text-left sm:text-label" data-testid={`amex-card-payword-${c.accountId}`}>
                      {word ? (
                        <>
                          {word.text}
                          {word.choose ? <span className="font-semibold text-brand-navy underline"> · Choose</span> : null}
                        </>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
