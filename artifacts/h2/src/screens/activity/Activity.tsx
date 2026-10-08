import { householdToday } from "@workspace/avalanche-core/householdTime";
import { longDate } from "@/lib/dates";
import { useReviewQueue } from "@/data/activityData";
import { useSpine } from "@/data/useSpine";
import { FreshnessBadge } from "@/kit/FreshnessBadge";
import { SectionIndex } from "@/kit/SectionIndex";
import { Segmented } from "@/kit/Segmented";
import { ToastProvider } from "@/kit/Toast";
import { LedgerPage } from "./LedgerView";
import { ReviewView } from "./ReviewView";
import { RulesView } from "./RulesView";

export type ActivityViewKey = "ledger" | "review" | "rules";

/**
 * ⭐ ACTIVITY — the ledger, the review queue and the rules H2 learned. One lazy
 * chunk serves the three routes. A SectionIndex on a desktop and a Segmented
 * row on a phone move between them; the Review entry carries the queue's
 * count. The shell's Dock and Masthead carry the same badge.
 *
 * `base` is where the three views live ("/activity" in the app,
 * "/design/activity" on the sample page).
 */
export default function Activity({
  view,
  base = "/activity",
  now,
}: {
  view: ActivityViewKey;
  base?: string;
  now?: Date;
}) {
  const spine = useSpine();
  const queue = useReviewQueue();
  const today = householdToday(now);
  const options = [
    { key: "ledger" as const, label: "Ledger", href: base },
    { key: "review" as const, label: "Review", href: `${base}/review`, badge: queue.data?.total ?? 0 },
    { key: "rules" as const, label: "Rules", href: `${base}/rules` },
  ];
  return (
    <ToastProvider>
      <div className="flex flex-col" data-testid="activity" data-view={view}>
        <header className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
          <h1 className="type-headline text-ink">Activity</h1>
          <span className="flex items-baseline gap-4">
            <span className="type-caption text-ink-3 hidden sm:inline">{longDate(today)}</span>
            <FreshnessBadge bank={spine.data?.bank} state={spine.state} now={now} />
          </span>
        </header>
        <div className="mb-6">
          <div className="hidden md:block">
            <SectionIndex label="Activity sections" options={options} value={view} data-testid="activity-index" />
          </div>
          <div className="md:hidden">
            <Segmented label="Activity sections" options={options} value={view} data-testid="activity-segmented" />
          </div>
        </div>
        {view === "ledger" && <LedgerPage now={now} />}
        {view === "review" && <ReviewView now={now} />}
        {view === "rules" && <RulesView />}
      </div>
    </ToastProvider>
  );
}
