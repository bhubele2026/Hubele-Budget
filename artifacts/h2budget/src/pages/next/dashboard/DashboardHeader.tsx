import { useMemo } from "react";
import { Link } from "wouter";
import { WaysBackLauncher } from "@/components/ways-back/WaysBackLauncher";
import { attentionItems, headerActionOf } from "@/lib/attention";
import { addDaysISO, householdToday } from "@/lib/householdDay";
import { useSpine } from "@/hooks/useSpine";
import { knownWithinPlan, weekStory } from "@/lib/weekFigures";
import { btn } from "@/ui";
import { cn } from "@/lib/utils";
import { requestWhatsNewOpen, useWhatsNewUnread } from "@/lib/whatsNewSignal";
import { useCashSignalQ, usePlaidItemsQ } from "./queries";
import { dueSoonOf, upcomingRows } from "./obligations";
import { bankLines, hasLinkedBank } from "./bankState";
import { rise, weekdayLabel } from "./shared";

/** The second row's text button (What's new). */
const QUIET_TEXT =
  "rounded-control text-label font-semibold text-brand-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";

/**
 * ⭐ THE HEADER: what day it is, the way back to What's new, and ONE action
 * (only when something needs doing). Eager (first screen), no panel chrome: it
 * is the page's own head, not a card. (Home is four numbers, 2026-11-11) The
 * bank sync lines, "Can we afford something?" and the morning text moved,
 * unchanged, into the "More" drawer (`MoreDrawer.tsx`).
 */
export default function DashboardHeader() {
  const spine = useSpine();
  const items = usePlaidItemsQ();
  // The same hook-aware cash-signal events Coming up lists (shared by key).
  const cash = useCashSignalQ(90);
  // (WN) Unread notes from the lazy What's new host; null until it has asked.
  const whatsNewUnread = useWhatsNewUnread();
  const today = householdToday(new Date());
  const s = spine.data;
  const obligations = useMemo(() => upcomingRows({ signal: cash.data, today, count: 50 }), [cash.data, today]);

  const attention = useMemo(() => {
    if (!s) return null;
    const week = weekStory(s.position);
    return attentionItems({
      bank: s.bank,
      withinPlan: knownWithinPlan(s.position),
      overBy: week.over && week.remainingKnown != null ? -week.remainingKnown : null,
      provisional: week.provisional,
      dueSoon: dueSoonOf(obligations, today, addDaysISO(today, 1)),
      today,
      reviewCount: s.reviewCount,
      reauthBanks: bankLines(items.data, Date.now()).filter((b) => b.state === "reauth").map((b) => b.institution),
      // (WP6) "Runs short" is an attention item, the one Needs attention lists.
      forecast: s.forecast,
    });
  }, [s, obligations, today, items.data]);
  const noBank = items.data !== undefined && !hasLinkedBank(items.data);
  const action = headerActionOf(attention ?? [], { noBank });

  return (
    <header className={cn("span-12", rise(0))} data-testid="dash-header">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-display font-semibold text-brand-navy" data-testid="dash-today">
            Today <span className="font-normal text-neutral-500">· {weekdayLabel(today)}</span>
          </h1>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="dash-header-action" data-kind={action.kind}>
          {/* ONE action: the most actionable issue. With none, nothing shouts. */}
          {action.kind === "link" ? (
            <Link href={action.href} className={btn} data-testid="dash-link-bank">{action.label}</Link>
          ) : action.kind === "short" ? (
            <Link href={action.href} className={btn} data-testid="dash-runs-short">{action.label}</Link>
          ) : action.kind === "reconnect" ? (
            <Link href={action.href} className={btn} data-testid="dash-reconnect">{action.label}</Link>
          ) : action.kind === "wayBack" ? (
            <WaysBackLauncher />
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {/* (WN) The way back to What's new — a quiet link, not a tile; "New" while a note is unread. */}
        <button type="button" className={QUIET_TEXT} onClick={requestWhatsNewOpen} data-testid="dash-whats-new">
          What's new
          {whatsNewUnread ? (
            <span className="ml-1.5 rounded-full bg-brand-orange px-1.5 py-px align-middle text-micro font-semibold text-on-orange" data-testid="dash-whats-new-new">
              New
            </span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
