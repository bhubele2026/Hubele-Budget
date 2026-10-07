import { getGetSettingsQueryKey, useGetSettings } from "@workspace/api-client-react";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import { useSpine } from "@/data/useSpine";
import { buttonClass } from "@/kit/Button";
import { Figure } from "@/kit/Figure";
import { FreshnessBadge } from "@/kit/FreshnessBadge";
import { Meter, meterStatus } from "@/kit/Meter";
import { Note, RefreshNote } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonFigure, SkeletonLine, SkeletonMeter } from "@/kit/Skeleton";
import { longDate, shortDate, shortDateOfInstant } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { dataState } from "@/lib/queryState";

/**
 * ⭐ TODAY, v0 — the morning paper, on the figures the spine already carries.
 *
 * Top to bottom: the date and how fresh the bank is; the bank balance (the one
 * figure-xl); this week against its limit; what is coming up; debt as % paid;
 * what needs a decision; the way to the classic app.
 *
 * ⚠️ EVERY NUMBER HERE IS READ, NONE IS WORKED OUT. They come from `useSpine()`
 * and the generated `useGetSettings()` exactly as the server sent them. The
 * one subtraction on screen is the meter's "Over by $x", the gap between the
 * two figures it is already showing.
 *
 * ⚠️ DEBT IS A PERCENTAGE, NEVER AN AMOUNT OWED. The spine refuses to carry a
 * balance at all (`spineParity.integration.test.ts`), and today.test.tsx
 * checks no owed figure reaches the screen.
 *
 * States: cold → skeleton shapes, once; refreshing → the badge says
 * "Updating"; a stale bank → badge words and a Note offering Sync; an error →
 * a Note with Retry while the last figures stay.
 */

/** "Free until payday" arrives in S1; v0's hero is the bank balance. */
const SOURCE_WORDS = { plaid: "bank sync", manual: "entered by hand" } as const;

function pct(n: number): string {
  // Rounded as the classic landing rounds it, so the two apps agree.
  return `${Math.round(n)}%`;
}

export function TodaySkeleton({ now }: { now?: Date }) {
  return (
    <div className="flex flex-col" data-testid="today-skeleton" aria-busy="true">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="type-headline text-ink">{longDate(householdToday(now))}</h1>
        <SkeletonLine className="w-32" />
      </header>
      <div className="flex flex-col gap-2 pb-8">
        <SkeletonLine className="w-24" />
        <SkeletonFigure size="xl" />
        <SkeletonLine className="w-36" />
      </div>
      <Section label="This week">
        <SkeletonMeter />
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
  const spine = useSpine();
  const settings = useGetSettings({
    query: {
      queryKey: getGetSettingsQueryKey(),
      staleTime: 30 * 60_000,
      gcTime: 60 * 60_000,
    },
  });

  if (spine.state === "cold") return <TodaySkeleton now={now} />;

  const s = spine.data;
  const bank = s?.bank;
  const balance = toAmount(bank?.balance);
  const settingsState = dataState(settings);
  const limit = toAmount(settings.data?.weeklyAllowanceAmount);
  const nextBill = s?.nextBill ?? null;
  const showStale = Boolean(bank?.stale) && spine.state !== "refreshing";

  const bankSub =
    bank?.asOfDate && bank.source
      ? `as of ${shortDateOfInstant(bank.asOfDate)} · ${SOURCE_WORDS[bank.source]}`
      : undefined;

  return (
    <div className="flex flex-col" data-testid="today">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="type-headline text-ink" data-testid="dateline">
          {longDate(householdToday(now))}
        </h1>
        <FreshnessBadge bank={bank} state={spine.state} now={now} />
      </header>

      {(spine.state === "failed" || spine.state === "refresh-failed" || showStale) && (
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
                <a href="/classic/settings" className={buttonClass({ variant: "link", size: "sm" })}>
                  Sync
                </a>
              }
            >
              The bank balance may be out of date.
            </Note>
          )}
        </div>
      )}

      <div className="pb-8">
        <Figure
          size="xl"
          label="Bank balance"
          amount={balance}
          state={spine.state}
          sub={bankSub}
          data-testid="figure-bank"
        />
      </div>

      <Section label="This week" data-testid="section-week">
        {s == null ? (
          <Figure size="md" label="Spent so far" amount={null} state={spine.state} />
        ) : settingsState === "cold" ? (
          <SkeletonMeter />
        ) : settingsState === "failed" ? (
          <Figure
            size="md"
            label="Spent so far"
            amount={s.spentWeek}
            state={spine.state}
            sub="The weekly limit did not load."
          />
        ) : (
          <Meter
            label="Spent so far"
            spent={s.spentWeek}
            limit={limit}
            status={meterStatus(s.spentWeek, limit ?? 0)}
            data-testid="meter-week"
          />
        )}
      </Section>

      <Section
        label="Coming up"
        data-testid="section-coming-up"
        foot={
          s ? (
            <span data-testid="bills-due">
              <data value={String(s.billsDueCount)} className="tnum">
                {s.billsDueCount}
              </data>{" "}
              {s.billsDueCount === 1 ? "bill" : "bills"} due this month
            </span>
          ) : undefined
        }
      >
        {s == null ? (
          <p className="type-body text-ink-3">—</p>
        ) : nextBill ? (
          <NextBill name={nextBill.name} amount={nextBill.amount} dueDate={nextBill.dueDate} />
        ) : (
          <p className="type-body text-ink-2">Nothing scheduled.</p>
        )}
      </Section>

      <Section label="Debt" data-testid="section-debt">
        <Figure
          size="md"
          label="Toward debt-free"
          amount={s?.debt?.payoffPct ?? null}
          state={spine.state}
          format={pct}
          suffix="paid"
          sub={s && s.debt?.payoffPct == null ? "No debt has a starting balance yet." : undefined}
          data-testid="figure-debt"
        />
      </Section>

      <Section
        label="Needs you"
        data-testid="section-needs-you"
        action={
          s && s.reviewCount > 0 ? (
            <a href="/classic/review" className={buttonClass({ variant: "link", size: "sm" })}>
              Open review
            </a>
          ) : undefined
        }
      >
        {s == null ? (
          <p className="type-body text-ink-3">—</p>
        ) : s.reviewCount > 0 ? (
          <p className="flex items-baseline gap-2" data-testid="review-count">
            <data value={String(s.reviewCount)} className="type-figure-sm text-ink">
              {s.reviewCount}
            </data>{" "}
            <span className="type-body text-ink-2">
              {s.reviewCount === 1 ? "bank row" : "bank rows"} to match
            </span>
          </p>
        ) : (
          <p className="type-body text-ink-2">Nothing is waiting on you.</p>
        )}
      </Section>

      <div className="flex flex-col gap-1 border-t border-rule pt-4 pb-4" data-testid="classic-row">
        <a href="/classic/" className="self-start type-label text-moss underline decoration-1 underline-offset-4 hover:text-moss-ink">
          Classic app
        </a>
        <p className="type-caption text-ink-2">
          Bills, debts, settings and bank links still live in the classic app for now.
        </p>
      </div>
    </div>
  );
}

function NextBill({ name, amount, dueDate }: { name: string; amount: string; dueDate: string }) {
  const n = toAmount(amount);
  return (
    <div className="flex items-baseline justify-between gap-4" data-testid="next-bill">
      <p className="flex min-w-0 items-baseline gap-2">
        {n == null ? (
          <span className="type-figure-sm text-ink-3">—</span>
        ) : (
          <data value={centsValue(n)} className="type-figure-sm text-ink">
            {fmtMoney(n)}
          </data>
        )}{" "}
        <span className="truncate type-body text-ink">{name}</span>
      </p>
      <span className="shrink-0 type-label text-ink-2">due {shortDate(dueDate)}</span>
    </div>
  );
}
