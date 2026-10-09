import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "wouter";
import { AffordLauncher } from "@/components/afford/AffordLauncher";
import { WaysBackLauncher } from "@/components/ways-back/WaysBackLauncher";
import { attentionItems, headerActionOf } from "@/lib/attention";
import { lowPointView } from "@/lib/lowPoint";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { useSpine } from "@/hooks/useSpine";
import { btn, btnSecondary } from "@/ui";
import { cn } from "@/lib/utils";
import { useCashSignalQ, usePlaidItemsQ } from "./queries";
import { dueSoonOf, obligationLine, upcomingRows } from "./obligations";
import { bankLines, hasLinkedBank } from "./bankState";
import { money, rise, weekdayLabel } from "./shared";

/** The quiet second control beside a more urgent action: Afford stays one tap away. */
const QUIET = "bg-transparent px-1 text-label font-semibold text-brand-navy ring-0 hover:bg-transparent hover:underline";

/** The morning text preview (and the request behind it) load on first open only. */
const RecapPreview = lazy(() => import("./RecapPreview"));

/**
 * ⭐ THE HEADER: what day it is, one factual line built from the spine, how
 * fresh each bank is, and ONE action. Eager (first screen), no panel chrome:
 * it is the page's own head, not a card.
 */
export default function DashboardHeader() {
  const spine = useSpine();
  const items = usePlaidItemsQ();
  // The same hook-aware cash-signal events Coming up lists (shared by key).
  const cash = useCashSignalQ(90);
  const [recapOpen, setRecapOpen] = useState(false);
  const today = householdToday(new Date());
  const s = spine.data;
  const now = Date.now();
  const obligations = useMemo(() => upcomingRows({ signal: cash.data, today, count: 50 }), [cash.data, today]);

  const attention = useMemo(() => {
    if (!s) return null;
    const rem = s.position.remainingWeek == null ? null : Number(s.position.remainingWeek);
    return attentionItems({
      bank: s.bank,
      withinPlan: s.position.withinPlan,
      overBy: rem != null && rem < 0 ? -rem : null,
      dueSoon: dueSoonOf(obligations, today, addDaysISO(today, 1)),
      today,
      reviewCount: s.reviewCount,
      reauthBanks: bankLines(items.data, Date.now()).filter((b) => b.state === "reauth").map((b) => b.institution),
    });
  }, [s, obligations, today, items.data]);
  const noBank = items.data !== undefined && !hasLinkedBank(items.data);
  // Under the buffer, or below zero, inside the forecast's 90 days.
  const low = s ? lowPointView(s.forecast, { buffer: s.forecast.cashBuffer }) : null;
  const runsShort = !!low && (low.kind === "below" || (low.value != null && low.value < 0));
  const action = headerActionOf(attention ?? [], { noBank, runsShort });
  const banks = bankLines(items.data, now);

  // One line of facts, each said only when it is known.
  const facts: Array<{ key: string; text: string }> = [];
  if (s) {
    const p = s.position;
    if (p.safeToSpendNow != null) {
      const until = p.horizonKind === "payday" && p.paydayDate ? ` until payday ${weekdayLabel(p.paydayDate)}` : " this week";
      facts.push({ key: "room", text: `${money(p.safeToSpendNow)} room to spend${until}` });
    }
    if (obligations[0]) {
      facts.push({ key: "next", text: `Next: ${obligationLine(obligations[0])}` });
    }
    if (s.reviewCount > 0) {
      facts.push({ key: "review", text: s.reviewCount === 1 ? "1 charge to match" : `${s.reviewCount} charges to match` });
    }
  }

  return (
    <header className={cn("span-12", rise(0))} data-testid="dash-header">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-display font-semibold text-brand-navy" data-testid="dash-today">
            Today <span className="font-normal text-neutral-500">· {weekdayLabel(today)}</span>
          </h1>
          {s ? (
            <p className="mt-1 text-body text-brand-ink" data-testid="dash-facts">
              {facts.length
                ? facts.map((f, i) => (
                    <span key={f.key}>
                      {i > 0 ? <span aria-hidden className="text-neutral-400"> · </span> : null}
                      <span data-testid={`dash-fact-${f.key}`}>{f.text}</span>
                    </span>
                  ))
                : noBank
                  ? "No bank is linked yet. Link checking and your cards, and this page fills in from them."
                  : "Nothing scheduled and nothing waiting."}
            </p>
          ) : spine.state === "failed" ? null : (
            <div className="skeleton mt-2 h-4 w-72 max-w-full rounded" aria-busy="true" />
          )}
          {banks.length ? (
            <ul className="mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-micro text-neutral-600" data-testid="dash-bank-fresh">
              {banks.map((b) => (
                <li key={b.itemId} data-state={b.state}>
                  <span
                    aria-hidden
                    className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", b.state === "ok" ? "bg-acct-checking" : b.state === "stale" || b.state === "never" ? "bg-neutral-400" : "bg-bad")}
                  />
                  <span className="font-semibold text-neutral-700">{b.institution}</span>{" "}
                  <span className={cn(b.state === "reauth" || b.state === "failed" ? "font-semibold text-bad" : undefined)}>· {b.words}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="dash-header-action" data-kind={action.kind}>
          {action.kind === "link" ? (
            <Link href={action.href} className={btn} data-testid="dash-link-bank">{action.label}</Link>
          ) : action.kind === "short" ? (
            <>
              <Link href={action.href} className={btn} data-testid="dash-runs-short">{action.label}</Link>
              <AffordLauncher className={QUIET} />
            </>
          ) : action.kind === "reconnect" ? (
            <>
              <Link href={action.href} className={btn} data-testid="dash-reconnect">{action.label}</Link>
              <AffordLauncher className={QUIET} />
            </>
          ) : action.kind === "wayBack" ? (
            <>
              <WaysBackLauncher />
              <AffordLauncher className={QUIET} />
            </>
          ) : (
            <AffordLauncher className={btnSecondary} />
          )}
        </div>
      </div>
      <div className="mt-2">
        <button
          type="button"
          className="text-label font-semibold text-brand-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 rounded-control"
          aria-expanded={recapOpen}
          aria-controls="dash-recap"
          onClick={() => setRecapOpen((o) => !o)}
          data-testid="dash-recap-toggle"
        >
          {recapOpen ? "Hide the morning text" : "Preview tomorrow's morning text"}
        </button>
        {recapOpen ? (
          <div id="dash-recap" className="mt-2">
            <Suspense fallback={<div className="skeleton h-12 w-full max-w-2xl rounded-control" aria-busy="true" />}>
              <RecapPreview />
            </Suspense>
          </div>
        ) : null}
      </div>
    </header>
  );
}
