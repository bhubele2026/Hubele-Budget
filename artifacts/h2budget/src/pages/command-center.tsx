import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useListPlaidItems } from "@workspace/api-client-react";
import {
  getGetBankingReviewQueryKey,
  useGetBankingReview,
  type BankingReview,
  type BankingReviewBucket,
  type BankingReviewRow,
  type GetBankingReviewParams,
} from "@workspace/api-client-react/features";
import { SyncButton } from "@/components/sync-button";
import { scoped } from "@/lib/queryState";
import { QueryRefreshBanner } from "@/components/query-refresh-banner";
import { useUrlState, type UrlCodec } from "@/hooks/useUrlState";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries, accountViewOf } from "@/pages/next/accounts/entries";
import { cn, formatCurrency, formatRelativeTime } from "@/lib/utils";
import { Help, figLabel, input, toggle } from "@/ui";
import { BalanceCheck } from "./banking/BalanceCheck";
import { BankBalanceWhy } from "@/components/bank-balance-why";
import { BucketRows } from "./banking/BucketRows";
import { ProposedFixes } from "./banking/ProposedFixes";
import { PRESETS, isDay, presetOf, presetRange, rangeWords, sanitizeRange } from "./banking/reviewDates";
import { bankingBase, bankingSummaryParams } from "./banking/reviewParams";
import { BUCKETS, KIND_ORDER, KIND_WORDS, bucketAria, bucketNote, dayWords, isBucketName, isKind, isZeroMoney, kindChipWords, plannedFateWords, sideShort } from "./banking/words";
import { WEEK_FIGURE_WORDS } from "@workspace/avalanche-core/glossary";
import { bankFreshWords, freshKindOf } from "@/lib/bankFreshWords";
import { useSpine } from "@/hooks/useSpine";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import { asOfWords, readingLine } from "@/lib/checkingWords";
import { useOlderSnapshot } from "@/lib/dataAsOf";

/**
 * (W3) ⭐ BANKING › REVIEW — "what wasn't in the plan?" for ONE bank account.
 *
 * Every figure is `GET /banking/review`'s string; this page adds nothing up.
 * The account's own totals lead. The household's week is one small, labelled
 * block at the end, because it is a different thing (all accounts).
 *
 * (Q5) The order is the order of the questions: where am I (account, range,
 * updated, bank vs H2 and its check, pending) → what needs MY decision
 * (Proposed fixes, the To-review count for this account and range) → what was
 * not on the plan → what was planned → the household's week, last.
 *
 * Three words that are NOT the same, and are kept apart on screen:
 *   - "Balance check" — the bank's balance against the ledger (a manual Sync);
 *   - "To review"     — rows still waiting for an answer (one name: the dashboard tile and the top bar say "review" too);
 *   - "Not in the plan" — rows the plan did not expect, or expected differently.
 * A row not on the plan is not overspending; a card or debt payment is a payment.
 *
 * URL state: `?account &from &to &bucket &kind` — a refresh, a shared link and
 * Back from a register land on the same view. The Chase and Amex registers
 * keep their own Sync; this page never starts one (a Sync button appears only
 * for an account at a bank without a register of its own here).
 */
const str: UrlCodec<string> = { read: (raw) => (raw ? raw : null), write: (v) => v || null };
const dayCodec: UrlCodec<string> = { read: (raw) => (isDay(raw) ? raw : null), write: (v) => v || null };
const MIN = 60_000;

const CELL = "surface rounded-card px-4 py-3 ring-1 ring-brand-line";
const CELL_LABEL = cn("flex items-center gap-1.5", figLabel);
const CELL_VALUE = "mt-1 whitespace-nowrap font-mono text-kpi font-semibold tabular-nums text-brand-ink";

const face = (v: string | null | undefined) => (v == null || v === "" ? "—" : formatCurrency(v));
const cents = (v: string | null | undefined) => (v == null ? 0 : Math.round(Number(v) * 100));

/**
 * One bucket as a compact pill: label and count, then the direction-aware total. Amount differences say
 * the variance ("Income $87.87 less · Bills $12.00 over"); the others say what came in and went out
 * ("In $135.13 · Out $4,603.46"). Never a net, never a signed cash line.
 */
function BucketPill({ meta, bucket, selected, onPick }: { meta: (typeof BUCKETS)[number]; bucket: BankingReviewBucket; selected: boolean; onPick: () => void }) {
  const sides = [
    { side: "in" as const, words: sideShort("in", bucket.varianceIn) },
    { side: "out" as const, words: sideShort("out", bucket.varianceOut) },
  ].filter((x): x is { side: "in" | "out"; words: string } => !!x.words);
  const inOut = [
    { side: "in" as const, label: "In", v: bucket.moneyIn },
    { side: "out" as const, label: "Out", v: bucket.moneyOut },
  ].filter((x) => !isZeroMoney(x.v));
  const aria = bucketAria(meta.title, bucket);  // variance lines first, then the count, then in and out
  const second = meta.name === "amountDifference" && sides.length ? "sides" : "inout";
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      aria-label={aria}
      title={aria}
      data-testid={`br-bucket-${meta.name}`}
      className={cn(toggle(selected), "flex flex-col items-stretch justify-start px-3 py-2 text-left")}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-label font-semibold">{meta.title}</span>
        <span className="font-mono text-label font-semibold tabular-nums" data-testid={`br-count-${meta.name}`}>{bucket.count}</span>
      </span>
      {second === "sides" ? (
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-label font-normal text-neutral-600" data-testid={`br-sides-${meta.name}`}>
          {sides.map((x) => <span key={x.side} className="tabular-nums" data-testid={`br-side-${meta.name}-${x.side}`}>{x.words}</span>)}
        </span>
      ) : inOut.length ? (
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-label font-normal text-neutral-600" data-testid={`br-inout-${meta.name}`}>
          {inOut.map((x) => <span key={x.side} className="tabular-nums" data-testid={`br-inout-${meta.name}-${x.side}`}>{x.label} {formatCurrency(x.v)}</span>)}
        </span>
      ) : null}
    </button>
  );
}

/** The page's loading shape: the same blocks as the loaded page, so switching account or range does not collapse it. */
function ReviewSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" data-testid="br-loading">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24 rounded-card" />)}
      </div>
      <div className="skeleton h-10 w-full rounded-card" />
      <div className="skeleton h-72 w-full rounded-card" />
    </div>
  );
}

export default function BankingReviewPage() {
  const today = useMemo(() => householdToday(new Date()), []);
  const [accountParam, setAccount] = useUrlState<string>("account", str, "");
  const [fromParam, setFrom] = useUrlState<string>("from", dayCodec, "");
  const [toParam, setTo] = useUrlState<string>("to", dayCodec, "");
  const [bucketParam, setBucket] = useUrlState<string>("bucket", str, "");
  const [fixesParam] = useUrlState<string>("fixes", str, "");
  const [kindParam, setKind] = useUrlState<string>("kind", str, "");
  const [cursors, setCursors] = useState<string[]>([]);
  const [rowsKey, setRowsKey] = useState("");

  const range = sanitizeRange(fromParam, toParam, today);
  const base: GetBankingReviewParams = bankingBase(accountParam, range);
  // ONE first call: the summary also carries each bucket's first page.
  const summaryParams = bankingSummaryParams(base);
  const q = useGetBankingReview(summaryParams, { query: { queryKey: getGetBankingReviewQueryKey(summaryParams), staleTime: MIN } });
  // (Q4) The review on screen is for THIS account and range. The previous
  // one (kept while this loads) is not: its balance, buckets and rows would sit
  // under the new account's name and the new dates.
  const d = scoped(q, (r) => r.period.to === range.to).data;
  // (T1) An answer built on an older bank reading than the newest seen is labelled and asked again once.
  const olderReading = useOlderSnapshot(q);
  const [checkParam] = useUrlState<string>("check", str, "");
  // (T2) Review difference: opened by its button, by `?check=1`, or from "Why this number?".
  const [explainOpen, setExplainOpen] = useState(checkParam === "1");
  const { runSync, isPending: syncing } = usePlaidSync();

  const items = useListPlaidItems({ query: { staleTime: MIN } as never });
  const entries = useMemo(() => buildEntries(items.data), [items.data]);
  const entriesKnown = items.data !== undefined;
  const banks = useMemo(() => entries.filter((e) => accountViewOf(e) === "bank"), [entries]);

  const accountId = d?.account.id ?? (accountParam || null);
  const here = entries.find((e) => e.rowId === accountId) ?? null;
  const accountLabel = (e: (typeof entries)[number]) => `${e.identity.label}${e.identity.mask4 ? ` ••${e.identity.mask4}` : ""}`;
  const headLabel = d
    ? [d.account.institution, d.account.name].filter(Boolean).join(" ") + (d.account.mask ? ` ••${d.account.mask.slice(-4)}` : "")
    : here
      ? accountLabel(here)
      : "";

  const resetRows = () => {
    setCursors([]);
    setRowsKey("");
  };
  const pickAccount = (id: string) => {
    setAccount(id);
    setBucket("");
    setKind("");
    resetRows();
  };
  const pickRange = (r: { from: string; to: string }) => {
    setFrom(r.from);
    setTo(r.to);
    resetRows();
  };
  const pickBucket = (name: string, kind = "") => {
    setBucket(name);
    setKind(kind);
    resetRows();
  };

  const notIn = d?.notInPlan;
  const bucketOf = (name: (typeof BUCKETS)[number]["name"]) => notIn?.[name];
  const firstFull = BUCKETS.find((b) => (bucketOf(b.name)?.count ?? 0) > 0)?.name ?? "unmatched";
  const selected = isBucketName(bucketParam) ? bucketParam : firstFull;
  const kind = selected === "unmatched" && isKind(kindParam) ? kindParam : null;
  const selMeta = BUCKETS.find((b) => b.name === selected)!;
  const selBucket = bucketOf(selected);
  const selCount = kind && selBucket?.byKind ? selBucket.byKind[kind].count : (selBucket?.count ?? 0);
  // The selected title's own In / Out: the kind's, when a kind is chosen.
  const selTotals = kind && selBucket?.byKind ? selBucket.byKind[kind] : selBucket;
  const showIn = !!selTotals && !isZeroMoney(selTotals.moneyIn);
  const showOut = !!selTotals && !isZeroMoney(selTotals.moneyOut);
  const selNote = selBucket ? bucketNote(selected, selBucket) : null;
  const byKindSel = selected === "unmatched" ? selBucket?.byKind : null;
  const notSpending = !!byKindSel && (byKindSel.card_payment.count > 0 || byKindSel.debt_payment.count > 0 || byKindSel.transfer.count > 0);

  // Where a row opens: the one route rule, with the account, month and row in the address.
  const ext = here?.plaidAccountId ?? null;
  const hrefOf = (r: BankingReviewRow): string | null =>
    txnRoute({ id: r.id, occurredOn: r.date, plaidAccountId: ext, source: null }, entries, { entriesKnown }).href;

  // Rows the review could not place in a bucket (kept apart from the balance check).
  const checkMonth = d?.balanceCheck.checkedAt ? `${d.balanceCheck.checkedAt.slice(0, 7)}-01` : null;
  const registerHref = accountId && checkMonth ? `/transactions?account=${encodeURIComponent(accountId)}&month=${checkMonth}` : null;
  const unplaced = d ? cents(d.reconciliation.unexplained) !== 0 || d.reconciliation.rowsUnexplained !== 0 : false;
  // (Q5) "Updated 2 h ago" is the FETCH (the bank last told us anything) — the SERVER's instant, never a max the browser
  // takes itself: the forecast account's is the review's `freshness.fetchedAt` (= spine.bankConfidence.fetchedAt; a typed
  // balance is as old as its own time, a live feed does not refresh it); another account's is its connection's own
  // `freshness.fetchedAt` from GET /plaid/items.
  const itemFresh = here ? (items.data?.find((it) => it.id === here.itemId)?.freshness ?? null) : null;
  const fresh = d ? (d.freshness ?? itemFresh) : null;
  const freshWords = d ? bankFreshWords({ kind: freshKindOf(fresh?.stale, fresh?.staleReason), fetchedAt: fresh?.fetchedAt, now: Date.now() }) : null;
  const syncedWords = freshWords ? [freshWords.status, freshWords.updated ?? "Not updated yet"].filter(Boolean).join(" · ") : "";
  // "N pending" is the account's, through today (the same figure the dashboard says), not the range's: the forecast account's
  // from the spine; another account's range count says its range.
  const spine = useSpine();
  const pendingWords = !d
    ? null
    : d.account.isForecastAccount
      ? (spine.data?.bankConfidence?.pendingCount ?? 0) > 0 ? `${spine.data!.bankConfidence.pendingCount} pending` : null
      : d.cashFlow.pendingCount > 0 ? `${d.cashFlow.pendingCount} pending in ${rangeWords(range, today)}` : null;
  // (Q5 fix) The to-review chip must open a list that has the same scope as its words. The review page is a calendar
  // month of the planned account: a range that is that month (to today) links there with the month in the address;
  // any other range says the page's own count and scope instead (the server's badge), so count and destination tie.
  const monthOfRange = range.from.slice(0, 7);
  const wholeMonth = range.from === `${monthOfRange}-01` && range.to.slice(0, 7) === monthOfRange && (range.to === today || addDaysISO(range.to, 1).slice(0, 7) !== monthOfRange);
  // (Round 3) Review opens any month back to 12 months (GET /forecast?fromMonth=); a month it cannot reach says the page's own count.
  const oldestReviewMonth = (() => { const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7)) - 12; const dt = new Date(Date.UTC(y, m - 1, 1)); return dt.toISOString().slice(0, 7); })();
  const inboxTies = !!d && d.account.isForecastAccount && wholeMonth && monthOfRange >= oldestReviewMonth && monthOfRange <= today.slice(0, 7);
  const inboxCount = d ? (inboxTies ? d.reviewInbox.unresolvedInRange : d.reviewInbox.badgeCount) : 0;
  const inboxWords = inboxCount === 1 ? "1 charge to match" : inboxCount > 0 ? `${inboxCount} charges to match` : "Nothing to match";
  const inboxScope = inboxTies ? `This account · ${rangeWords(range, today)}` : "Planned account · this month";
  const inboxHref = inboxTies ? `/review?month=${monthOfRange}` : "/review";
  const needsOwnSync = !!d && d.account.id != null && !/chase|american express|amex/i.test(d.account.institution ?? "");
  const activePreset = presetOf(range, today);

  // (Q5) `?fixes=1` lands on the panel: once the page has its own answer (so the layout is final), once.
  const [scrolledToFixes, setScrolledToFixes] = useState(false);
  useEffect(() => {
    if (fixesParam !== "1" || scrolledToFixes || !d) return;
    setScrolledToFixes(true);
    document.getElementById("proposed-fixes")?.scrollIntoView?.({ block: "start" });
  }, [fixesParam, scrolledToFixes, d]);

  return (
    <div className="space-y-4" data-testid="banking-review">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h1 className="text-display font-semibold text-brand-navy">Banking review</h1>
          {needsOwnSync ? <SyncButton asKit compact relevantItemIds={here ? [here.itemId] : undefined} /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {banks.length > 1 || (banks.length === 1 && accountParam) ? (
            <label className="flex items-center gap-2 text-label text-neutral-600">
              <span>Account</span>
              <select
                className={cn(input, "w-auto max-w-[16rem]")}
                value={accountId ?? ""}
                onChange={(e) => pickAccount(e.target.value)}
                aria-label="Account"
                data-testid="br-account"
              >
                {accountId && !banks.some((b) => b.rowId === accountId) ? <option value={accountId}>{headLabel || "This account"}</option> : null}
                {banks.map((b) => <option key={b.rowId} value={b.rowId}>{accountLabel(b)}</option>)}
              </select>
            </label>
          ) : (
            <span className="text-label font-medium text-brand-ink" data-testid="br-account-name">{headLabel}</span>
          )}
          <span className="text-label text-neutral-600" data-testid="br-range">{rangeWords(range, today)}</span>
          <div className="flex gap-1.5" role="group" aria-label="Range">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-pressed={activePreset === p.key}
                onClick={() => pickRange(presetRange(p.key, today))}
                data-testid={`br-preset-${p.key}`}
                className={toggle(activePreset === p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {syncedWords ? (
            <span className="text-micro text-neutral-600" data-testid="br-fresh">
              {syncedWords}
            </span>
          ) : null}
          {pendingWords ? <span className="text-micro text-neutral-600" data-testid="br-pending">{pendingWords}</span> : null}
        </div>
      </header>

      <QueryRefreshBanner q={q} data-testid="br-error" />
      {d === undefined ? (
        q.isError ? null : (
          <ReviewSkeleton />
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="br-summary">
            <div className={CELL}>
              <div className={CELL_LABEL}>H2 balance</div>
              {/* ⭐ (T1) Checking today (the reading rolled forward), as of the reading, and the reading itself —
                  all from THIS response (one moment), never the spine's. An answer on an older reading is grey and says so. */}
              <div className={cn(CELL_VALUE, olderReading.older && "text-neutral-500")} data-testid="br-balance">{face(d.balance.today)}</div>
              <div className="mt-1 text-micro text-neutral-500" data-testid="br-balance-asof">
                {olderReading.words ??
                  (d.balance.today != null && d.balance.asOf ? (asOfWords(d.balance.asOf) ?? "") : "Not tracked for this account")}
              </div>
              {d.balance.today != null ? (
                <div className="text-micro text-neutral-500" data-testid="br-bank-today">
                  {readingLine({ balance: d.balance.reading, at: d.balance.asOf, source: d.freshness?.source })}
                </div>
              ) : null}
              {d.account.isForecastAccount && d.balance.today != null ? (
                <div className="mt-1 text-micro">
                  <BankBalanceWhy
                    trigger={<button type="button" className="press font-semibold text-brand-navy underline" data-testid="br-why">Why this number?</button>}
                    onReviewDifference={d.balanceCheck.status === "off_by" && !d.balanceCheck.stale ? () => setExplainOpen(true) : undefined}
                  />
                </div>
              ) : null}
            </div>
            <div className={CELL}>
              <div className={CELL_LABEL}>Money in</div>
              <div className={CELL_VALUE} data-testid="br-in">{face(d.cashFlow.moneyIn)}</div>
            </div>
            <div className={CELL}>
              <div className={CELL_LABEL}>Money out</div>
              <div className={CELL_VALUE} data-testid="br-out">{face(d.cashFlow.moneyOut)}</div>
            </div>
            <div className={CELL} data-testid="br-tie-cell">
              <div className={CELL_LABEL}>
                Balance check
                <Help>Compares the bank's own balance with H2's at the last Sync.</Help>
              </div>
              <BalanceCheck
                check={d.balanceCheck}
                registerHref={registerHref}
                today={{ h2: d.balance.today, reading: d.balance.reading ?? null, asOf: d.balance.asOf, source: d.freshness?.source ?? null }}
                onSync={d.account.isForecastAccount ? () => void runSync({ itemId: here?.itemId }) : undefined}
                syncing={syncing}
                explain={{ open: explainOpen, onOpenChange: setExplainOpen }}
              />
            </div>
          </div>

          {unplaced ? (
            <div className="rounded-card bg-bad-bg px-4 py-2.5 text-body text-bad ring-1 ring-bad/15" role="status" data-testid="br-unplaced">
              H2 could not place some rows: {formatCurrency(d.reconciliation.unexplained)}
            </div>
          ) : null}

          <section className="space-y-2" aria-label="Needs your decision" data-testid="br-decide">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <h2 className="text-title font-semibold text-brand-navy">Needs your decision</h2>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="br-inbox-cell">
                <Link
                  href={inboxHref}
                  className="press chip gray"
                  data-testid="br-inbox"
                  aria-label={`${inboxWords}, ${inboxScope}`}
                >
                  {inboxWords}
                </Link>
                <span className="text-micro text-neutral-600" data-testid="br-inbox-scope">{inboxScope}</span>
              </div>
            </div>
            <ProposedFixes defaultOpen={fixesParam === "1"} />
          </section>

          <details open className="surface overflow-hidden rounded-card ring-1 ring-brand-line" data-testid="br-notinplan">
            <summary className="press cursor-pointer px-4 py-3 text-title font-semibold text-brand-navy">Not in the plan</summary>
            <div className="space-y-3 border-t border-brand-line pt-3">
              {!d.planComparison.available ? (
                <p className="px-4 text-label text-neutral-600" data-testid="br-no-compare">
                  Plans are compared on the planned account only. Rows here are listed as "Unclear".
                </p>
              ) : null}
              <div role="group" aria-label="Not in the plan" className="grid auto-rows-fr grid-cols-2 gap-2 px-4 sm:grid-cols-3 lg:grid-cols-5">
                {BUCKETS.map((b) => (
                  <BucketPill
                    key={b.name}
                    meta={b}
                    bucket={d.notInPlan[b.name]}
                    selected={selected === b.name}
                    onPick={() => pickBucket(b.name)}
                  />
                ))}
              </div>

              <section className="border-t border-brand-line" data-testid="br-detail" aria-label={selMeta.title}>
                <div className="space-y-1 px-4 pt-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h3 className="text-body font-semibold text-brand-navy">
                      {selMeta.title}{kind ? ` · ${KIND_WORDS[kind]}` : ""}
                      <span className="ml-2 font-mono text-label tabular-nums text-neutral-600" data-testid="br-sel-count">{selCount}</span>
                    </h3>
                    {showIn || showOut ? (
                      <p className="flex gap-x-3 text-label text-neutral-600">
                        {showIn ? <span data-testid="br-sel-in">In <span className="font-mono tabular-nums">{formatCurrency(selTotals!.moneyIn)}</span></span> : null}
                        {showOut ? <span data-testid="br-sel-out">Out <span className="font-mono tabular-nums">{formatCurrency(selTotals!.moneyOut)}</span></span> : null}
                      </p>
                    ) : null}
                  </div>
                  {selNote ? <p className="text-label text-neutral-600" data-testid="br-sel-note">{selNote}</p> : null}
                  {selected === "uncertain" && selBucket?.byReason && selBucket.byReason.not_compared.count > 0 ? (
                    <p className="text-label text-neutral-600" data-testid="br-not-compared">
                      {selBucket.byReason.not_compared.count} not compared: older than 60 days, after today, or on another account.
                    </p>
                  ) : null}
                  {selected === "unmatched" && d.notInPlan.unmatched.byKind && d.notInPlan.unmatched.count > 0 ? (
                    <div className="space-y-1.5 pb-1 pt-1" data-testid="br-kinds">
                      <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-2">
                        <button type="button" aria-pressed={kind === null} onClick={() => pickBucket("unmatched")} data-testid="br-kind-all" className={toggle(kind === null)}>
                          All <span className="font-mono tabular-nums">{d.notInPlan.unmatched.count}</span>
                        </button>
                        {KIND_ORDER.filter((k) => d.notInPlan.unmatched.byKind![k].count > 0).map((k) => (
                          <button
                            key={k}
                            type="button"
                            aria-pressed={kind === k}
                            onClick={() => pickBucket("unmatched", k)}
                            data-testid={`br-kind-${k}`}
                            className={toggle(kind === k)}
                          >
                            {kindChipWords(k, d.notInPlan.unmatched.byKind![k])}
                          </button>
                        ))}
                      </div>
                      {notSpending ? <p className="text-label text-neutral-600">Card and debt payments and transfers are not spending.</p> : null}
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 border-t border-brand-line/70">
                  <BucketRows
                    key={`${accountId}|${range.from}|${range.to}|${selected}|${kind ?? ""}|${rowsKey}`}
                    base={base}
                    bucket={selected}
                    kind={kind}
                    cursors={cursors}
                    onMore={(c) => setCursors((cur) => [...cur, c])}
                    hrefOf={hrefOf}
                    empty={selCount === 0}
                    seed={selBucket ? { rows: selBucket.rows, truncated: selBucket.truncated } : null}
                  />
                </div>
              </section>
            </div>
          </details>

          <details className="surface rounded-card ring-1 ring-brand-line" data-testid="br-planned">
            <summary className="press cursor-pointer px-4 py-3 text-title font-semibold text-brand-navy">
              Planned this period
              <span className="ml-2 font-mono text-label tabular-nums text-neutral-500">{d.planned.length}</span>
            </summary>
            {d.planned.length ? (
              <ul className="divide-y divide-brand-line/70 border-t border-brand-line">
                {d.planned.map((p) => (
                  <li key={p.key} className="flex items-baseline justify-between gap-3 px-4 py-2.5" data-testid="br-planned-row">
                    <div className="min-w-0">
                      <div className="truncate text-body font-medium text-brand-ink">{p.label}</div>
                      <div className="text-micro text-neutral-500">
                        {p.direction === "in" ? "Expected" : "Due"} {dayWords(p.scheduledDate)} · {plannedFateWords(p)}
                        {p.txnAmount != null && p.txnDate ? ` · ${formatCurrency(Math.abs(Number(p.txnAmount)))} on ${dayWords(p.txnDate)}` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-body tabular-nums text-brand-ink">{p.planned == null ? "—" : formatCurrency(Math.abs(Number(p.planned)))}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="border-t border-brand-line px-4 py-3 text-body text-neutral-500">
                {d.planComparison.available ? "Nothing was due in this range." : "Plans are compared on the planned account only."}
              </p>
            )}
          </details>

          {d.household ? (
            <section className="border-t border-brand-line pt-3" data-testid="br-household">
              <h2 className="text-label font-semibold text-brand-navy">Household · this week</h2>
              <dl className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-label">
                <div className="flex gap-2"><dt className="text-neutral-600">{WEEK_FIGURE_WORDS.known}</dt><dd className="font-mono tabular-nums text-brand-ink" data-testid="br-hh-spent">{formatCurrency(d.household.knownWeek)}</dd></div>
                {!isZeroMoney(d.household.unresolvedWeek) ? (
                  <div className="flex gap-2"><dt className="text-neutral-600">{WEEK_FIGURE_WORDS.unresolved}</dt><dd className="font-mono tabular-nums text-brand-ink" data-testid="br-hh-unconfirmed">{formatCurrency(d.household.unresolvedWeek)}</dd></div>
                ) : null}
                <div className="flex gap-2">
                  <dt className="text-neutral-600">Plan</dt>
                  <dd className="font-mono tabular-nums text-brand-ink" data-testid="br-hh-plan">{d.household.weekPlan == null ? "Not set" : formatCurrency(d.household.weekPlan)}</dd>
                </div>
                {d.household.remainingWeekKnown != null ? (
                  <div className="flex gap-2">
                    <dt className="text-neutral-600">{Number(d.household.remainingWeekKnown) < 0 ? "Over" : "Left"}{d.household.provisional ? " so far" : ""}</dt>
                    <dd className="font-mono tabular-nums text-brand-ink" data-testid="br-hh-left">{formatCurrency(Math.abs(Number(d.household.remainingWeekKnown)))}</dd>
                  </div>
                ) : null}
              </dl>
              {!isZeroMoney(d.household.unresolvedWeek) ? (
                <p className="mt-1 text-micro text-neutral-600" data-testid="br-hh-cautious">
                  {WEEK_FIGURE_WORDS.cautious} <span className="font-mono tabular-nums">{formatCurrency(d.household.spentWeek)}</span>
                </p>
              ) : null}
              <Link href="/spending/week" className="press mt-1.5 inline-block text-label font-semibold text-brand-navy hover:underline">Open this week's plan →</Link>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
