import { lazy, Suspense } from "react";
import { Link } from "wouter";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import { useTodayData, type TodayData } from "@/data/todayData";
import { buttonClass } from "@/kit/Button";
import { FreshnessBadge } from "@/kit/FreshnessBadge";
import { Note, RefreshNote } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonFigure, SkeletonLine, SkeletonMeter } from "@/kit/Skeleton";
import { longDate } from "@/lib/dates";
import { toAmount } from "@/lib/money";
import { attentionItems, billsDueSoon, upcomingBills } from "./attention";
import { Hero } from "./Hero";
import { OneThing } from "./sections";
import { WeekSection } from "./WeekSection";

// The What's-new sheet carries Radix Dialog and the preferences client. It is
// fetched only for a household that has history, and never on the open path.
const WhatsNew = lazy(() => import("./WhatsNew"));

// (S5) The two lowest sections load after first paint, in one chunk, to keep the
// open path inside its cap. Each waits behind a skeleton of its own size.
const lower = () => import("./lowerSections");
// Start the download now, in parallel with the spine request, so the sections are there
// by the time the first figures land. A failure is retried by the lazy() itself.
if (typeof window !== "undefined") lower().catch(() => {});
const ActivitySection = lazy(() => lower().then((m) => ({ default: m.ActivitySection })));
const HandledSection = lazy(() => lower().then((m) => ({ default: m.HandledSection })));
const ComingUp = lazy(() => lower().then((m) => ({ default: m.ComingUp })));
const DebtSection = lazy(() => lower().then((m) => ({ default: m.DebtSection })));

function SectionSkeleton({ label, figure = false }: { label: string; figure?: boolean }) {
  return (
    <Section label={label} data-testid="section-skeleton">
      {figure ? <SkeletonFigure size="md" /> : <SkeletonLine className="w-56" />}
    </Section>
  );
}

/**
 * ⭐ TODAY — the morning paper. Top to bottom: the date and how fresh the bank
 * is; FREE UNTIL PAYDAY (the one figure-xl); this week against its limit; the
 * one thing that wants a look; yesterday and today; what is coming up; debt as
 * % paid; the way to the classic app.
 *
 * ⚠️ EVERY NUMBER HERE IS READ, NONE IS WORKED OUT. They come from `useSpine()`
 * and the generated hooks in `data/todayData.ts`, as the server sent them. The
 * one subtraction on screen is "Over by $x": the server's `remainingWeek` with
 * its sign dropped.
 *
 * ⚠️ DEBT IS A PERCENTAGE PAID, NEVER AN AMOUNT OWED. today.test.tsx greps the
 * rendered page for the words and for any amount that was not handed in.
 *
 * States: cold → skeleton shapes, once; refreshing → the badge says
 * "Updating"; a stale bank → badge words and a Note offering Sync; an error →
 * a Note with Retry while the last figures stay; a degraded position → the
 * hero says which bank date it is from.
 *
 * "Handled" shows the last four things H2 did on its own (hidden when there is
 * nothing); Why and Undo live in Activity.
 */
export function TodaySkeleton({ now }: { now?: Date }) {
  return (
    <div
      className="flex flex-col"
      data-testid="today-skeleton"
      aria-busy="true"
    >
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="type-headline text-ink">
          {longDate(householdToday(now))}
        </h1>
        <SkeletonLine className="w-32" />
      </header>
      <div className="flex flex-col gap-2 pb-8">
        <SkeletonLine className="w-24" />
        <SkeletonFigure size="xl" />
        <SkeletonLine className="w-48" />
      </div>
      <Section label="This week">
        <SkeletonMeter />
      </Section>
      <Section label="One thing">
        <SkeletonLine className="w-56" />
      </Section>
      <Section label="Yesterday and today">
        <SkeletonLine className="w-64" />
      </Section>
      <Section label="Coming up">
        <SkeletonLine className="w-56" />
      </Section>
      <Section label="Debt">
        <SkeletonFigure size="md" />
      </Section>
    </div>
  );
}

export default function Today({ now }: { now?: Date }) {
  const today = householdToday(now);
  const data = useTodayData(today);
  return <TodayView data={data} now={now} live />;
}

/**
 * The page on data it is handed. `Today` hands it the live hooks; the public
 * `/design/today` page hands it made-up data (`live` false: no preferences
 * are read, so no sheet can open over a sample).
 */
export function TodayView({
  data,
  now,
  live,
}: {
  data: TodayData;
  now?: Date;
  live: boolean;
}) {
  const { spine, position, plans, settings, bills, ledger, categories, trail, unfiled } = data;
  const today = householdToday(now);

  if (spine.state === "cold") return <TodaySkeleton now={now} />;

  const s = spine.data;
  const bank = s?.bank;
  const showStale = Boolean(bank?.stale) && spine.state !== "refreshing";

  const remaining = toAmount(
    s?.position.remainingWeek ?? position.data?.remainingWeek,
  );
  const items =
    s == null
      ? []
      : attentionItems({
          bank,
          withinPlan: s?.position.withinPlan,
          overBy: remaining != null && remaining < 0 ? -remaining : null,
          dueSoon: billsDueSoon(bills.data, today),
          today,
          reviewCount: s?.reviewCount ?? 0,
        });
  const upcoming = upcomingBills(bills.data, today);

  // "Existing household": the bank has reported, or money has moved this
  // month, or the ledger window has rows. New households get the ladder later.
  const existing =
    Boolean(bank?.asOfDate) ||
    (s?.spentMonth ?? 0) > 0 ||
    (ledger.data?.matchingCount ?? 0) > 0;

  return (
    <div className="flex flex-col" data-testid="today">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="type-headline text-ink" data-testid="dateline">
          {longDate(today)}
        </h1>
        <FreshnessBadge bank={bank} state={spine.state} now={now} />
      </header>

      {(spine.state === "failed" ||
        spine.state === "refresh-failed" ||
        showStale) && (
        <div className="mb-6 flex flex-col gap-3">
          <RefreshNote
            state={spine.state}
            updatedAt={spine.updatedAt}
            onRetry={spine.refetch}
            retrying={spine.isFetching}
            now={now}
          />
          {showStale && (
            <Note
              kind="stale"
              data-testid="stale-note"
              action={
                <Link href="/household" className={buttonClass({ variant: "link", size: "sm" })}>
                  Sync
                </Link>
              }
            >
              The bank balance may be out of date.
            </Note>
          )}
        </div>
      )}

      <Hero spine={s} state={spine.state} position={position} />

      <WeekSection
        spine={s}
        position={position}
        plans={plans}
        settings={settings}
        unfiled={unfiled}
      />

      <OneThing items={items} loading={s == null && spine.state !== "failed"} />

      <Suspense fallback={<SectionSkeleton label="Yesterday and today" />}>
        <ActivitySection ledger={ledger} categories={categories} today={today} />
      </Suspense>

      {(trail.data?.actions.length ?? 0) > 0 && (
        <Suspense fallback={<SectionSkeleton label="Handled" />}>
          <HandledSection trail={trail} now={now} />
        </Suspense>
      )}

      <Suspense fallback={<SectionSkeleton label="Coming up" />}>
        <ComingUp spine={s} upcoming={upcoming} bills={bills} today={today} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton label="Debt" figure />}>
        <DebtSection spine={s} state={spine.state} />
      </Suspense>

      <div
        className="flex flex-col gap-1 border-t border-rule pt-4 pb-4"
        data-testid="classic-row"
      >
        <a
          href="/classic/"
          className="self-start type-label text-moss underline decoration-1 underline-offset-4 hover:text-moss-ink"
        >
          Classic app
        </a>
        <p className="type-caption text-ink-2">
          Workbook import still lives in the classic app.
        </p>
      </div>

      {live && existing && s != null && (
        <Suspense fallback={null}>
          <WhatsNew bank={toAmount(s.bank.balance)} spentWeek={s.spentWeek} />
        </Suspense>
      )}
    </div>
  );
}
