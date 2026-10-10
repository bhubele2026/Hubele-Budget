import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Panel } from "@/components/next";
import { FindingsList } from "@/components/agent/FindingsList";
import { useOpenFindings } from "@/components/agent/agentHooks";
import { attentionItems } from "@/lib/attention";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { accountTypesOf, categoriesByIdOf, isCardTxn, isInflowFiledAsExpense } from "@/lib/categoryDirection";
import { txnRoute } from "@/lib/accountRoute";
import { buildEntries } from "@/pages/next/accounts/entries";
import { useSpine } from "@/hooks/useSpine";
import { useCashSignalQ, usePlaidItemsQ } from "./queries";
import { dueSoonOf, upcomingRows } from "./obligations";
import { bankLines } from "./bankState";
import { RECENT_LIMIT, RECENT_WINDOW_DAYS, useCategoriesQ, useDuplicateCountQ, useRecentTxnsQ, useReviewQueueQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { useFoldMinH } from "./foldDensity";
import { Empty, LABEL, rise } from "./shared";

/** (F1) The categorization queue's own screen, Review › Categories. */
export const CATEGORIZATION_QUEUE_HREF = "/review/categories";

const ROW_CLASS =
  "flex items-baseline justify-between gap-3 rounded-control px-2 py-2 text-label hover:bg-platinum-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";

function Row({ href, label, detail, count, testid, tone }: {
  href: string; label: string; detail?: string; count?: number; testid: string; tone?: "bad";
}) {
  return (
    <li>
      <Link href={href} data-testid={testid} className={ROW_CLASS}>
        <span className="min-w-0">
          <span className={cn("block font-medium", tone === "bad" ? "text-bad-ink" : "text-brand-ink")}>{label}</span>
          {detail ? <span className="block text-micro text-neutral-500">{detail}</span> : null}
        </span>
        {count != null ? <span className="shrink-0 font-mono font-semibold tabular-nums text-brand-navy">{count}</span> : <span aria-hidden className="shrink-0 text-neutral-400">›</span>}
      </Link>
    </li>
  );
}

/** A source that has not answered is never a zero. */
function PendingRow({ failed, label, testid, onRetry }: { failed: boolean; label: string; testid: string; onRetry?: () => void }) {
  return (
    <li data-testid={testid} className="flex items-baseline justify-between gap-2 px-2 py-2 text-label text-neutral-600">
      <span>{label}</span>
      {failed ? (
        <span role="alert">
          did not load
          {onRetry ? (
            <button type="button" onClick={onRetry} className="ml-2 font-semibold text-brand-navy underline">Try again</button>
          ) : null}
        </span>
      ) : (
        <span aria-busy="true">loading…</span>
      )}
    </li>
  );
}

/** "<description> · <category> and N more · last 30 days[, newest 100 rows only]". */
function incomeDetail(first: { description: string; category: string | null }, count: number, capped: boolean): string {
  return `${first.description}${first.category ? ` · ${first.category}` : ""}${count > 1 ? ` and ${count - 1} more` : ""} · last ${RECENT_WINDOW_DAYS} days${capped ? `, newest ${RECENT_LIMIT} rows only` : ""}`;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className={cn(LABEL, "px-2")}>{title}</h3>
      <ul className="mt-1 list-none p-0">{children}</ul>
    </div>
  );
}

/**
 * ⭐ NEEDS ATTENTION: ONE list for everything that waits on the household.
 *   - Now: a bank to reconnect (any bank), an out-of-date balance, the week
 *     over its plan, a payment leaving checking today or tomorrow;
 *   - Decisions waiting: charges to MATCH to the forecast (`/review`),
 *     categories to CONFIRM (`/review/categories`), possible duplicates
 *     (`/transactions`), income filed under an expense category — the first
 *     two are different queues and are worded so;
 *   - What H2 noticed: the monitor's findings, with Why / Resolve / Dismiss.
 * EVERY SOURCE STANDS ON ITS OWN. A source still loading or failed says so in
 * its own row ("loading…" / "did not load · Try again"), never "nothing
 * waiting", and the all-clear waits for every one of them. A spine failure
 * hides only what the spine carries (the bank, the week, the match count):
 * the queues and the findings, with their actions, still show.
 */
export default function AttentionPanel() {
  const minH = useFoldMinH("attention");
  const spine = useSpine();
  const cash = useCashSignalQ(90);
  const queue = useReviewQueueQ();
  const dups = useDuplicateCountQ();
  const findingsQ = useOpenFindings();
  const items = usePlaidItemsQ();
  const today = householdToday(new Date());
  const recent = useRecentTxnsQ(today, addDaysISO(today, -RECENT_WINDOW_DAYS));
  const cats = useCategoriesQ();
  const s = spine.data;

  // "Now" stands without the spine: a reconnect comes from the bank items and
  // a payment due from the cash signal; the spine adds the balance and the week.
  const now = useMemo(() => {
    const rem = s?.position.remainingWeek == null ? null : Number(s.position.remainingWeek);
    return attentionItems({
      bank: s?.bank,
      withinPlan: s?.position.withinPlan ?? null,
      overBy: rem != null && rem < 0 ? -rem : null,
      dueSoon: cash.data ? dueSoonOf(upcomingRows({ signal: cash.data, today, count: 50 }), today, addDaysISO(today, 1)) : [],
      today,
      reviewCount: 0, // the review queue has its own rows below
      reauthBanks: bankLines(items.data, Date.now()).filter((b) => b.state === "reauth").map((b) => b.institution),
      // (WP6) The same "runs short" item the header's action reads.
      forecast: s?.forecast ?? null,
    }).filter((a) => a.kind !== "nothing");
  }, [s, cash.data, today, items.data]);

  // (dash-accuracy) "Income filed under an expense category", by the shared
  // pure rule, over the recent window Recent activity reads (one request).
  // (WP7) Each row opens the ledger that lists it, on its month (`txnRoute`),
  // keeping the category filter; a row no ledger lists says so instead.
  // Where a row opens needs the linked accounts too: without them every row
  // would read "no longer linked", so the check waits for them as well.
  // (WP5c) The rule also needs to know which rows sit on a card (a card's
  // credits are refunds and payments, whatever the issuer) — from the same items.
  const misfiled = useMemo(() => {
    if (recent.data === undefined || cats.data === undefined || items.data === undefined) return null;
    const byId = categoriesByIdOf(cats.data);
    const entries = buildEntries(items.data);
    const types = accountTypesOf(items.data);
    return recent.data
      .filter((t) => isInflowFiledAsExpense(t, byId, { isCardAccount: isCardTxn(t, types) }))
      .map((t) => {
        const category = byId.get(t.categoryId ?? "")?.name ?? null;
        return { id: t.id, description: t.description, category, route: txnRoute(t, entries, { extra: { category } }) };
      });
  }, [recent.data, cats.data, items.data]);
  // The window is the newest RECENT_LIMIT rows: when it is full, older rows of
  // the 30 days were not checked, and the panel says so whatever it found.
  const misfiledCapped = (recent.data?.length ?? 0) >= RECENT_LIMIT;
  const findings = findingsQ.data?.findings ?? [];

  const spineKnown = s !== undefined;
  const cashKnown = cash.data !== undefined;
  const catKnown = queue.data !== undefined;
  const dupKnown = dups.data !== undefined;
  const incomeKnown = misfiled !== null;
  const findingsKnown = findingsQ.data !== undefined;

  const review = s?.reviewCount ?? 0;
  const cat = queue.data?.total ?? 0;
  const dup = dups.data?.duplicateCount ?? 0;
  const income = misfiled?.length ?? 0;
  const decisions = review + cat + dup + income;
  const allKnown = spineKnown && cashKnown && catKnown && dupKnown && incomeKnown && findingsKnown;
  // Never "nothing" while a source is out, or while the income check was cut short.
  const allClear = allKnown && !misfiledCapped && now.length === 0 && decisions === 0 && findings.length === 0;
  const retry = (q: { refetch?: () => unknown }) => (q.refetch ? () => void q.refetch!() : undefined);
  const spineFailed = spine.state === "failed";

  return (
    <Panel title="Needs attention" span={7} variant="static"
      className={cn(rise(BELOW_FOLD.attention.rise), minH, "self-start")} data-testid="dash-attention">
      {allClear ? (
        <Empty>Nothing needs you today.</Empty>
      ) : (
        <div className="space-y-4">
          {now.length || !spineKnown || !cashKnown ? (
            <Group title="Now">
              {now.map((a) => (
                <Row key={a.kind} href={a.action?.href ?? "/settings"} label={a.title} detail={a.detail}
                  testid={`dash-att-${a.kind}`} tone={a.kind === "reconnect" || a.kind === "over" || a.kind === "short" ? "bad" : undefined} />
              ))}
              {!spineKnown ? (
                <PendingRow failed={spineFailed} label="Your bank balance and this week's plan" testid="dash-att-spine-pending" onRetry={spine.refetch} />
              ) : null}
              {!cashKnown ? (
                <PendingRow failed={!!cash.isError} label="Payments due today or tomorrow" testid="dash-att-due-pending" onRetry={retry(cash)} />
              ) : null}
            </Group>
          ) : null}
          {decisions > 0 || misfiledCapped || !spineKnown || !catKnown || !dupKnown || !incomeKnown ? (
            <Group title="Decisions waiting">
              {!spineKnown ? (
                <PendingRow failed={spineFailed} label="Charges to match to the forecast" testid="dash-review-forecast-pending" onRetry={spine.refetch} />
              ) : review > 0 ? (
                <Row href="/review" count={review} label="Charges to match to the forecast" testid="dash-review-forecast" />
              ) : null}
              {!catKnown ? (
                <PendingRow failed={!!queue.isError} label="Categories to confirm" testid="dash-review-cats-pending" onRetry={retry(queue)} />
              ) : cat > 0 ? (
                <Row href={CATEGORIZATION_QUEUE_HREF} count={cat} label="Categories to confirm" testid="dash-review-cats" />
              ) : null}
              {!dupKnown ? (
                <PendingRow failed={!!dups.isError} label="Possible duplicates" testid="dash-review-dups-pending" onRetry={retry(dups)} />
              ) : dup > 0 ? (
                <Row href="/transactions" count={dup} label="Possible duplicates" testid="dash-review-dups" />
              ) : null}
              {!incomeKnown ? (
                <PendingRow
                  failed={!!recent.isError || !!cats.isError || !!items.isError}
                  label="Income filed under an expense category"
                  testid="dash-review-income-pending"
                  onRetry={() => { void recent.refetch(); void cats.refetch(); void items.refetch(); }}
                />
              ) : income > 0 ? (
                misfiled![0]!.route.href ? (
                  <Row
                    href={misfiled![0]!.route.href}
                    count={income}
                    label="Income filed under an expense category"
                    detail={incomeDetail(misfiled![0]!, income, misfiledCapped)}
                    testid="dash-review-income"
                  />
                ) : (
                  // (WP7) The row's account is on no ledger H2 has: say so, never a dead link.
                  <li data-testid="dash-review-income" className="flex items-baseline justify-between gap-3 px-2 py-2 text-label">
                    <span className="min-w-0">
                      <span className="block font-medium text-brand-ink">Income filed under an expense category</span>
                      <span className="block text-micro text-neutral-600">
                        {incomeDetail(misfiled![0]!, income, misfiledCapped)} · {misfiled![0]!.route.note}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono font-semibold tabular-nums text-brand-navy">{income}</span>
                  </li>
                )
              ) : misfiledCapped ? (
                <li data-testid="dash-review-income-capped" className="px-2 py-2 text-label text-neutral-600">
                  <span className="block font-medium text-brand-ink">Income filed under an expense category</span>
                  <span className="block text-micro text-neutral-600">
                    None in the newest {RECENT_LIMIT} rows; older rows of the last {RECENT_WINDOW_DAYS} days were not checked.
                  </span>
                </li>
              ) : null}
            </Group>
          ) : null}
          {!findingsKnown ? (
            <Group title="What H2 noticed">
              <PendingRow failed={!!findingsQ.isError} label="The monitor's findings" testid="dash-findings-pending" onRetry={retry(findingsQ)} />
            </Group>
          ) : findings.length ? (
            <div data-testid="dash-findings">
              <h3 className={cn(LABEL, "px-2")}>What H2 noticed</h3>
              <div className="mt-1 px-2">
                {/* (WP6) A finding about one category names it ("Groceries spending is speeding up"). */}
                <FindingsList findings={findings} categoryNameOf={(id) => cats.data?.find((c) => c.id === id)?.name ?? null} />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
