import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Panel } from "@/components/next";
import { FindingsList } from "@/components/agent/FindingsList";
import { useOpenFindings } from "@/components/agent/agentHooks";
import { attentionItems, billsDueSoon } from "@/lib/attention";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { categoriesByIdOf, isInflowFiledAsExpense } from "@/lib/categoryDirection";
import { useSpine } from "@/hooks/useSpine";
import { useBillsSummaryQ } from "./queries";
import { RECENT_LIMIT, RECENT_WINDOW_DAYS, useCategoriesQ, useDuplicateCountQ, useRecentTxnsQ, useReviewQueueQ } from "./queriesLazy";
import { BELOW_FOLD } from "./belowFoldSizes";
import { Empty, Gate, LABEL, rise } from "./shared";

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
          <span className={cn("block font-medium", tone === "bad" ? "text-bad" : "text-brand-ink")}>{label}</span>
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
 *   - the bank (reconnect, out of date), the week over its plan, a bill due
 *     today or tomorrow (`lib/attention.ts`, the header's own priority);
 *   - decisions: charges to MATCH to the forecast (`/review`), categories to
 *     CONFIRM (`/review/categories`), possible duplicates (`/transactions`) —
 *     the first two are different queues and are worded so;
 *   - what the proactive monitor noticed, with Why / Resolve / Dismiss.
 * The header shows only the top item; this is the whole list. A source still
 * loading or failed says so, never "nothing waiting".
 */
export default function AttentionPanel() {
  const spine = useSpine();
  const bills = useBillsSummaryQ();
  const queue = useReviewQueueQ();
  const dups = useDuplicateCountQ();
  const findingsQ = useOpenFindings();
  const today = householdToday(new Date());
  const recent = useRecentTxnsQ(today, addDaysISO(today, -RECENT_WINDOW_DAYS));
  const cats = useCategoriesQ();
  const s = spine.data;
  const q = { data: s, isError: spine.state === "failed", refetch: spine.refetch };

  const now = useMemo(() => {
    if (!s) return [];
    const rem = s.position.remainingWeek == null ? null : Number(s.position.remainingWeek);
    return attentionItems({
      bank: s.bank,
      withinPlan: s.position.withinPlan,
      overBy: rem != null && rem < 0 ? -rem : null,
      dueSoon: billsDueSoon(bills.data, today),
      today,
      reviewCount: 0, // the review queue has its own rows below
    }).filter((a) => a.kind !== "nothing");
  }, [s, bills.data, today]);

  // (dash-accuracy) "Income filed under an expense category", by the shared
  // pure rule, over the recent window Recent activity reads (one request).
  const misfiled = useMemo(() => {
    if (recent.data === undefined || cats.data === undefined) return null;
    const byId = categoriesByIdOf(cats.data);
    return recent.data.filter((t) => isInflowFiledAsExpense(t, byId)).map((t) => ({
      id: t.id, description: t.description, category: byId.get(t.categoryId ?? "")?.name ?? null,
    }));
  }, [recent.data, cats.data]);
  const misfiledCapped = (recent.data?.length ?? 0) >= RECENT_LIMIT;
  const findings = findingsQ.data?.findings ?? [];
  const review = s?.reviewCount ?? 0;
  const cat = queue.data?.total ?? 0;
  const dup = dups.data?.duplicateCount ?? 0;
  // (D20) A queue that is still loading or failed is not "nothing waiting".
  const catKnown = queue.data !== undefined;
  const dupKnown = dups.data !== undefined;
  const income = misfiled?.length ?? 0;
  const decisions = review + cat + dup + income;
  const allClear = now.length === 0 && decisions === 0 && catKnown && dupKnown && findings.length === 0;

  return (
    <Panel title="Needs attention" span={7} variant="static"
      className={cn(rise(BELOW_FOLD.attention.rise), BELOW_FOLD.attention.minH)} data-testid="dash-attention">
      <Gate q={q} what="Needs attention" rows={4}>
        {() =>
          allClear ? (
            <Empty>Nothing needs you today.</Empty>
          ) : (
            <div className="space-y-4">
              {now.length ? (
                <Group title="Now">
                  {now.map((a) => (
                    <Row key={a.kind} href={a.action?.href ?? "/settings"} label={a.title} detail={a.detail}
                      testid={`dash-att-${a.kind}`} tone={a.kind === "reconnect" || a.kind === "over" ? "bad" : undefined} />
                  ))}
                </Group>
              ) : null}
              {decisions > 0 || !catKnown || !dupKnown ? (
                <Group title="Decisions waiting">
                  {review > 0 ? <Row href="/review" count={review} label="Charges to match to the forecast" testid="dash-review-forecast" /> : null}
                  {!catKnown ? (
                    <PendingRow failed={!!queue.isError} label="Categories to confirm" testid="dash-review-cats-pending" onRetry={queue.refetch ? () => void queue.refetch() : undefined} />
                  ) : cat > 0 ? (
                    <Row href={CATEGORIZATION_QUEUE_HREF} count={cat} label="Categories to confirm" testid="dash-review-cats" />
                  ) : null}
                  {!dupKnown ? (
                    <PendingRow failed={!!dups.isError} label="Possible duplicates" testid="dash-review-dups-pending" onRetry={dups.refetch ? () => void dups.refetch() : undefined} />
                  ) : dup > 0 ? (
                    <Row href="/transactions" count={dup} label="Possible duplicates" testid="dash-review-dups" />
                  ) : null}
                  {income > 0 ? (
                    <Row
                      href={`/transactions?tx=${encodeURIComponent(misfiled![0]!.id)}${misfiled![0]!.category ? `&category=${encodeURIComponent(misfiled![0]!.category)}` : ""}`}
                      count={income}
                      label="Income filed under an expense category"
                      detail={`${misfiled![0]!.description}${misfiled![0]!.category ? ` · ${misfiled![0]!.category}` : ""}${income > 1 ? ` and ${income - 1} more` : ""} · last ${RECENT_WINDOW_DAYS} days${misfiledCapped ? `, newest ${RECENT_LIMIT} rows` : ""}`}
                      testid="dash-review-income"
                    />
                  ) : null}
                </Group>
              ) : null}
              {findings.length ? (
                <div data-testid="dash-findings">
                  <h3 className={cn(LABEL, "px-2")}>What H2 noticed</h3>
                  <div className="mt-1 px-2">
                    <FindingsList findings={findings} />
                  </div>
                </div>
              ) : null}
            </div>
          )
        }
      </Gate>
    </Panel>
  );
}
