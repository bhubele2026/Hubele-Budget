import type { AmexWeeklyPayoffCard } from "@workspace/api-client-react";
import { Panel, StatBlock } from "@/components/next";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { formatCurrency } from "@/lib/utils";
import { dayOf, freshnessStamps } from "@/lib/accountFreshness";
import {
  CARD_WORDS, asOfWords, cardOwedView, creditorLabel, pendingWords,
  type CardDebtInput, type CardLiabilityInput,
} from "@/lib/cardBalance";
import { NOT_TRACKED, snapshotCaption } from "@/lib/snapshotWords";
import { entriesWord, sinceSnapshotWords, type BankBalanceView } from "@/lib/bankBalance";
import { ForecastLegend } from "./ForecastLegend";
import { STATE_WORD, type AccountEntry } from "./entries";

const BLANK = "—";
const ord = (n: number) => {
  const v = n % 100;
  const s = ["th", "st", "nd", "rd"];
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
/**
 * A figure only when the API sent one; a missing or unreadable value stays an
 * em dash. (WP3) A REAL zero is a figure: a paid-down card's $0.00 used to be
 * printed as "—" here (the old helper treated 0 as missing). An "unknown"
 * minimum is the card model's job (`minPayment` is null for the API's "0").
 */
export const money = (v: string | number | null | undefined): string | number => {
  if (v === null || v === undefined || v === "") return BLANK;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : BLANK;
};

/** "Oct 2 · +20 entries": when the bank snapshot was read, and what rolled on top. */
function snapshotCaptionOf(v: BankBalanceView): string | null {
  const s = v.snapshot;
  if (!s) return null;
  const n = v.since?.count ?? 0;
  return `${dayOf(s.day) ?? s.day}${n > 0 ? ` · +${entriesWord(n)}` : ""}`;
}

export function AccountSummary({
  entry, debt, liability = null, payoffCard, bank = null, pending = null, now = Date.now(),
}: {
  entry: AccountEntry;
  debt: CardDebtInput | null;
  /**
   * (WP3b) The read this account's figures come from has not answered (the
   * debts for a card, the spine for a depository account) — or failed. Then no
   * figure and no plan words are drawn: a skeleton, or "<what> did not load ·
   * Try again".
   */
  pending?: { failed: boolean; what: string; onRetry?: () => void } | null;
  /** Plaid's stored liability figures, for a card or loan with no debt row. */
  liability?: CardLiabilityInput | null;
  payoffCard: AmexWeeklyPayoffCard | null;
  /** The spine's bank view (WP1) — only when this IS the account the balance rolls forward on. */
  bank?: BankBalanceView | null;
  now?: number;
}) {
  const id = entry.identity;
  const owes = id.isCard || id.kind === "loan";
  // ⭐ The ONE card model (WP3): the same concepts, under the same words, as
  // the dashboard row and the account chip.
  const view = owes ? cardOwedView({ debt, liability }) : null;
  // Every other depository account (savings, a second checking account): the
  // snapshot rule — its last reading, never rolled forward.
  const reading = !owes && !bank ? entry.snapshot ?? null : null;
  const balanceAt = view ? view.creditorCurrent?.asOf : bank ? bank.snapshot?.at : reading?.at;
  const stamps = freshnessStamps({ syncedAt: entry.lastSyncedAt, balanceAt, dataThrough: entry.dataThrough }, now);
  return (
    <Panel title="Summary" sub={`${id.label}${id.mask4 ? ` ••${id.mask4}` : ""}`} accent={id.accent} span={4} data-testid="account-summary">
      {pending ? (
        pending.failed ? (
          <p role="alert" className="text-label text-neutral-600" data-testid="summary-failed">
            {pending.what} did not load ·{" "}
            <button type="button" onClick={pending.onRetry} className="font-semibold text-brand-navy underline">Try again</button>
          </p>
        ) : (
          <div className="space-y-2" aria-busy="true" data-testid="summary-loading">
            <div className="skeleton h-3 w-24 rounded" />
            <div className="skeleton h-7 w-32 rounded" />
            <div className="skeleton h-3 w-40 max-w-full rounded" />
          </div>
        )
      ) : view ? (
        <div className="space-y-4">
          {!view.onPlan ? (
            <p className="text-label font-semibold text-neutral-600" data-testid="summary-plan">{view.status}</p>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            {view.onPlan ? (
              <StatBlock label={CARD_WORDS.owed} value={money(view.owed)} data-testid="summary-owed"
                hint={view.pending ? `after ${formatCurrency(view.pending.total)} ${CARD_WORDS.pending.toLowerCase()}` : undefined} />
            ) : null}
            <StatBlock label={creditorLabel(id.kind === "loan")} value={money(view.creditorCurrent?.balance)} data-testid="summary-creditor"
              hint={asOfWords(view.creditorCurrent?.asOf) ?? undefined} />
            {view.pending ? (
              <StatBlock label={CARD_WORDS.pending} value={money(view.pending.total)} hint={pendingWords(view.pending)} data-testid="summary-pending" />
            ) : null}
            {/* A real statement only (the debt's `statement`, once the API sends
                it). The weekly payoff's `statementBalance` is the card's CURRENT
                balance under another name, so it never fills this. */}
            <StatBlock label={CARD_WORDS.statement} value={money(view.statement?.balance)} data-testid="summary-statement"
              hint={view.statement?.date ? `closed ${dayOf(view.statement.date)}` : undefined} />
            <StatBlock label="Minimum payment" value={money(view.minPayment)} data-testid="summary-min" />
            <StatBlock label="Payment due" value={view.dueDay ? `${ord(view.dueDay)} of the month` : BLANK} data-testid="summary-due" />
          </div>
          {id.isCard ? (
            <>
              <StatBlock
                label="This week's charges"
                value={payoffCard ? money(payoffCard.weekCharges) : BLANK}
                hint={payoffCard
                  // `pctOfStatementThisWeek` is a 0–1 share of the card's current balance.
                  ? `${payoffCard.chargeCount} charge${payoffCard.chargeCount === 1 ? "" : "s"} · ${Math.round(payoffCard.pctOfStatementThisWeek * 100)}% of the card's current balance`
                  : undefined}
              />
              <ForecastLegend card={id} />
            </>
          ) : null}
        </div>
      ) : bank ? (
        // (WP3, on WP1's spine view) The balance today is the dashboard's
        // figure — the bank snapshot rolled forward through the ledger — and
        // the snapshot itself sits under it, dated, with what rolled on top.
        // It was the raw snapshot, undated, under "Balance today".
        <div className="space-y-4">
          <StatBlock label="Balance today" value={money(bank.balance)} data-testid="summary-balance"
            hint={sinceSnapshotWords(bank) ?? undefined} />
          {bank.snapshot ? (
            <div data-testid="summary-bank-snapshot">
              <StatBlock label="Bank snapshot" value={money(bank.snapshot.balance)} hint={snapshotCaptionOf(bank) ?? undefined} />
              <div className="mt-1 text-micro text-neutral-500"><BankSnapshotFreshness source={bank.snapshot.source} at={bank.snapshot.at} /></div>
            </div>
          ) : (
            <p className="text-micro text-neutral-500" data-testid="summary-no-snapshot">No balance reading for this account yet.</p>
          )}
        </div>
      ) : reading ? (
        <StatBlock label="Snapshot" value={money(reading.balance)} hint={snapshotCaption(reading)} data-testid="summary-snapshot" />
      ) : (
        <p className="text-label text-neutral-500" data-testid="summary-not-tracked">
          {id.kind === "savings" ? NOT_TRACKED.savings : NOT_TRACKED.other}
        </p>
      )}
      {/* The connection word when it is not simply synced (the first stamp says
          that), then the three stamps: synced · balance read · data through. */}
      <p className="mt-3 text-micro text-neutral-500" data-testid="summary-state">
        {[entry.state === "synced" ? null : STATE_WORD[entry.state], ...stamps].filter(Boolean).join(" · ")}
      </p>
    </Panel>
  );
}
