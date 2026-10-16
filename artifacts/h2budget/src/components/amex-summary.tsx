import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Link } from "wouter";
import type { AmexSummary } from "@workspace/api-client-react";
import { Panel } from "@/components/next/Panel";
import { moneyFace } from "@/components/data-state";
import { AmexOverLink } from "@/components/amex-over-link";
import { cn } from "@/lib/utils";
import { figLabel } from "@/ui";
import { householdDayOfAt } from "@/lib/householdDay";
import {
  amexPlanLine,
  householdLine,
  whyOverPath,
  type AmexFigure,
} from "@/lib/amexSummaryView";
import type { RangeMode } from "@/lib/timeRange";

export { whyOverPath };

/**
 * ⭐ (W4 → P1) THE AMEX PAGE'S ONE SUMMARY, titled by its period. What is owed,
 * what was bought, what was paid, what came back — each its own figure, the
 * last three open their rows in the activity below — then, for All cards, each
 * card's line ("By card"); for one card, how it is paid; the household line and
 * what to review. The card itself is named once, in the page's header. Every
 * amount is the server's (`GET /amex/summary`); this file formats and links, it
 * adds nothing. An unknown amount is "—", never $0.
 */

const FIG_BASE =
  "press flex min-w-0 flex-col gap-0.5 rounded-card p-3 text-left ring-1 ring-brand-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";
const LINK = "font-semibold text-brand-navy underline";

/** "Oct 14" from the server's `owed.asOf` (an instant, or a bare day). */
export function asOfWords(asOf: string | null): string | null {
  if (!asOf) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : householdDayOfAt(asOf);
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** Rows to look at: the three groups never share a row (first wins), so the count is their sum. */
export function reviewCount(na: AmexSummary["needsAttention"]): number {
  return na.unplanned.count + na.unfiled.count + na.uncategorized.count;
}

export type AmexAttentionGroup = "unplanned" | "unfiled" | "uncategorized";

/** The To-review line's groups, in the server's order (first wins), and how each is said. */
export const ATTENTION_GROUPS: ReadonlyArray<{ key: AmexAttentionGroup; words: string }> = [
  { key: "unplanned", words: "unplanned" },
  { key: "unfiled", words: "not filed yet" },
  { key: "uncategorized", words: "with no category" },
];

function countWord(n: number) {
  return n === 1 ? "1 row" : `${n} rows`;
}

/**
 * ⭐ (Task 6, matrix) TWO MEASURES OF ONE CARD, BOTH SAID. "Owed" is the card's own figure (GET /amex/anchor);
 * the payoff plan counts the card's DEBT ROW (`owed.tracked`), and a typed debt balance is kept as typed — no
 * Sync overwrites it. When the two differ, the line names the plan's figure and where it came from; the link
 * opens the payoff plan. Null when they agree, or there is no active debt for the card.
 */
export function trackedDebtWords(owed: Pick<AmexSummary["owed"], "current" | "tracked">): string | null {
  const t = owed.tracked;
  if (!t || owed.current == null) return null;
  if (Math.round(Number(t.balance) * 100) === Math.round(Number(owed.current) * 100)) return null;
  return `Payoff plan ${moneyFace(t.balance)} · ${t.source === "manual" ? "typed, not from the card" : "from the card's last sync"}`;
}

function Figure({
  testId, label, amount, sub, active, onClick, extra,
}: {
  testId: string;
  label: string;
  amount: string | null;
  sub?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  /** A link under a figure that is not itself a button (Owed's "Balance history"). */
  extra?: ReactNode;
}) {
  const body = (
    <>
      <span className={figLabel}>{label}</span>
      <span className="font-mono text-kpi font-semibold tabular-nums text-brand-navy">{moneyFace(amount)}</span>
      {sub ? <span className="text-micro text-neutral-600">{sub}</span> : null}
      {!onClick && extra ? extra : null}
    </>
  );
  if (!onClick) {
    return <div className={cn(FIG_BASE, "bg-platinum-1")} data-testid={testId}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(FIG_BASE, "hover:bg-platinum-1", active && "bg-brand-tint ring-2 ring-brand-navy/40")}
    >
      {body}
    </button>
  );
}

/** The period the household link reads its plan for. */
export type AmexLinkPeriod = { kind: "week" } | { kind: "month"; start: string; monthName: string } | { kind: "year" };

export function AmexSummaryPanel({
  summary,
  failed,
  title,
  mode,
  isThisWeek,
  figure,
  onFigure,
  attention,
  onAttention,
  onRetry,
  allCards,
  linkPeriod,
  accountRowId,
  byCard,
  payBlock,
  onOwedHistory,
}: {
  summary: AmexSummary | undefined;
  failed: boolean;
  /** (P1) The period: "This week · Oct 11 – 17", "October 2026", "2026". */
  title: string;
  mode: RangeMode;
  isThisWeek: boolean;
  figure: AmexFigure | null;
  onFigure: (f: AmexFigure | null) => void;
  /** (P1) The To-review group the activity is narrowed to, if any. */
  attention?: AmexAttentionGroup | null;
  /** (P1) A To-review button: narrow the activity to that group's rows (or clear it). */
  onAttention?: (g: AmexAttentionGroup | null) => void;
  onRetry?: () => void;
  /** The page's own selection: "All cards" is picked. */
  allCards: boolean;
  /** (P1) Where the household link reads the plan's state. */
  linkPeriod: AmexLinkPeriod;
  /** (T4) The card's plaid_accounts row id when one card is chosen: the household link opens Spending for that card. */
  accountRowId?: string;
  /** (P1) All cards: each card's line (`AmexCardBalances`). */
  byCard?: ReactNode;
  /** (P1) One card: "How this card is paid" (with Add to Avalanche). */
  payBlock?: ReactNode;
  /** (P1) One card: the Owed figure's "Balance history" link (the chart below the activity). */
  onOwedHistory?: () => void;
}) {
  const toggle = (f: AmexFigure) => onFigure(figure === f ? null : f);
  // One card's plan line belongs to that card: on All cards there is no single plan to quote.
  const card = summary && summary.scope.kind === "card" ? summary.scope.cards.find((c) => c.accountId === summary.scope.accountId) : undefined;
  // (Q6b) "On the payoff plan" only for a card that IS on the debt plan (the one definition, `paidAs`).
  const plan = summary && summary.scope.kind === "card"
    ? (() => {
        const line = amexPlanLine(summary.planLink);
        return line?.kind === "debt" && card?.paidAs && card.paidAs.effectiveMode !== "debt_plan" ? null : line;
      })()
    : null;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // (Q6b) The panel keeps the height of the answer it last showed while the next one loads,
  // so the activity below does not jump.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastH = useRef(0);
  useLayoutEffect(() => {
    const h = summary ? (bodyRef.current?.offsetHeight ?? 0) : 0;
    if (h > 0) lastH.current = h;
  });
  const retry = () => {
    // The Retry button goes away with the error: keep the keyboard on the Summary.
    headingRef.current?.focus();
    onRetry?.();
  };
  const owedSub = summary
    ? summary.owed.current == null
      ? "Not known yet"
      : [
          asOfWords(summary.owed.asOf) ? `as of ${asOfWords(summary.owed.asOf)}` : null,
          summary.owed.statement != null ? `Statement ${moneyFace(summary.owed.statement)}` : null,
        ].filter(Boolean).join(" · ") || null
    : null;
  const tracked = summary ? trackedDebtWords(summary.owed) : null;
  return (
    <Panel title={title} titleRef={headingRef} span={12} accent="amex" variant="static" data-testid="amex-summary">
      {failed && !summary ? (
        <div className="flex flex-wrap items-center gap-3" role="alert" data-testid="amex-summary-error">
          <p className="text-body text-neutral-600">The summary did not load.</p>
          {onRetry ? (
            <button type="button" className="press text-label font-semibold text-brand-navy underline" onClick={retry} data-testid="amex-summary-retry">Retry</button>
          ) : null}
        </div>
      ) : !summary ? (
        <div
          className="h-24 animate-pulse rounded-card bg-platinum-2"
          style={lastH.current > 0 ? { height: lastH.current } : undefined}
          data-testid="amex-summary-loading"
          aria-busy="true"
        />
      ) : (
        <div className="space-y-4" ref={bodyRef}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {/* Owed is a figure, not a filter; one card's links to its balance history. */}
            <Figure
              testId="amex-fig-owed"
              label="Owed"
              amount={summary.owed.current}
              sub={owedSub}
              extra={
                <>
                  {tracked ? (
                    <span className="text-micro text-neutral-700" data-testid="amex-owed-tracked">
                      {tracked} ·{" "}
                      <Link href="/avalanche" className="font-semibold text-brand-navy underline" data-testid="amex-owed-tracked-link">
                        Payoff plan
                      </Link>
                    </span>
                  ) : null}
                  {onOwedHistory && !allCards ? (
                    <button
                      type="button"
                      className="press mt-0.5 self-start text-micro font-semibold text-brand-navy underline"
                      onClick={onOwedHistory}
                      data-testid="amex-owed-history-link"
                    >
                      Balance history
                    </button>
                  ) : null}
                </>
              }
            />
            <Figure
              testId="amex-fig-purchases"
              label="Purchases"
              amount={summary.purchases.amount}
              sub={countWord(summary.purchases.count)}
              active={figure === "purchases"}
              onClick={() => toggle("purchases")}
            />
            <Figure
              testId="amex-fig-payments"
              label="Payments"
              amount={summary.payments.amount}
              sub={countWord(summary.payments.count)}
              active={figure === "payments"}
              onClick={() => toggle("payments")}
            />
            <Figure
              testId="amex-fig-credits"
              label="Credits & refunds"
              amount={summary.refunds.amount}
              sub={
                summary.otherCredits.count > 0
                  ? `${countWord(summary.refunds.count)} · other credits ${moneyFace(summary.otherCredits.amount)}`
                  : countWord(summary.refunds.count)
              }
              active={figure === "credits"}
              onClick={() => toggle("credits")}
            />
          </div>
          {allCards ? byCard : payBlock}
          <div className="space-y-1 text-body text-brand-ink" data-testid="amex-plan-lines">
            {plan ? (
              <p data-testid="amex-plan-line">
                {plan.label} <span className="font-mono font-semibold tabular-nums">{moneyFace(plan.amount)}</span>
                {" · "}
                <Link href={plan.to} className={LINK} data-testid="amex-plan-link">{plan.linkText}</Link>
              </p>
            ) : null}
            <p data-testid="amex-household-line">
              {householdLine(summary.householdContribution, mode, isThisWeek)}
              {" · "}
              <AmexOverLink href={whyOverPath(mode, isThisWeek, summary.period, accountRowId)} period={linkPeriod} />
            </p>
            <ToReview summary={summary} attention={attention ?? null} onAttention={onAttention} />
          </div>
          {summary.limitations.some((l) => l.startsWith("tracking_start:")) ? (
            <p className="text-micro text-neutral-600" data-testid="amex-summary-limit">
              Starts {summary.limitations.find((l) => l.startsWith("tracking_start:"))!.slice("tracking_start:".length)}, when H2 began tracking.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/**
 * (P1) THE TO-REVIEW LINE: one button per group the server counted ("1 unplanned
 * · $40.00"), each narrowing the activity to that group's rows. It replaces the
 * old "Needs attention" panel and its second copy of the rows.
 */
function ToReview({
  summary,
  attention,
  onAttention,
}: {
  summary: AmexSummary;
  attention: AmexAttentionGroup | null;
  onAttention?: (g: AmexAttentionGroup | null) => void;
}) {
  const na = summary.needsAttention;
  const shown = ATTENTION_GROUPS.filter((g) => na[g.key].count > 0);
  if (shown.length === 0) {
    return (
      <p className="text-neutral-600" data-testid="amex-review-count">
        <span data-testid="amex-attn-none">Nothing to review in this period.</span>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-testid="amex-review-count">
      <span className="text-neutral-600">To review:</span>
      {shown.map((g) => {
        const grp = na[g.key];
        const on = attention === g.key;
        return (
          <button
            key={g.key}
            type="button"
            aria-pressed={on}
            onClick={() => onAttention?.(on ? null : g.key)}
            data-testid={`amex-attn-${g.key}`}
            className={cn(
              "press inline-flex min-h-8 items-center rounded-control px-2 font-semibold text-brand-navy ring-1 ring-brand-line hover:bg-platinum-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40",
              on && "bg-brand-tint ring-2 ring-brand-navy/40",
            )}
          >
            {grp.count} {g.words} · <span className="ml-1 font-mono tabular-nums">{moneyFace(grp.amount)}</span>
          </button>
        );
      })}
    </p>
  );
}
