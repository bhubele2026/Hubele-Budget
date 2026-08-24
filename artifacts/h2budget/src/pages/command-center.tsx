import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useGetSettings,
  useListTransactions,
  useListRecurringItems,
  useGetForecastCashSignal,
  getGetForecastCashSignalQueryKey,
  type Transaction,
} from "@workspace/api-client-react";
import { useSpine } from "@/hooks/useSpine";
import { SyncButton } from "@/components/sync-button";
import { BankSnapshotFreshness } from "@/components/bank-snapshot-freshness";
import { ChaseInsightStrip } from "@/components/chase-insight-strip";
import { CssBars, type CssBarRow } from "@/lib/cssBars";
import { card, cardHead, emptyNote, Foot, Help, Stat } from "@/ui";
import { currentMonthRange } from "@/lib/timeRange";
import { isoDaysAgo, todayISO, currentWeekBounds } from "@/lib/weeklyStreak";
import {
  isSplurge,
  makeRecurringMatcher,
  merchantKey,
  recurringMerchantsFrom,
} from "@/lib/discretionarySpend";
import { bucketSpendInWindow } from "@/lib/bucketSpend";
import { formatCurrency } from "@/lib/utils";

/**
 * ⭐ BANKING — one screen, four surfaces, no scroll-story.
 *
 * This page used to be 1,633 lines of celebration: a health score, a pace
 * gauge, a paper-scrap burst on a positive month, a "Wrapped" modal, check-in
 * streaks, podium medals and a spending "persona" with an emoji. All of that
 * is gone (C1). What is left is the four things somebody opens Banking for:
 * where the money stands, how the month is tracking, what the allowance
 * buckets have left, and what the biggest charges were.
 *
 * ⚠️ THE SPINE RULE. Every headline figure comes from `useSpine()` and is
 * never recomputed here — see `hooks/useSpine.ts`. The one number this page
 * still derives locally is the allowance-bucket spend, which the spine does
 * not carry (it is an explicit user-marked bucket, not a spending fact); that
 * math is `lib/bucketSpend` unchanged, shared byte-for-byte with /allowances.
 */

// ── formatting ──────────────────────────────────────────────────────────────

/** Money for a Stat face. `null` reads as an em dash, never as $0. */
function money(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? formatCurrency(n) : "—";
}

/** "Aug 21" from a date-only or timestamp ISO string.
 *  ⚠️ The `T00:00:00` suffix is load-bearing: a bare `new Date("2026-08-21")`
 *  parses as UTC midnight and renders as the 20th west of Greenwich. */
function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Compact money for the bar list, where the column is ~90px wide. */
function barMoney(n: number): string {
  return `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

// ── allowance rows ──────────────────────────────────────────────────────────

/** ◀ ▶ across periods. The pager is the only control on this page, so it is
 *  quiet: hairline ghost buttons, no fill, disabled past the fetched window. */
function Pager({
  label,
  period,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: {
  label: string;
  period: string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const step =
    "press grid h-6 w-6 place-items-center rounded-control text-neutral-500 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy disabled:pointer-events-none disabled:opacity-30";
  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        className={step}
        onClick={onPrev}
        disabled={!canPrev}
        aria-label={`Previous ${label.toLowerCase()}`}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-[5.5rem] text-center text-label text-neutral-600">
        {period}
      </span>
      <button
        type="button"
        className={step}
        onClick={onNext}
        disabled={!canNext}
        aria-label={`Next ${label.toLowerCase()}`}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

/**
 * ⭐ ONE MARKUP, TWO SHAPES. The five cells are a 5-column table row on `sm+`
 * and a 2×2 block on a phone — same DOM, laid out by grid, so there is no
 * second mobile render to drift out of sync and no duplicated testids. Source
 * order is name → period → spent → cap → status, which reads correctly BOTH
 * ways: across as a row, and as `name / period` over `spent / status` once the
 * cap cell drops out below `sm`.
 *
 * ⚠️ The status cell survives on the phone and the CAP is what goes. A cap the
 * reader cannot see costs them nothing — "$147.15 left" already implies it —
 * but a table that pushes "over/left" off the right edge hides the one thing
 * the card exists to say.
 */
const ROW_GRID =
  "grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[6.5rem_minmax(8rem,1fr)_7rem_7rem_8rem] sm:gap-y-0";

/** Column head styling, matching the kit's `th` without the table element. */
const headCell = "text-micro font-semibold uppercase tracking-wide text-neutral-400";

/**
 * True on phone widths. The bar list sizes its label and value columns in
 * PIXELS (they must line up down the list, so they cannot be percentages), and
 * the desktop widths leave a 390px screen with almost no track left — the bars
 * become stubs and stop encoding anything. One media query, two size sets.
 */
function useNarrow(): boolean {
  const query = "(max-width: 640px)";
  const read = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** One allowance bucket: spent, cap, and what is left — with the LABEL saying
 *  which, because on this palette colour alone never carries the meaning. */
function AllowanceRow({
  name,
  href,
  testid,
  period,
  spend,
  cap,
}: {
  name: string;
  href: string;
  testid: string;
  period: React.ReactNode;
  spend: number;
  cap: number;
}) {
  const over = cap > 0 && spend > cap;
  const num = "font-mono text-label tabular-nums text-neutral-700";
  return (
    <div role="row" className={`${ROW_GRID} border-b border-brand-line/70 last:border-b-0`}>
      <div role="cell">
        <Link
          href={href}
          data-testid={testid}
          className="press rounded px-1 py-0.5 text-body font-medium text-brand-navy hover:bg-neutral-100"
        >
          {name}
        </Link>
      </div>
      <div role="cell" className="justify-self-end whitespace-nowrap sm:justify-self-start">
        {period}
      </div>
      <div role="cell" className={`${num} justify-self-start sm:justify-self-end`}>
        {formatCurrency(spend)}
      </div>
      <div role="cell" className={`hidden ${num} sm:block sm:justify-self-end`}>
        {cap > 0 ? formatCurrency(cap) : "—"}
      </div>
      <div role="cell" className="justify-self-end">
        {cap > 0 ? (
          <span className={`chip ${over ? "bad" : "gray"}`}>
            {over
              ? `${formatCurrency(spend - cap)} over`
              : `${formatCurrency(cap - spend)} left`}
          </span>
        ) : (
          <span className="text-micro text-neutral-400">no cap set</span>
        )}
      </div>
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function CommandCenterPage() {
  // ⭐ Every headline number on this page. One request, one instant.
  const { data: spine } = useSpine();
  const narrow = useNarrow();

  const { data: settings } = useGetSettings();
  const nowRef = new Date();
  const { data: weeklyTxns } = useListTransactions({
    from: isoDaysAgo(nowRef, 90),
    to: todayISO(nowRef),
    // (#perf-3) Scoped to 90 days already; bound the cap (90 days won't reach
    // it for any realistic household).
    limit: 1000,
  });
  // Recurring item names feed the biggest-charges list so bills &
  // subscriptions are excluded — it should surface one-off splurges,
  // not the mortgage.
  const { data: recurringItemsData } = useListRecurringItems();
  const recurringNames = useMemo(
    () => (recurringItemsData ?? []).map((r) => r.name),
    [recurringItemsData],
  );

  /**
   * ⚠️ NOT A NUMBER SOURCE. The balance on screen comes from the spine; this
   * existing (cached, 5-minute) query is read ONLY for the snapshot's source
   * and timestamp, which the freshness label needs and the spine does not
   * carry. Nothing here is rendered as money.
   */
  const { data: cashSignal } = useGetForecastCashSignal(
    { horizonDays: 90 },
    {
      query: {
        queryKey: getGetForecastCashSignalQueryKey({ horizonDays: 90 }),
        staleTime: 5 * 60_000,
      },
    },
  );

  const now = new Date();
  const monthRange = useMemo(() => currentMonthRange(now), [now.getMonth()]); // eslint-disable-line react-hooks/exhaustive-deps

  // Period pickers for the two allowance buckets that have one. 0 = current
  // period; negative = back in time. Forward is capped at 0.
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);

  // Explicit-bucket spend (weekly / monthly / unplanned). A txn counts ONLY if
  // the user marked it that bucket; blank counts nowhere. Shared with
  // /allowances via lib/bucketSpend so both surfaces show the identical number.
  const bucketSum = useMemo(() => {
    return (bucket: "weekly" | "monthly" | "unplanned", startISO: string, endISO: string): number =>
      bucketSpendInWindow(weeklyTxns ?? [], bucket, startISO, endISO);
  }, [weeklyTxns]);

  // Earliest ISO date we actually have transactions for (query fetched 90 days).
  // Used to disable the ◀ button once a period would fall outside the window.
  const earliestFetchedISO = isoDaysAgo(now, 90);

  // ── A) Selected WEEK (Sun–Sat) allowance spend ─────────────────────────────
  const weekView = useMemo(() => {
    const base = currentWeekBounds(now);
    const baseSun = new Date(`${base.startISO}T00:00:00`);
    const sun = new Date(baseSun);
    sun.setDate(sun.getDate() + weekOffset * 7);
    const sat = new Date(sun);
    sat.setDate(sat.getDate() + 6);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startISO = iso(sun);
    const endISO = iso(sat);
    const spend = bucketSum("weekly", startISO, endISO);
    // Weekly cap: per-week override, else the standing weekly allowance.
    const override = settings?.preferences?.weeklyAllowanceOverrides?.[startISO];
    const cap =
      override != null
        ? Number(override)
        : Number(settings?.weeklyAllowanceAmount) || 0;
    const range = `${sun.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${sat.toLocaleDateString(
      "en-US",
      {
        month: sun.getMonth() === sat.getMonth() ? undefined : "short",
        day: "numeric",
      },
    )}`;
    const label = weekOffset === 0 ? "This week" : range;
    // ◀ disabled once the window starts before what we fetched.
    const canPrev = startISO >= earliestFetchedISO;
    return { spend, cap, label, range, canPrev, startISO, endISO };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOffset, bucketSum, settings]);

  // ── B) Selected calendar MONTH allowance spend ─────────────────────────────
  const monthView = useMemo(() => {
    const m = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startISO = iso(m);
    const end = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    const endISO = iso(end);
    const spend = bucketSum("monthly", startISO, endISO);
    const cap = Number(settings?.monthlyAllowanceAmount) || 0;
    const name = m.toLocaleDateString("en-US", {
      month: "long",
      year: m.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
    const label = monthOffset === 0 ? "This month" : name;
    const canPrev = endISO >= earliestFetchedISO;
    return { spend, cap, label, name, canPrev, startISO, endISO };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthOffset, bucketSum, settings]);

  // ── C) Unplanned-allowance spend, CURRENT month. ───────────────────────────
  const unplannedView = useMemo(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const startISO = iso(first);
    const endISO = iso(last);
    const spend = bucketSum("unplanned", startISO, endISO);
    const cap = Number(settings?.unplannedAllowanceAmount) || 0;
    return { spend, cap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketSum, settings]);

  /**
   * The month's largest one-off charges. Same filter the page has always used
   * (`isSplurge` + the recurring-merchant screen from lib/discretionarySpend),
   * so bills, transfers, card payments and subscriptions stay out of it.
   *
   * ⚠️ Rows are keyed by transaction id and sorted ONCE, by id — `CssBars`
   * derives rank itself and moves rows by transform. Re-sorting this array
   * between renders would swap DOM nodes and defeat the glide.
   */
  const chargeRows = useMemo<CssBarRow[]>(() => {
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const isRecurring = makeRecurringMatcher(recurringNames);
    const recurringMerchants = recurringMerchantsFrom(weeklyTxns ?? []);
    return (weeklyTxns ?? [])
      .filter(
        (t: Transaction) =>
          t.occurredOn?.startsWith(ym) &&
          isSplurge(t, isRecurring) &&
          !recurringMerchants.has(merchantKey(t.description ?? "")),
      )
      .map((t: Transaction) => ({
        id: t.id,
        label: t.description || "Uncategorized charge",
        value: Math.abs(Number(t.amount) || 0),
        hint: shortDate(t.occurredOn) ?? undefined,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeklyTxns, recurringNames]);

  const snapshotAt = cashSignal?.snapshotAt ?? null;
  const snapshotSource = cashSignal?.snapshotSource === "plaid" ? "plaid" : "manual";
  const bankAsOf = shortDate(spine?.bank?.asOfDate);
  const nextBill = spine?.nextBill ?? null;
  const lowPoint = spine?.forecast?.lowPoint ?? null;
  const runwayDays = spine?.forecast?.runwayDays ?? null;

  return (
    <div className="space-y-4">
      {/* ── The spine row. Five figures, one request, one instant. ────────── */}
      <div
        data-testid="cc-spine-stats"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <Stat
          index={0}
          data-testid="cc-stat-bank"
          label="Bank balance"
          value={money(spine?.bank?.balance)}
          hint={bankAsOf ? `as of ${bankAsOf}` : undefined}
        />
        <Stat
          index={1}
          data-testid="cc-stat-spent-month"
          label="Spent this month"
          value={money(spine?.spentMonth)}
          hint="so far"
        />
        <Stat
          index={2}
          data-testid="cc-stat-spent-week"
          label="Spent this week"
          value={money(spine?.spentWeek)}
          hint="so far"
        />
        <Stat
          index={3}
          data-testid="cc-stat-next-bill"
          label="Next bill"
          value={money(nextBill?.amount)}
          hint={
            nextBill
              ? `${nextBill.name} · ${shortDate(nextBill.dueDate) ?? nextBill.dueDate}`
              : "none scheduled"
          }
        />
        <Stat
          index={4}
          data-testid="cc-stat-low-point"
          label="Cash low point"
          value={money(lowPoint)}
          tone={lowPoint != null && Number(lowPoint) < 0 ? "bad" : "navy"}
          hint={
            runwayDays != null ? `negative in ${runwayDays} days` : "next 90 days"
          }
        />
      </div>

      {/* ── Spend this month vs last, and where it went. Pure math, server
             classified — the same spending-facts basis the spine uses. The
             sync controls dock in this card's head, beside the freshness of
             the balance they refresh. ─────────────────────────────────────── */}
      <ChaseInsightStrip
        range={monthRange}
        actions={
          <>
            {snapshotAt && (
              <span className="hidden text-micro text-neutral-400 sm:block">
                <BankSnapshotFreshness source={snapshotSource} at={snapshotAt} />
              </span>
            )}
            {/* `compact` because the head already carries a timestamp — the
                button's own "Last synced" line would stack a second one under
                it and read as a duplicate. It stays in the tooltip. */}
            <SyncButton asKit compact />
          </>
        }
      />

      {/* ── Allowance buckets ─────────────────────────────────────────────── */}
      <section className={card} data-testid="cc-allowances">
        <div className={cardHead}>
          <h2 className="text-title font-semibold text-brand-navy">Allowances</h2>
          <Help>
            Counts only transactions you explicitly filed into a bucket on the
            Allowances page; anything unfiled counts nowhere. Weekly runs
            Sunday to Saturday.
          </Help>
          <Link
            href="/allowances"
            className="press ml-auto rounded-control px-2 py-1 text-micro font-semibold text-neutral-500 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy"
          >
            Open
          </Link>
        </div>
        <div role="table" aria-label="Allowance buckets">
          {/* Column heads are a desktop affordance; the phone layout labels
              itself, so a header row there would be four words of noise. */}
          <div
            role="row"
            className={`hidden border-b border-brand-line sm:grid ${ROW_GRID.replace("grid ", "").replace("py-3", "py-2")}`}
          >
            <div role="columnheader" className={headCell}>Bucket</div>
            <div role="columnheader" className={headCell}>Period</div>
            <div role="columnheader" className={`${headCell} justify-self-end`}>Spent</div>
            <div role="columnheader" className={`${headCell} justify-self-end`}>Cap</div>
            <div role="columnheader" className={`${headCell} justify-self-end`}>Status</div>
          </div>
          <AllowanceRow
            name="Weekly"
            href="/allowances?view=week"
            testid="cc-week-tile"
            period={
              <Pager
                label="week"
                period={weekView.label}
                onPrev={() => setWeekOffset((o) => o - 1)}
                onNext={() => setWeekOffset((o) => Math.min(0, o + 1))}
                canPrev={weekView.canPrev}
                canNext={weekOffset < 0}
              />
            }
            spend={weekView.spend}
            cap={weekView.cap}
          />
          <AllowanceRow
            name="Monthly"
            href="/allowances?view=month"
            testid="cc-month-tile"
            period={
              <Pager
                label="month"
                period={monthView.label}
                onPrev={() => setMonthOffset((o) => o - 1)}
                onNext={() => setMonthOffset((o) => Math.min(0, o + 1))}
                canPrev={monthView.canPrev}
                canNext={monthOffset < 0}
              />
            }
            spend={monthView.spend}
            cap={monthView.cap}
          />
          <AllowanceRow
            name="Unplanned"
            href="/allowances?view=unplanned"
            testid="cc-unplanned-tile"
            period={
              <span className="text-label text-neutral-600">{monthRange.label}</span>
            }
            spend={unplannedView.spend}
            cap={unplannedView.cap}
          />
        </div>
      </section>

      {/* ── Biggest charges ───────────────────────────────────────────────── */}
      <section className={card} data-testid="cc-biggest-charges">
        <div className={cardHead}>
          <h2 className="text-title font-semibold text-brand-navy">
            Biggest charges
          </h2>
          <Help>
            One-off purchases this calendar month, largest first. Bills,
            subscriptions, transfers, card payments and reimbursables are
            excluded, so this is discretionary spend only.
          </Help>
          <span className="ml-auto text-micro uppercase tracking-wider text-neutral-400">
            {monthRange.label}
          </span>
        </div>
        {chargeRows.length ? (
          <>
            <div className="px-4 py-3">
              <CssBars
                rows={chargeRows}
                topN={8}
                ramp
                format={barMoney}
                labelWidth={narrow ? 104 : 170}
                valueWidth={narrow ? 78 : 104}
                ariaLabel="Biggest charges this month, largest first"
              />
            </div>
            <Foot>
              Darkest bar is the largest charge. Amounts are the posted
              transaction totals.
            </Foot>
          </>
        ) : (
          <div className={emptyNote}>No one-off charges this month.</div>
        )}
      </section>
    </div>
  );
}
