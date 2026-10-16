import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { Link } from "wouter";
import { Settings as SettingsIcon } from "lucide-react";
import { btnLink } from "@/ui";
import { PageGrid, Panel, StatBlock } from "@/components/next";
import { usePaneHeight } from "@/components/account-page/ledger-panel";
import { moneyFace } from "@/components/data-state";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ChartPanel, useChartModel } from "../next/forecast/ChartPanel";
import { DayPanel } from "../next/forecast/DayPanel";
import type { ForecastNextCtx } from "../next/forecast/types";
import { lowPointView } from "@/lib/lowPoint";
import { CheckingBalanceFull } from "@/components/checking-balance-note";
import { scrollBehavior } from "@/lib/reducedMotion";
import { shortDate } from "@/lib/dates";

/**
 * ⭐ THE FORECAST SCREEN (C13) — `/forecast`, `/review` and `/next/forecast`
 * are this one layout over `ForecastPage`'s ready-made sections (B2): the
 * register, drag-and-drop, month close and dialogs are the page's own
 * elements, and every figure is the page's own derived value.
 *
 * - A head, sticky from `md` up: the title (Forecast / Review), the Bills
 *   link, Settings, and the horizon controls (FC-15/16/17). Its measured
 *   height is `--page-sticky-top`, so the pinned review inbox (FC-44) sits
 *   right under it.
 * - The headline: "Forecast balance", its "How this adds up" disclosure (T3:
 *   start + in − out = end, all the cash signal's) and the "Inbox cleared"
 *   badge (FC-20/21) beside the six summary figures (FC-22).
 * - The projected-cash chart (FC-28/29, B2's expanded chart, with the classic
 *   big-bill markers re-hosted).
 * - The register panel (span-8) with its two views — "Register & review"
 *   (review mode) and "Month & bank" (overall mode: past due, bank cards, the
 *   planned list, month close) — beside the selected day and the balance on a
 *   chosen date (FC-23).
 *
 * The two views ARE the page's two modes. On `/forecast` and `/review` they
 * are links between the routes (each route keeps its own area in the nav);
 * on `/next/forecast` they switch in place (`onTab`).
 */
export type RegisterTab = "register" | "plan";

export const TAB_OF_MODE: Record<ForecastNextCtx["mode"], RegisterTab> = {
  review: "register",
  overall: "plan",
};

const TABS: Array<{ id: RegisterTab; label: string; href: string }> = [
  { id: "register", label: "Register & review", href: "/review" },
  { id: "plan", label: "Month & bank", href: "/forecast" },
];

const tabClass = (on: boolean) =>
  `press rounded-control px-3 py-1.5 text-label font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 ${
    on ? "bg-brand-navy text-white" : "text-neutral-500 hover:bg-neutral-50 hover:text-brand-navy"
  }`;

/** Integer cents of a served figure (NaN when missing) — only to check the identity, never shown. */
const cents = (v: string | null | undefined): number => (v == null || v === "" ? NaN : Math.round(Number(v) * 100));

/** One line of the disclosure: its words and its figure in one element (tests read "Matched impact …" as one line). */
function AddsUpLine({ label, value, testid, strong }: { label: string; value: string; testid: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-semibold text-brand-navy" : ""}`} data-testid={testid}>
      {label}
      <span className={`font-mono tabular-nums ${strong ? "text-brand-navy" : "text-neutral-700"}`}>{value}</span>
    </div>
  );
}

/** The Month & bank lists the cash signal keeps off (or carries onto) the curve, by anchor id. */
export const LIST_ANCHORS = {
  unpaid: "forecast-unpaid",
  incomeNotArrived: "forecast-income-not-arrived",
  olderUnpaid: "forecast-older-unpaid",
} as const;
type ListKey = keyof typeof LIST_ANCHORS;

/**
 * ⭐ (T3) HOW THIS ADDS UP — the hero's one calculation, opened on demand:
 * Starting balance + Money in − Money out = Ending, every figure the cash
 * signal's own (the walk; the server proves the identity on every horizon).
 * The "=" line is shown only when the four agree to the cent — a guard that
 * should never fire. Under it, the lists that explain what the curve carries
 * or leaves out, each a link to its card.
 */
function AddsUp({ ctx, onOpenList }: { ctx: ForecastNextCtx; onOpenList: ((key: ListKey) => void) | null }) {
  const { proj } = ctx;
  if (!proj) return null;
  const [start, inc, out, end] = [proj.startingBalance, proj.projectedIncome, proj.projectedExpenses, proj.endingBalance].map(cents);
  const ties = [start, inc, out, end].every(Number.isFinite) && start + inc - out === end;
  const counts = ctx.listCounts ?? { unpaid: 0, incomeNotArrived: 0, olderUnpaid: 0 };
  const lines: Array<{ key: ListKey; label: string; n: number }> = [
    { key: "unpaid", label: "Unpaid items", n: counts.unpaid },
    { key: "incomeNotArrived", label: "Income not arrived", n: counts.incomeNotArrived },
    { key: "olderUnpaid", label: "Older than 14 days · off the curve", n: counts.olderUnpaid },
  ];
  const shown = lines.filter((l) => l.n > 0);
  return (
    <details className="mt-3 text-micro text-neutral-600" data-testid="hero-adds-up">
      <summary className="press w-fit cursor-pointer rounded-control text-label font-semibold text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40">
        How this adds up
      </summary>
      <div className="mt-2 space-y-1">
        <AddsUpLine label={`Opening · ${shortDate(proj.fromDate ?? ctx.fromDate)}`} value={moneyFace(proj.startingBalance)} testid="adds-up-start" />
        <AddsUpLine label="+ Money in" value={moneyFace(proj.projectedIncome)} testid="adds-up-in" />
        <AddsUpLine label="− Money out" value={moneyFace(proj.projectedExpenses)} testid="adds-up-out" />
        {ties && (
          <div className="border-t border-brand-line pt-1">
            <AddsUpLine
              label={`= Ending ${shortDate(proj.endingDate ?? proj.toDate ?? ctx.fromDate)}`}
              value={moneyFace(proj.endingBalance)}
              testid="adds-up-end"
              strong
            />
          </div>
        )}
        <AddsUpLine label="Matched impact" value={moneyFace(proj.acceptedImpact)} testid="adds-up-matched" />
      </div>
      {shown.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-brand-line pt-2" data-testid="adds-up-lists">
          {shown.map((l) => (
            <li key={l.key}>
              {/* On /review the lists are the other route's ("Month & bank"): a link there. */}
              {onOpenList ? (
                <button
                  type="button"
                  className={`${btnLink} flex w-full justify-between gap-3`}
                  onClick={() => onOpenList(l.key)}
                  data-testid={`adds-up-list-${l.key}`}
                >
                  {l.label}
                  <span className="font-mono tabular-nums">{l.n}</span>
                </button>
              ) : (
                <Link href="/forecast" className={`${btnLink} flex w-full justify-between gap-3`} data-testid={`adds-up-list-${l.key}`}>
                  {l.label}
                  <span className="font-mono tabular-nums">{l.n}</span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** The headline: where checking lands at the end of the horizon (FC-20),
 *  "How this adds up" under it, and the "Inbox cleared" badge (FC-21). Read
 *  off the same cash signal as everything else. */
function ForecastHero({ ctx, onOpenList }: { ctx: ForecastNextCtx; onOpenList: ((key: ListKey) => void) | null }) {
  const { proj, projReady } = ctx;
  const endingNum = proj?.endingBalance ? Number(proj.endingBalance) : NaN;
  return (
    <Panel
      title="Forecast balance"
      span={4}
      variant="static"
      data-testid="card-forecast-hero"
      actions={
        ctx.inboxCount === 0 && ctx.reconciledNow ? (
          <span className="chip ok" data-testid="badge-inbox-cleared">
            Inbox cleared
          </span>
        ) : null
      }
    >
      <div
        className={`font-mono text-display font-semibold tabular-nums ${
          projReady && Number.isFinite(endingNum) && endingNum < 0 ? "text-bad" : "text-brand-navy"
        }`}
        data-testid="hero-forecast-balance"
      >
        {/* No projection yet, or no bank balance to project from: a dash, never
            $0.00 dressed as a real ending balance. */}
        {moneyFace(projReady ? proj?.endingBalance : null)}
      </div>
      {projReady && proj?.endingDate ? (
        <div className="mt-1 text-micro text-neutral-600" data-testid="hero-ending-date">
          End of {shortDate(proj.endingDate)}
        </div>
      ) : null}
      {projReady ? <AddsUp ctx={ctx} onOpenList={onOpenList} /> : null}
    </Panel>
  );
}

/** The same headline figures the classic page shows, read off the same cash
 *  signal (FC-22). */
function SummaryStrip({ ctx, onSeeDay }: { ctx: ForecastNextCtx; onSeeDay: (date: string) => void }) {
  const { proj, projReady } = ctx;
  const lowest = proj?.lowestProjected ? Number(proj.lowestProjected) : NaN;
  const buffer = Number.isFinite(ctx.cashBufferNum) ? ctx.cashBufferNum : null;
  // ⭐ (T2) One reading of the low point (lib/lowPoint): only a projected NEGATIVE is rust; under the
  // buffer at or above $0 is quiet ("Under the $500 buffer"); the words are the dashboard tile's.
  const low = lowPointView(
    proj ? { lowPoint: proj.lowestProjected, lowPointDate: proj.lowestDate, status: proj.status, cashBuffer: proj.cashBuffer } : null,
  );
  const account = `${ctx.bankAccountName}${ctx.bankAccountMask ? ` ••${ctx.bankAccountMask}` : ""}`;
  return (
    <Panel title="Where the money lands" span={8} variant="static" data-testid="forecast-kpis">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
        {/* ⭐ (T1) Checking today = the dashboard's figure (cashSignal.bankToday), never the raw reading;
            no reading is a dash, never $0.00. An older answer says so instead of "as of". */}
        <div data-testid="kpi-bank-today">
          <CheckingBalanceFull
            size="kpi"
            figure={ctx.bankBalance}
            reading={ctx.bankReading}
            since={ctx.bankSince}
            older={ctx.bankOlder}
            testids={{ figure: "kpi-bank-today-figure", line: "kpi-bank-today-line", details: "kpi-bank-today-details" }}
          />
          <div className="mt-0.5 text-micro text-neutral-600" data-testid="kpi-bank-today-account">{account}</div>
        </div>
        <StatBlock
          data-testid="kpi-cash-buffer"
          label="Cash buffer"
          value={buffer == null ? "—" : formatCurrency(buffer)}
        />
        <StatBlock
          data-testid="kpi-lowest-point"
          label="Lowest point"
          value={projReady && Number.isFinite(lowest) ? formatCurrency(lowest) : "—"}
          tone={projReady && low.tone === "bad" ? "bad" : "neutral"}
          hint={
            !projReady || !low.chip ? (
              "Sync to read the bank balance"
            ) : (
              <>
                {low.chip.word}
                {/* ⭐ (T3) The low point's day is an action: it selects that day on the chart (`?day=`). */}
                {proj?.lowestDate ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className={btnLink}
                      onClick={() => onSeeDay(proj.lowestDate!)}
                      data-testid="kpi-lowest-see-day"
                    >
                      {low.value != null && low.value < 0 ? "Review shortfall" : `See ${shortDate(proj.lowestDate)}`}
                    </button>
                  </>
                ) : null}
              </>
            )
          }
        />
        <StatBlock
          data-testid="kpi-ending-balance"
          label="Ending balance"
          value={proj && proj.status !== "no_data" ? moneyFace(proj.endingBalance) : "—"}
          tone={proj && proj.status !== "no_data" && Number(proj.endingBalance) < 0 ? "bad" : "neutral"}
          hint={proj?.endingDate ? formatDate(proj.endingDate) : `${ctx.horizonDays}-day horizon`}
        />
        <StatBlock
          data-testid="kpi-projected-income"
          label="Money in"
          value={proj ? moneyFace(proj.projectedIncome) : "—"}
          hint={`over ${ctx.horizonDays}d`}
        />
        <StatBlock
          data-testid="kpi-projected-expenses"
          label="Money out"
          value={proj ? moneyFace(proj.projectedExpenses) : "—"}
          hint={`over ${ctx.horizonDays}d`}
        />
      </div>
    </Panel>
  );
}

export function ForecastBody({
  ctx,
  tab,
  onTab,
  selectedDate,
  setSelectedDate,
  title,
}: {
  ctx: ForecastNextCtx;
  tab: RegisterTab;
  /** In-place tab switching (`/next/forecast`). Without it the tabs are links
   *  to `/review` and `/forecast`. */
  onTab?: (t: RegisterTab) => void;
  selectedDate: string | null;
  setSelectedDate: (d: string | null) => void;
  title: string;
}) {
  const { kinded, bank, markers, incomeByDate } = useChartModel(ctx);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);
  // Switch to the register first, then jump: the row has to be on screen.
  // Off `/next/forecast` the register view is the other route, so the selected
  // day's register jump only runs in place when the register is showing.
  const openRegister = useCallback(
    (then: () => void) => {
      if (tab === "register" || !onTab) {
        then();
        return;
      }
      onTab("register");
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(then, 80);
    },
    [tab, onTab],
  );

  // ⭐ (T3) "How this adds up" opens a Month & bank list: on that view it
  // scrolls there; in place (`/next/forecast`) it switches the view first; on
  // `/review` the list is the other route's, so it is a link there (AddsUp).
  const scrollToId = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    el.focus({ preventScroll: true });
  };
  const openList =
    tab === "plan" || onTab
      ? (key: ListKey) => {
          const id = LIST_ANCHORS[key];
          if (tab === "plan") return scrollToId(id);
          onTab!("plan");
          if (pending.current) clearTimeout(pending.current);
          pending.current = setTimeout(() => scrollToId(id), 80);
        }
      : null;
  // ⭐ (T3) A page opened on `?day=` (dashboard "Review shortfall", a shared
  // link) lands on that day: once the curve is drawn, the day panel is brought
  // into view — once, never again on a refetch or a later pick.
  const landed = useRef(selectedDate == null);
  const curveDrawn = ctx.dailySeries.length > 0;
  useEffect(() => {
    if (landed.current || !curveDrawn) return;
    landed.current = true;
    const t = setTimeout(() => scrollToId("selected-day"), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curveDrawn]);
  // The low point's day: select it (the URL carries it) and bring the day panel into view.
  const seeDay = (date: string) => {
    setSelectedDate(date);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => scrollToId("selected-day"), 0);
  };

  const tabLabel = (id: RegisterTab) =>
    `${TABS.find((t) => t.id === id)!.label}${id === "register" && ctx.inboxCount > 0 ? ` · ${ctx.inboxCount}` : ""}`;

  // The sticky head's height, published for the rows that pin under it.
  // ⚠️ The head sticks from `md` up only: on a phone its horizons wrap to
  // three lines (≈ 135 px of an 844 px screen) and nothing pins under it —
  // the review inbox pins only at ≥ 768 px wide (`canPinInbox`), the same
  // width as `md` — so there it scrolls away with the page.
  const headRef = useRef<HTMLDivElement | null>(null);
  const headH = usePaneHeight(headRef, []);
  const stickyTop = { ["--page-sticky-top" as string]: `${headH}px` } as CSSProperties;

  return (
    <div style={stickyTop} data-testid="forecast-screen">
      <div
        ref={headRef}
        className="page-sticky-head z-30 space-y-2 border-b border-brand-line bg-platinum-1 pt-2 pb-2 md:sticky md:top-0 md:pt-3"
        data-testid="forecast-sticky-head"
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* ⭐ The head just names the screen; the register says the rest. */}
          <h1 className="text-title font-semibold text-brand-navy">{title}</h1>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Link href="/bills" data-testid="link-manage-bills" className={btnLink}>
              Bills
            </Link>
            <button type="button" onClick={ctx.openSettings} className={btnLink} data-testid="button-forecast-settings">
              <SettingsIcon className="h-3 w-3" aria-hidden="true" /> Settings
            </button>
          </div>
        </div>
        <div data-testid="forecast-controls">{ctx.horizonControls}</div>
      </div>

      <PageGrid className="mt-4">
        <ForecastHero ctx={ctx} onOpenList={openList} />
        <SummaryStrip ctx={ctx} onSeeDay={seeDay} />

        <ChartPanel
          ctx={ctx}
          kinded={kinded}
          markers={markers}
          incomeByDate={incomeByDate}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />

        {/* (T3) `selected-day`: where "See <day>" / `?day=` bring the reader (scroll target, focusable). */}
        <div id="selected-day" tabIndex={-1} className="span-4 min-w-0 space-y-4 scroll-mt-[var(--page-sticky-top,0px)] outline-none">
          <Panel title="Selected day" variant="static" data-testid="selected-day-panel">
            <DayPanel
              ctx={ctx}
              kinded={kinded}
              bank={bank}
              selectedDate={selectedDate}
              onClear={() => setSelectedDate(null)}
              onOpenRegister={openRegister}
            />
          </Panel>
          {ctx.dateBalance}
        </div>

        {/* ⚠️ STICKY-SAFE: the review inbox inside pins to <main> under the
            head (FC-44); an `overflow: hidden` panel would hold it in place.
            No entrance transform here — the register hosts the drag overlay. */}
        <Panel
          title={
            // On a phone the two view tabs fill the head (≈ 284 of 332 px), so
            // the title — the selected tab's own words — is read, not shown.
            <span className="max-sm:sr-only">{tab === "register" ? "Register & review" : "Month & bank"}</span>
          }
          span={12}
          variant={["sticky-safe", "static"]}
          className="min-w-0"
          data-testid="register-panel"
          actions={
            // ⚠️ Two shapes, one look. In place (`/next/forecast`) the views are
            // real tabs over one tabpanel. On `/forecast` and `/review` each
            // view is the other ROUTE, so they are links in a nav with
            // `aria-current` — a "tab" that navigates away is not a tab, and an
            // `aria-controls` pointing at a pane that is not on the page is an
            // axe violation (a11y-smoke scans /review).
            onTab ? (
              <div role="tablist" aria-label="Register views" className="flex flex-wrap items-center gap-1">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`register-tab-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls="register-pane"
                    onClick={() => onTab(t.id)}
                    data-testid={`tab-${t.id}`}
                    className={tabClass(tab === t.id)}
                  >
                    {tabLabel(t.id)}
                  </button>
                ))}
              </div>
            ) : (
              <nav aria-label="Register views" className="flex flex-wrap items-center gap-1">
                {TABS.map((t) => (
                  <Link
                    key={t.id}
                    href={t.href}
                    id={`register-tab-${t.id}`}
                    aria-current={tab === t.id ? "page" : undefined}
                    data-testid={`tab-${t.id}`}
                    className={tabClass(tab === t.id)}
                  >
                    {tabLabel(t.id)}
                  </Link>
                ))}
              </nav>
            )
          }
        >
          <div
            key={tab}
            role={onTab ? "tabpanel" : undefined}
            id="register-pane"
            aria-labelledby={onTab ? `register-tab-${tab}` : undefined}
            className="space-y-4"
          >
            {tab === "register" ? (
              ctx.registerBlock
            ) : (
              <>
                {ctx.draggingCard}
                {ctx.bankGrid}
                {ctx.registerBlock}
                {ctx.monthBlock}
              </>
            )}
          </div>
        </Panel>
      </PageGrid>
    </div>
  );
}

/** The route's view of the page: its mode decides the register view. */
export function forecastTitle(mode: ForecastNextCtx["mode"]): string {
  return mode === "review" ? "Review" : "Forecast";
}
