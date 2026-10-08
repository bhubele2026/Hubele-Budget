import { lazy, Suspense } from "react";
import type { WaysBack } from "@workspace/api-client-react";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import { useTodayData, type TodayData } from "@/data/todayData";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonFigure, SkeletonLine, SkeletonMeter } from "@/kit/Skeleton";
import { longDate } from "@/lib/dates";
import { toAmount } from "@/lib/money";
import { attentionItems, billsDueSoon, upcomingBills } from "./attention";
import { AffordLauncher } from "@/screens/afford/AffordLauncher";
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

// (V4) The freshness badge (and its minute tick) is not the first paint: it loads right behind
// the page, in the space its skeleton line holds, to keep the open path inside its cap.
const freshness = () => import("@/kit/FreshnessBadge");
if (typeof window !== "undefined") freshness().catch(() => {});
const FreshnessBadge = lazy(() => freshness().then((m) => ({ default: m.FreshnessBadge })));

type Lower = typeof import("./lowerSections");
const fromLower = <K extends "ActivitySection" | "HandledSection" | "ComingUp" | "TopNotes" | "DebtSection">(k: K) =>
  lazy(() => lower().then((m) => ({ default: m[k] as Lower[K] })));
const ActivitySection = fromLower("ActivitySection");
const HandledSection = fromLower("HandledSection");
const ComingUp = fromLower("ComingUp");
const TopNotes = fromLower("TopNotes");
const DebtSection = fromLower("DebtSection");

function SectionSkeleton({ label, figure = false }: { label: string; figure?: boolean }) {
  return (
    <Section label={label} data-testid="section-skeleton">
      {figure ? <SkeletonFigure size="md" /> : <SkeletonLine className="w-56" />}
    </Section>
  );
}

/**
 * ⭐ TODAY — the morning paper. Top to bottom: the date and how fresh the bank
 * is; ROOM IN THE PLAN (the one figure-xl); this week against its limit; the
 * one thing that wants a look; debt as % paid; yesterday and today; what is
 * coming up.
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
      <Section label="Debt">
        <SkeletonFigure size="md" />
      </Section>
      <Section label="Yesterday and today">
        <SkeletonLine className="w-64" />
      </Section>
      <Section label="Coming up">
        <SkeletonLine className="w-56" />
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
  sampleWaysBack,
}: {
  data: TodayData;
  now?: Date;
  live: boolean;
  /** The sample page's made-up ways back, so its sheet opens with no network. */
  sampleWaysBack?: WaysBack;
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
        <Suspense fallback={<SkeletonLine className="w-32" />}>
          <FreshnessBadge bank={bank} state={spine.state} now={now} />
        </Suspense>
      </header>

      {(spine.state === "failed" || spine.state === "refresh-failed" || showStale) && (
        <Suspense fallback={null}>
          <TopNotes state={spine.state} updatedAt={spine.updatedAt} refetch={spine.refetch} fetching={spine.isFetching} showStale={showStale} now={now} />
        </Suspense>
      )}

      <Hero spine={s} state={spine.state} position={position} />

      <WeekSection
        spine={s}
        position={position}
        plans={plans}
        settings={settings}
        unfiled={unfiled}
        today={today}
      />

      <OneThing items={items} loading={s == null && spine.state !== "failed"} sampleWaysBack={sampleWaysBack} />

      <Suspense fallback={<SectionSkeleton label="Debt" figure />}>
        <DebtSection spine={s} state={spine.state} />
      </Suspense>

      {live && <AffordLauncher variant="quiet" className="mb-8 w-full" />}

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

      {live && existing && s != null && (
        <Suspense fallback={null}>
          <WhatsNew bank={toAmount(s.bank.balance)} spentWeek={s.spentWeek} />
        </Suspense>
      )}
    </div>
  );
}
