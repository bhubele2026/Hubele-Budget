import { Link } from "wouter";
import type { PeriodBreakdown, PeriodBreakdownCategory, PeriodBreakdownGroup, PeriodBreakdownRow } from "@workspace/api-client-react";
import { CssFillMeter } from "@/lib/cssBars";
import { shortDate } from "@/components/next/shortDate";
import { evidenceWords, paymentWords, suggestionWords, whyNotCounted } from "@/lib/evidenceWords";
import { cn, formatCurrency } from "@/lib/utils";
import type { TxnRoute } from "@/lib/accountRoute";

/**
 * (W5) The categories behind a period's figure and the transactions behind each.
 * Display only: every amount, share, "usual" and reason is the server's
 * (`GET /money/period-breakdown`); the only comparisons here decide whether a
 * chip is drawn. Each row opens its register through `routeOf` (`txnRoute`).
 */
export const UNFILED_TOKEN = "unfiled";
export const NO_CATEGORY_TOKEN = "none";

export const categoryToken = (c: PeriodBreakdownCategory): string => c.categoryId ?? NO_CATEGORY_TOKEN;

const cents = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 100);

/** Largest first, ties by name: the order the page lists them in. */
export function sortedCategories(cats: readonly PeriodBreakdownCategory[]): PeriodBreakdownCategory[] {
  return [...cats].sort((a, b) => cents(b.amount) - cents(a.amount) || (a.name ?? "").localeCompare(b.name ?? ""));
}

function reasonWords(r: PeriodBreakdownRow): string {
  const parts: string[] = [];
  if (r.reason.coverage === "refund") parts.push("Refund");
  else if (r.reason.rule === "weekly_flag") parts.push("Marked weekly");
  else if (r.reason.rule === "monthly_flag") parts.push("Marked monthly");
  else if (r.reason.rule === "unfiled") parts.push("Not filed yet");
  if (r.splitPart) parts.push(`Part ${r.splitPart.index + 1} of ${r.splitPart.count} of ${formatCurrency(r.splitPart.parentAmount)}`);
  return parts.join(" · ");
}

function accountWords(a: PeriodBreakdownRow["account"]): string {
  const name = a.name ?? a.institution;
  if (!name) return "No linked account";
  return a.mask ? `${name} ••${a.mask}` : name;
}

export type RowKind = "known" | "payment" | "unresolved";

/** The second line of a row: why it sits in its group (the server's evidence, in words). */
function rowNote(r: PeriodBreakdownRow, kind: RowKind): string {
  if (kind === "payment") return paymentWords(r.evidence);
  // The evidence already says what it probably is ("bank says loan payment"); the suggestion fills in only when there is none.
  if (kind === "unresolved") return evidenceWords(r.evidence) ? whyNotCounted(r.evidence) : [suggestionWords(r.evidence), whyNotCounted(r.evidence)].filter(Boolean).join(" · ");
  return reasonWords(r);
}

function RowList({ rows, count, truncated, routeOf, kind = "known" }: {
  rows: readonly PeriodBreakdownRow[];
  count: number;
  truncated: boolean;
  routeOf: (r: PeriodBreakdownRow) => TxnRoute;
  kind?: RowKind;
}) {
  return (
    <div className="border-t border-brand-line bg-brand-tint/40" data-testid="sp-rows">
      <ul className="divide-y divide-brand-line">
        {rows.map((r, i) => {
          const route = routeOf(r);
          const merchant = <span className="min-w-0 truncate font-medium text-brand-ink">{r.displayName}</span>;
          return (
            <li key={`${r.id}-${i}`} className="px-4 py-2" data-testid="sp-row">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2 text-body">
                  <span className="shrink-0 text-micro text-neutral-600">{shortDate(r.date)}</span>
                  {route.href ? (
                    <Link href={route.href} className="min-w-0 truncate hover:underline" data-testid="sp-row-link">{merchant}</Link>
                  ) : (
                    <span className="min-w-0 truncate" title={route.note ?? undefined}>{merchant}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-body tabular-nums text-brand-ink" data-testid="sp-row-amount">{formatCurrency(r.amount)}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-neutral-600">
                <span className="chip gray" data-testid="sp-row-account">{accountWords(r.account)}</span>
                {r.pending ? <span className="chip warn">Pending</span> : null}
                <span data-testid="sp-row-note">{rowNote(r, kind)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {truncated ? (
        <p className="px-4 py-2 text-micro text-neutral-600" data-testid="sp-truncated">
          Showing the largest {rows.length} of {count}.
        </p>
      ) : null}
    </div>
  );
}

function GroupHead({ id, open, onToggle, title, amount, sub, bar, chips }: {
  id: string;
  open: boolean;
  onToggle: () => void;
  title: string;
  amount: string;
  sub?: string;
  bar?: React.ReactNode;
  chips?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={`sp-${id}`}
      onClick={onToggle}
      className="press block w-full px-4 py-3 text-left hover:bg-brand-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy"
      data-testid={`sp-group-${id}`}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-body font-semibold text-brand-ink">{title}</span>
        <span className="shrink-0 font-mono text-body font-semibold tabular-nums text-brand-ink" data-testid={`sp-group-amount-${id}`}>{amount}</span>
      </span>
      {sub ? <span className="mt-0.5 block text-micro text-neutral-600">{sub}</span> : null}
      {bar}
      {chips ? <span className="mt-1 flex flex-wrap items-center gap-2 text-micro text-neutral-600">{chips}</span> : null}
    </button>
  );
}

/** The ids of the rows the server calls unresolved: they sit in the pool but not in "Counts toward plan". */
export function unresolvedIds(data: PeriodBreakdown): Set<string> {
  return new Set(data.unresolved.rows.map((r) => r.id));
}

/** "Wed" for a week, "Oct 14" for a month: where "usual" was read to. */
export function usualPoint(data: Pick<PeriodBreakdown, "period" | "usualBasis" | "usualThrough">): string | null {
  if (data.usualBasis !== "same_days" || !data.usualThrough) return null;
  return data.period === "week" ? weekdayWords(data.usualThrough) : dayWords(data.usualThrough);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function weekdayWords(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return WEEKDAYS[d.getUTCDay()] ?? iso;
}
function dayWords(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""} ${Number(iso.slice(8, 10))}`;
}

/** "usual by Oct 14" / "usual" (a past period is read whole). */
export function usualLabel(data: Pick<PeriodBreakdown, "period" | "usualBasis" | "usualThrough">): string {
  const at = usualPoint(data);
  return at ? `usual by ${at}` : data.period === "week" ? "usual for a full week" : "usual for a full month";
}

/**
 * One line under "Why over?": the server's figures, in the owner's order.
 * "Over $60.02 · Subscriptions $560.02 so far vs usual by Oct 14 $500.00 · plan $500.00".
 * The category is the one the server says is furthest above its usual.
 */
export function whyOverLine(data: PeriodBreakdown): string | null {
  if (data.over == null || cents(data.over) <= 0) return null;
  const parts = [`${data.provisional ? "Over so far" : "Over"} ${formatCurrency(data.over)}`];
  let top: PeriodBreakdownCategory | null = null;
  for (const c of data.categories) if (c.aboveUsual != null && cents(c.aboveUsual) > 0 && (!top || cents(c.aboveUsual) > cents(top.aboveUsual))) top = c;
  if (top && top.usual != null) parts.push(`${top.name ?? "No category"} ${formatCurrency(top.amount)} so far vs ${usualLabel(data)} ${formatCurrency(top.usual)}`);
  if (data.plan.amount != null) parts.push(`plan ${formatCurrency(data.plan.amount)}`);
  return parts.join(" · ");
}

/** "Unconfirmed $1,300.19 may change this · Lrk Loans — bank says loan payment" (the biggest unconfirmed row). */
export function provisionalLine(data: PeriodBreakdown): string | null {
  if (!data.provisional) return null;
  const top = data.unresolved.rows[0];
  const words = top ? evidenceWords(top.evidence) : "";
  return `Unconfirmed ${formatCurrency(data.unresolved.amount)} may change this${top && words ? ` · ${top.displayName} — ${words}` : ""}`;
}

export function Breakdown({ data, open, onToggle, routeOf }: {
  data: PeriodBreakdown;
  open: readonly string[];
  onToggle: (token: string) => void;
  routeOf: (r: PeriodBreakdownRow) => TxnRoute;
}) {
  const cats = sortedCategories(data.categories);
  const actual = Number(data.actual);
  const over = data.over != null && cents(data.over) > 0;
  const unfiled: PeriodBreakdownGroup = data.needsClassification;
  // The unfiled rows that count (the unresolved ones are listed under "Unconfirmed").
  const hold = unresolvedIds(data);
  const unfiledKnown = unfiled.rows.filter((r) => !hold.has(r.id));
  const showUnfiled = unfiledKnown.length > 0;
  const usual = usualLabel(data);
  const unconfirmed = data.unresolved;
  const payments = data.excludedPayments;
  const why = whyOverLine(data);
  return (
    <section className="surface rounded-card ring-1 ring-brand-line" data-testid="sp-breakdown">
      <h2 className="border-b border-brand-line px-4 py-2.5 text-title font-semibold text-brand-navy">
        {over ? (data.provisional ? "Why over so far?" : "Why over?") : "Where it went"}
      </h2>
      {why ? <p className="border-b border-brand-line px-4 py-2 text-label text-neutral-700" data-testid="sp-why-line">{why}</p> : null}

      <div data-testid="sp-known">
        <div className="flex items-baseline justify-between gap-3 border-b border-brand-line bg-brand-tint/40 px-4 py-2">
          <h3 className="text-label font-semibold uppercase tracking-wide text-neutral-600">Counts toward plan</h3>
          <span className="font-mono text-body font-semibold tabular-nums text-brand-ink" data-testid="sp-known-amount">{formatCurrency(data.known)}</span>
        </div>
        {cats.length === 0 && !showUnfiled ? (
          <p className="px-4 py-4 text-body text-neutral-600" data-testid="sp-empty">Nothing counted against this plan.</p>
        ) : null}
        <ul className="divide-y divide-brand-line">
          {cats.map((c) => {
            const token = categoryToken(c);
            const isOpen = open.includes(token);
            const amount = Number(c.amount);
            return (
              <li key={token}>
                <GroupHead
                  id={token}
                  open={isOpen}
                  onToggle={() => onToggle(token)}
                  title={c.name ?? "No category"}
                  amount={formatCurrency(c.amount)}
                  sub={`${c.count} ${c.count === 1 ? "transaction" : "transactions"}`}
                  bar={<CssFillMeter className="mt-1.5" value={Math.max(0, amount)} ceiling={Math.max(actual, amount, 0)} />}
                  chips={
                    <>
                      {c.usual != null ? <span data-testid={`sp-usual-${token}`}>{usual} {formatCurrency(c.usual)}</span> : null}
                      {c.aboveUsual != null && cents(c.aboveUsual) > 0 ? (
                        <span className="chip warn" data-testid={`sp-above-${token}`}>above usual {formatCurrency(c.aboveUsual)}</span>
                      ) : null}
                    </>
                  }
                />
                {isOpen ? (
                  <div id={`sp-${token}`}>
                    <RowList rows={c.rows.filter((r) => !hold.has(r.id))} count={c.count} truncated={c.truncated} routeOf={routeOf} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {showUnfiled ? (
          <div className="border-t border-brand-line" data-testid="sp-unfiled">
            <GroupHead
              id={UNFILED_TOKEN}
              open={open.includes(UNFILED_TOKEN)}
              onToggle={() => onToggle(UNFILED_TOKEN)}
              title="Not filed yet"
              amount={`${unfiledKnown.length} ${unfiledKnown.length === 1 ? "transaction" : "transactions"}`}
              sub={unfiled.countsAgainstPlan ? "Counts toward the weekly plan until filed" : "Not counted against this plan"}
            />
            {open.includes(UNFILED_TOKEN) ? (
              <div id={`sp-${UNFILED_TOKEN}`}>
                <RowList rows={unfiledKnown} count={unfiledKnown.length} truncated={unfiled.truncated} routeOf={routeOf} />
              </div>
            ) : null}
            <div className="px-4 pb-3">
              {/* More › Categories: the filing queue. */}
              <Link href="/review/categories" className="text-label font-medium text-brand-navy underline" data-testid="sp-file-link">
                File them in Categories
              </Link>
            </div>
          </div>
        ) : null}
      </div>

      {payments.count > 0 || cents(payments.amount) !== 0 ? (
        <div className="border-t border-brand-line" data-testid="sp-payments">
          <GroupHead
            id="payments"
            open={open.includes("payments")}
            onToggle={() => onToggle("payments")}
            title="Payments & transfers (not spending)"
            amount={formatCurrency(payments.amount)}
            sub="Money out that is not spending. Not in the plan figure."
          />
          {open.includes("payments") ? (
            <div id="sp-payments">
              <RowList rows={payments.rows} count={payments.count} truncated={payments.truncated} routeOf={routeOf} kind="payment" />
            </div>
          ) : null}
        </div>
      ) : null}

      {unconfirmed.count > 0 ? (
        <div className="border-t border-brand-line" data-testid="sp-unconfirmed">
          <GroupHead
            id="unconfirmed"
            open={open.includes("unconfirmed")}
            onToggle={() => onToggle("unconfirmed")}
            title="Unconfirmed"
            amount={formatCurrency(unconfirmed.amount)}
            sub="Not counted yet. H2 is not sure these are spending."
          />
          {open.includes("unconfirmed") ? (
            <div id="sp-unconfirmed-rows">
              <RowList rows={unconfirmed.rows} count={unconfirmed.count} truncated={unconfirmed.truncated} routeOf={routeOf} kind="unresolved" />
              {cents(unconfirmed.nettedByRefunds) !== 0 ? (
                <p className="px-4 py-2 text-micro text-neutral-600" data-testid="sp-netted">Refunds on the same account took {formatCurrency(unconfirmed.nettedByRefunds)} off these.</p>
              ) : null}
            </div>
          ) : null}
          <div className="px-4 pb-3">
            <Link href="/banking?fixes=1" className="text-label font-medium text-brand-navy underline" data-testid="sp-fixes-link">
              See proposed fixes
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
