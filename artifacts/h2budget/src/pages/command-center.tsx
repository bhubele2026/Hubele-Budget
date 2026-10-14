import { useMemo, useState } from "react";
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
import { useUrlState, type UrlCodec } from "@/hooks/useUrlState";
import { householdToday } from "@/lib/householdDay";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries, accountViewOf } from "@/pages/next/accounts/entries";
import { cn, formatCurrency, formatRelativeTime } from "@/lib/utils";
import { Help, input } from "@/ui";
import { BucketRows } from "./banking/BucketRows";
import { PRESETS, isDay, presetOf, presetRange, rangeWords, sanitizeRange } from "./banking/reviewDates";
import { BUCKETS, KIND_ORDER, KIND_WORDS, dayWords, fateWords, isBucketName, isKind } from "./banking/words";

/**
 * (W3) ⭐ BANKING › REVIEW — "what wasn't in the plan?" for ONE bank account.
 *
 * Every figure is `GET /banking/review`'s string; this page adds nothing up.
 * The account's own totals lead. The household's week is one small, labelled
 * block at the end, because it is a different thing (all accounts).
 *
 * Three words that are NOT the same, and are kept apart on screen:
 *   - "Balance check" — the bank's balance against the ledger (a manual Sync);
 *   - "Review inbox"  — rows still waiting for an answer this month;
 *   - "Not in the plan" — rows the plan did not expect, or expected differently.
 * An unmatched payment is not overspending; a card or debt payment is a payment.
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
const CELL_LABEL = "flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-neutral-500";
const CELL_VALUE = "mt-1 font-mono text-display font-semibold tabular-nums text-brand-ink";

const face = (v: string | null | undefined) => (v == null || v === "" ? "—" : formatCurrency(v));
const cents = (v: string | null | undefined) => (v == null ? 0 : Math.round(Number(v) * 100));

function BalanceCheck({ tie }: { tie: BankingReview["balanceTie"] }) {
  const when = tie.checkedAt ? formatRelativeTime(tie.checkedAt) : "";
  if (tie.status === "ties") {
    return (
      <>
        <div className="mt-1.5"><span className="chip ok" data-testid="br-tie">Ties to bank</span></div>
        {when ? <div className="mt-1 text-micro text-neutral-500">Checked {when}</div> : null}
      </>
    );
  }
  if (tie.status === "drift") {
    const off = tie.unexplained == null ? null : formatCurrency(Math.abs(Number(tie.unexplained)));
    return (
      <>
        <div className="mt-1.5"><span className="chip bad" data-testid="br-tie">{off ? `Off by ${off}` : "Off from bank"}</span></div>
        {when ? <div className="mt-1 text-micro text-neutral-500">Checked {when}</div> : null}
      </>
    );
  }
  return (
    <>
      <div className="mt-1.5"><span className="chip gray" data-testid="br-tie">Not checked yet</span></div>
      <div className="mt-1 text-micro text-neutral-500">A Sync on the register checks it.</div>
    </>
  );
}

function BucketCard({ meta, bucket, selected, onPick }: { meta: (typeof BUCKETS)[number]; bucket: BankingReviewBucket; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      data-testid={`br-bucket-${meta.name}`}
      className={cn(
        "press surface rounded-card px-3 py-3 text-left ring-1",
        selected ? "ring-2 ring-brand-navy" : "ring-brand-line hover:bg-neutral-50",
      )}
    >
      <div className="text-label font-semibold text-brand-navy">{meta.title}</div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="font-mono text-title font-semibold tabular-nums text-brand-ink" data-testid={`br-count-${meta.name}`}>{bucket.count}</span>
        <span className="font-mono text-label tabular-nums text-neutral-600" data-testid={`br-net-${meta.name}`}>{formatCurrency(bucket.net)}</span>
      </div>
      <div className="mt-1 text-micro text-neutral-500">{meta.line}</div>
    </button>
  );
}

export default function BankingReviewPage() {
  const today = useMemo(() => householdToday(new Date()), []);
  const [accountParam, setAccount] = useUrlState<string>("account", str, "");
  const [fromParam, setFrom] = useUrlState<string>("from", dayCodec, "");
  const [toParam, setTo] = useUrlState<string>("to", dayCodec, "");
  const [bucketParam, setBucket] = useUrlState<string>("bucket", str, "");
  const [kindParam, setKind] = useUrlState<string>("kind", str, "");
  const [cursors, setCursors] = useState<string[]>([]);
  const [rowsKey, setRowsKey] = useState("");

  const range = sanitizeRange(fromParam, toParam, today);
  const base: GetBankingReviewParams = {
    ...(accountParam ? { account: accountParam } : {}),
    from: range.from,
    to: range.to,
    rowsPerBucket: 1,
  };
  const q = useGetBankingReview(base, { query: { queryKey: getGetBankingReviewQueryKey(base), staleTime: MIN } });
  const d = q.data;

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

  // Where a row opens: the one route rule, with the account, month and row in the address.
  const ext = here?.plaidAccountId ?? null;
  const hrefOf = (r: BankingReviewRow): string | null =>
    txnRoute({ id: r.id, occurredOn: r.date, plaidAccountId: ext, source: null }, entries, { entriesKnown }).href;

  const unexplained = d ? cents(d.reconciliation.unexplained) !== 0 || d.reconciliation.rowsUnexplained !== 0 : false;
  const syncedWords = d?.account.lastSyncedAt ? `Synced ${formatRelativeTime(d.account.lastSyncedAt)}` : d ? "Not synced yet" : "";
  const needsOwnSync = !!d && d.account.id != null && !/chase|american express|amex/i.test(d.account.institution ?? "");
  const activePreset = presetOf(range, today);

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
                className={cn(
                  "press rounded-control px-2.5 py-1 text-label font-semibold ring-1",
                  activePreset === p.key ? "bg-brand-navy text-white ring-brand-navy" : "bg-white text-neutral-700 ring-brand-line hover:bg-neutral-50",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {syncedWords ? (
            <span className="text-micro text-neutral-500" data-testid="br-fresh">
              {syncedWords}
              {d?.freshness?.stale ? " · may be out of date" : ""}
            </span>
          ) : null}
        </div>
      </header>

      {d === undefined ? (
        q.isError ? (
          <div className="surface rounded-card px-4 py-4 text-body text-neutral-700 ring-1 ring-brand-line" role="alert" data-testid="br-error">
            The review did not load.{" "}
            <button type="button" className="underline" onClick={() => void q.refetch()}>Try again</button>
          </div>
        ) : (
          <div className="skeleton h-24 w-full rounded-card" aria-busy="true" data-testid="br-loading" />
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="br-summary">
            <div className={CELL}>
              <div className={CELL_LABEL}>Balance</div>
              <div className={CELL_VALUE} data-testid="br-balance">{face(d.balance.today)}</div>
              <div className="mt-1 text-micro text-neutral-500">
                {d.balance.today != null && d.balance.asOf ? `as of ${dayWords(d.balance.asOf.slice(0, 10))}` : "Not tracked for this account"}
              </div>
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
                <Help>Compares the bank's own balance with H2's ledger at the last Sync.</Help>
              </div>
              <BalanceCheck tie={d.balanceTie} />
            </div>
            <div className={cn(CELL, "col-span-2 lg:col-span-1")} data-testid="br-inbox-cell">
              <div className={CELL_LABEL}>
                Review inbox
                <Help>{`Rows waiting for an answer: ${d.reviewInbox.badgeScope}.`}</Help>
              </div>
              <div className="mt-1.5">
                <Link href="/review" className="press chip gray" data-testid="br-inbox">
                  {d.reviewInbox.badgeCount > 0 ? `${d.reviewInbox.badgeCount} to review this month` : "Review inbox clear"}
                </Link>
              </div>
            </div>
          </div>

          {unexplained ? (
            <div className="rounded-card bg-bad-bg px-4 py-2.5 text-body text-bad ring-1 ring-bad/15" role="status" data-testid="br-unexplained">
              Some rows couldn't be placed: {formatCurrency(d.reconciliation.unexplained)}
            </div>
          ) : null}

          <details open className="surface rounded-card ring-1 ring-brand-line" data-testid="br-notinplan">
            <summary className="press cursor-pointer px-4 py-3 text-title font-semibold text-brand-navy">Not in the plan</summary>
            <div className="space-y-3 border-t border-brand-line p-4">
              {!d.planComparison.available ? (
                <p className="text-label text-neutral-600" data-testid="br-no-compare">
                  H2 plans from one account. Rows here are listed as "Not sure".
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                {BUCKETS.map((b) => (
                  <BucketCard
                    key={b.name}
                    meta={b}
                    bucket={d.notInPlan[b.name]}
                    selected={selected === b.name}
                    onPick={() => pickBucket(b.name)}
                  />
                ))}
              </div>

              {d.notInPlan.unmatched.byKind && d.notInPlan.unmatched.count > 0 ? (
                <div data-testid="br-kinds">
                  <div className="text-label font-semibold text-brand-navy">Unmatched, by kind</div>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {KIND_ORDER.filter((k) => d.notInPlan.unmatched.byKind![k].count > 0).map((k) => {
                      const t = d.notInPlan.unmatched.byKind![k];
                      const on = selected === "unmatched" && kind === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          aria-pressed={on}
                          onClick={() => pickBucket("unmatched", k)}
                          data-testid={`br-kind-${k}`}
                          className={cn(
                            "press rounded-control px-2.5 py-1 text-label ring-1",
                            on ? "bg-brand-navy text-white ring-brand-navy" : "bg-white text-neutral-700 ring-brand-line hover:bg-neutral-50",
                          )}
                        >
                          {KIND_WORDS[k]} <span className="font-mono tabular-nums">{t.count}</span> · <span className="font-mono tabular-nums">{formatCurrency(t.net)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-micro text-neutral-500">Card and debt payments are not overspending.</p>
                </div>
              ) : null}

              <section className="overflow-hidden rounded-card ring-1 ring-brand-line" data-testid="br-detail" aria-label={selMeta.title}>
                <div className="border-b border-brand-line bg-neutral-50 px-4 py-2.5">
                  <h2 className="text-body font-semibold text-brand-navy">
                    {selMeta.title}{kind ? ` · ${KIND_WORDS[kind]}` : ""}
                    <span className="ml-2 font-mono text-label tabular-nums text-neutral-500">{selCount}</span>
                  </h2>
                  <p className="text-micro text-neutral-500">{selMeta.line}</p>
                  {selected === "uncertain" && selBucket?.byReason && selBucket.byReason.not_compared.count > 0 ? (
                    <p className="mt-0.5 text-micro text-neutral-500" data-testid="br-not-compared">
                      {selBucket.byReason.not_compared.count} not compared: older than 60 days, after today, or on another account.
                    </p>
                  ) : null}
                </div>
                <BucketRows
                  key={`${accountId}|${range.from}|${range.to}|${selected}|${kind ?? ""}|${rowsKey}`}
                  base={base}
                  bucket={selected}
                  kind={kind}
                  cursors={cursors}
                  onMore={(c) => setCursors((cur) => [...cur, c])}
                  hrefOf={hrefOf}
                  empty={selCount === 0}
                />
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
                        Due {dayWords(p.scheduledDate)} · {fateWords(p.fate)}
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
            <section className="surface rounded-card px-4 py-3 ring-1 ring-brand-line" data-testid="br-household">
              <h2 className="text-label font-semibold text-brand-navy">All accounts · this week</h2>
              <dl className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-label">
                <div className="flex gap-2"><dt className="text-neutral-600">Counts toward weekly plan</dt><dd className="font-mono tabular-nums text-brand-ink" data-testid="br-hh-spent">{formatCurrency(d.household.spentWeek)}</dd></div>
                <div className="flex gap-2">
                  <dt className="text-neutral-600">Plan</dt>
                  <dd className="font-mono tabular-nums text-brand-ink" data-testid="br-hh-plan">{d.household.weekPlan == null ? "Plan not set" : formatCurrency(d.household.weekPlan)}</dd>
                </div>
              </dl>
              <Link href="/spending/week" className="press mt-1.5 inline-block text-label font-semibold text-brand-navy hover:underline">Open this week →</Link>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
