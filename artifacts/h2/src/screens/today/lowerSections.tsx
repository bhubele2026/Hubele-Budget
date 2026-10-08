import { Link } from "wouter";
import type { AgentActionList, Category, Spine } from "@workspace/api-client-react";
import type { LedgerPage, LedgerRow as LedgerRowData } from "@workspace/api-client-react/ledger";
import { buttonClass } from "@/kit/Button";
import { Figure } from "@/kit/Figure";
import { LedgerRow } from "@/kit/LedgerRow";
import { Note, RefreshNote } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { TrailItem } from "@/kit/TrailItem";
import { SkeletonLine } from "@/kit/Skeleton";
import { dayWord, relativeTime } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import type { DataState } from "@/lib/queryState";
import type { Read } from "@/data/todayData";
import { groupTrail } from "@/screens/activity/trailWords";
import type { DueBill } from "./attention";

/**
 * (S5) The four lowest sections of Today (yesterday and today, handled, coming up, debt). They live in their own chunk so the
 * open path stays under its cap: Today fetches this file after first paint,
 * behind a skeleton the size of the section.
 */
const link = buttonClass({ variant: "link", size: "sm" });

/** (V4) The failed-refresh and stale-bank notes: only drawn when something is wrong, so off the open path. */
export function TopNotes({
  state,
  updatedAt,
  refetch,
  fetching,
  showStale,
  now,
}: {
  state: React.ComponentProps<typeof RefreshNote>["state"];
  updatedAt: React.ComponentProps<typeof RefreshNote>["updatedAt"];
  refetch: () => void;
  fetching: boolean;
  showStale: boolean;
  now?: Date;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3">
      <RefreshNote state={state} updatedAt={updatedAt} onRetry={refetch} retrying={fetching} now={now} />
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
  );
}

/** The last four things H2 did on its own. Nothing to show, nothing drawn. */
export function HandledSection({ trail, now }: { trail: Read<AgentActionList>; now?: Date }) {
  const groups = groupTrail(trail.data?.actions ?? []).slice(0, 4);
  if (groups.length === 0) return null;
  return (
    <Section
      label="Handled"
      data-testid="section-handled"
      action={
        <Link href="/activity" className={link}>
          See details →
        </Link>
      }
    >
      <ul data-testid="handled-rows">
        {groups.map((g) => (
          <TrailItem key={g.key} title={g.title} when={relativeTime(g.at, now)} undone={g.undone} data-testid="handled-row" />
        ))}
      </ul>
    </Section>
  );
}

function pct(n: number): string {
  // Rounded as the classic landing rounds it, so the two apps agree.
  return `${Math.round(n)}%`;
}

/** The debt fields PR-D may add. Read only if the server sends them. */
interface DebtExtras {
  paidDownMtd?: string | number | null;
  confirmedPaymentsMtd?: string | number | null;
  newChargesMtd?: string | number | null;
  nextMilestone?: { label: string; estimatedMonth: string } | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthWords(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}` : ym;
}

const DEBT_ROW = "border-t border-rule py-2 first:border-t-0";
const positive = (n: number | null): n is number => n != null && n > 0;
function Amount({ n }: { n: number }) {
  return (
    <data value={centsValue(n)} className="tnum">
      {fmtMoney(n)}
    </data>
  );
}

/**
 * ⚠️ DEBT IS A PERCENTAGE PAID AND (WHEN THE SERVER SENDS THEM) WHAT WAS PAID
 * DOWN, PAID AND NEWLY CHARGED THIS MONTH, AND THE NEXT MILESTONE. NEVER AN AMOUNT OWED.
 */
export function DebtSection({ spine, state }: { spine: Spine | undefined; state: DataState }) {
  const extras = (spine?.debt ?? {}) as DebtExtras;
  const down = toAmount(extras.paidDownMtd);
  const charges = toAmount(extras.newChargesMtd);
  const payments = toAmount(extras.confirmedPaymentsMtd);
  const milestone = extras.nextMilestone ?? null;
  return (
    <Section label="Debt" data-testid="section-debt">
      <Figure
        size="md"
        label="Toward debt-free"
        amount={spine?.debt?.payoffPct ?? null}
        state={state}
        format={pct}
        suffix="paid"
        sub={spine && spine.debt?.payoffPct == null ? "No debt has a starting balance yet." : undefined}
        data-testid="figure-debt"
      />
      {(positive(down) || positive(charges) || positive(payments) || milestone) && (
        <div className="mt-3 flex flex-col type-body text-ink-2">
          {positive(down) && (
            <p className={DEBT_ROW} data-testid="debt-paid-down">
              Paid down <Amount n={down} /> this month, confirmed by the bank
            </p>
          )}
          {positive(charges) && (
            <p className={`${DEBT_ROW} text-clay`} data-testid="debt-new-charges">
              New charges <Amount n={charges} /> this month
            </p>
          )}
          {positive(payments) && payments > (down ?? 0) && (
            <p className={`${DEBT_ROW} type-caption`} data-testid="debt-payments">
              Payments <Amount n={payments} />, of which <Amount n={down ?? 0} /> reduced debt
            </p>
          )}
          {milestone && (
            <p className={DEBT_ROW} data-testid="debt-milestone">
              Next: {milestone.label} · {monthWords(milestone.estimatedMonth)}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/** Up to eight rows from the ledger window, newest first. */
export function rowsOf(page: LedgerPage | undefined): LedgerRowData[] {
  if (!page) return [];
  return page.rows
    .filter((r) => r.countsInBalance !== false)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.occurredOn < b.r.occurredOn ? 1 : a.r.occurredOn > b.r.occurredOn ? -1 : a.i - b.i))
    .map((x) => x.r);
}

export function ActivitySection({
  ledger,
  categories,
  today,
}: {
  ledger: Read<LedgerPage>;
  categories: Read<Category[]>;
  today: string;
}) {
  const names = new Map((categories.data ?? []).map((c) => [c.id, c.name] as const));
  const rows = rowsOf(ledger.data);
  let body;
  if (ledger.state === "cold") body = <SkeletonLine className="w-64" />;
  else if (ledger.state === "failed")
    body = (
      <Note kind="error" onRetry={ledger.refetch} retrying={ledger.isFetching}>
        Couldn't load yesterday and today.
      </Note>
    );
  else if (rows.length === 0) body = <Note kind="empty">No charges yet today.</Note>;
  else
    body = (
      <ul data-testid="activity-rows">
        {rows.map((r) => (
          <LedgerRow
            key={r.id}
            name={r.displayName || r.description}
            amount={toAmount(r.amount)}
            when={dayWord(r.occurredOn, today)}
            category={r.categoryId ? (names.get(r.categoryId) ?? null) : null}
            pending={r.pending}
          />
        ))}
      </ul>
    );
  return (
    <Section
      label="Yesterday and today"
      data-testid="section-activity"
      action={
        <Link href="/activity" className={link}>
          All activity →
        </Link>
      }
    >
      {body}
    </Section>
  );
}

export function ComingUp({
  spine,
  upcoming,
  bills,
  today,
}: {
  spine: Spine | undefined;
  upcoming: DueBill[];
  bills: Read<unknown>;
  today: string;
}) {
  const next = upcoming.slice(0, 3);
  let body;
  if (!spine || bills.state === "cold") body = <SkeletonLine className="w-56" />;
  else if (bills.state === "failed")
    body = (
      <Note kind="error" onRetry={bills.refetch} retrying={bills.isFetching}>
        Couldn't load your bills.
      </Note>
    );
  else if (next.length === 0)
    body = (
      <Note
        kind="empty"
        action={
          <Link href="/plan/bills" className={link}>
            Open bills
          </Link>
        }
      >
        Nothing scheduled.
      </Note>
    );
  else
    body = (
      <ul data-testid="coming-up-rows">
        {next.map((b) => (
          <li
            key={`${b.name}-${b.dueOn}`}
            className="flex items-baseline justify-between gap-4 border-t border-rule py-2 first:border-t-0"
            data-testid="coming-up-row"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              {b.amount == null ? (
                <span className="type-figure-sm text-ink-3">—</span>
              ) : (
                <data value={centsValue(b.amount)} className="type-figure-sm text-ink">
                  {fmtMoney(b.amount)}
                </data>
              )}
              <span className="truncate type-body text-ink">{b.name}</span>
            </span>
            <span className="shrink-0 type-label text-ink-2">{dayWord(b.dueOn, today)}</span>
          </li>
        ))}
      </ul>
    );
  return (
    <Section
      label="Coming up"
      data-testid="section-coming-up"
      foot={
        spine ? (
          <span data-testid="bills-due">
            <data value={String(spine.billsDueCount)} className="tnum">
              {spine.billsDueCount}
            </data>{" "}
            {spine.billsDueCount === 1 ? "bill" : "bills"} due this month
          </span>
        ) : undefined
      }
    >
      {body}
    </Section>
  );
}
