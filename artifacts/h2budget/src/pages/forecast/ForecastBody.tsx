import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { Link } from "wouter";
import { Settings as SettingsIcon } from "lucide-react";
import { Help, btnLink } from "@/ui";
import { PageGrid, Panel, StatBlock } from "@/components/next";
import { usePaneHeight } from "@/components/account-page/ledger-panel";
import { moneyFace } from "@/components/data-state";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ChartPanel, useChartModel } from "../next/forecast/ChartPanel";
import { DayPanel } from "../next/forecast/DayPanel";
import type { ForecastNextCtx } from "../next/forecast/types";

/**
 * ⭐ THE FORECAST SCREEN (C13) — `/forecast`, `/review` and `/next/forecast`
 * are this one layout over `ForecastPage`'s ready-made sections (B2): the
 * register, drag-and-drop, month close and dialogs are the page's own
 * elements, and every figure is the page's own derived value.
 *
 * - A head, sticky from `md` up: the title (Forecast / Review) and its Help,
 *   the Bills link, Settings, and the horizon controls (FC-15/16/17). Its
 *   measured height is `--page-sticky-top`, so the pinned review inbox (FC-44)
 *   sits right under it.
 * - The headline: "Forecast balance" with its footnotes and the "Inbox
 *   cleared" badge (FC-20/21) beside the six summary figures (FC-22).
 * - The projected-cash chart (FC-28/29, B2's expanded chart, with the classic
 *   big-bill markers re-hosted).
 * - The register panel (span-8) with its two views — "Register & reconcile"
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
  { id: "register", label: "Register & reconcile", href: "/review" },
  { id: "plan", label: "Month & bank", href: "/forecast" },
];

const tabClass = (on: boolean) =>
  `press rounded-control px-3 py-1.5 text-label font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 ${
    on ? "bg-brand-navy text-white" : "text-neutral-500 hover:bg-neutral-50 hover:text-brand-navy"
  }`;

/** The headline: where checking lands at the end of the horizon (FC-20),
 *  with the three figures it is built from as a footnote, and the "Inbox
 *  cleared" badge (FC-21). Read off the same cash signal as everything else. */
function ForecastHero({ ctx }: { ctx: ForecastNextCtx }) {
  const { proj, projReady } = ctx;
  const endingNum = proj?.endingBalance ? Number(proj.endingBalance) : NaN;
  return (
    <Panel
      title="Forecast balance"
      span={4}
      variant="static"
      data-testid="card-forecast-hero"
      actions={
        <>
          {ctx.inboxCount === 0 && ctx.reconciledNow && (
            <span className="chip ok" data-testid="badge-inbox-cleared">
              Inbox cleared
            </span>
          )}
          <Help>
            Where checking lands at the end of the horizon: the bank balance
            before the start date, plus every matched and still-planned item
            between then and the end date.
          </Help>
        </>
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
      {/* Each footnote is one element holding its words and its figure, as
          the classic foot did (tests read "Matched impact …" as one line). */}
      <div className="mt-3 space-y-1 text-micro text-neutral-500" data-testid="hero-footnotes">
        {/* The date the figure beside it was computed for (the server's
            household day when look-back is closed). */}
        <div className="flex justify-between gap-3">
          Bank before {formatDate(ctx.fromDate)}
          <span className="font-mono tabular-nums text-neutral-600">
            {moneyFace(projReady ? proj?.startingBalance : null)}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          Matched impact
          <span className="font-mono tabular-nums text-neutral-600">
            {moneyFace(projReady ? proj?.acceptedImpact : null)}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          Through {formatDate(proj?.endingDate ?? proj?.toDate ?? ctx.fromDate)}
          <span className="font-mono tabular-nums text-neutral-600">
            {moneyFace(projReady ? proj?.endingBalance : null)}
          </span>
        </div>
      </div>
    </Panel>
  );
}

/** The same headline figures the classic page shows, read off the same cash
 *  signal (FC-22). */
function SummaryStrip({ ctx }: { ctx: ForecastNextCtx }) {
  const { proj, projReady } = ctx;
  const lowest = proj?.lowestProjected ? Number(proj.lowestProjected) : NaN;
  const buffer = Number.isFinite(ctx.cashBufferNum) ? ctx.cashBufferNum : null;
  const dips = Number.isFinite(lowest) && lowest < Number(proj?.cashBuffer ?? 0);
  return (
    <Panel title="Where the money lands" span={8} variant="static" data-testid="forecast-kpis">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
        <StatBlock
          data-testid="kpi-bank-today"
          label="Bank today"
          value={formatCurrency(ctx.bankBalance)}
          hint={`${ctx.bankAccountName}${ctx.bankAccountMask ? ` ••${ctx.bankAccountMask}` : ""}`}
        />
        <StatBlock
          data-testid="kpi-cash-buffer"
          label="Cash buffer"
          value={buffer == null ? "—" : formatCurrency(buffer)}
        />
        <StatBlock
          data-testid="kpi-lowest-point"
          label="Lowest point"
          value={projReady && Number.isFinite(lowest) ? formatCurrency(lowest) : "—"}
          tone={dips ? "bad" : "neutral"}
          hint={`${!projReady ? "Set a bank balance to project" : dips ? "under buffer" : "above buffer"}${
            proj?.lowestDate ? ` · ${formatDate(proj.lowestDate)}` : ""
          }`}
        />
        <StatBlock
          data-testid="kpi-ending-balance"
          label="Ending balance"
          value={proj && proj.status !== "no_data" ? formatCurrency(proj.endingBalance ?? 0) : "—"}
          hint={proj?.endingDate ? formatDate(proj.endingDate) : `${ctx.horizonDays}-day horizon`}
        />
        <StatBlock
          data-testid="kpi-projected-income"
          label="Money in"
          value={proj ? formatCurrency(Number(proj.projectedIncome) || 0) : "—"}
          hint={`over ${ctx.horizonDays}d`}
        />
        <StatBlock
          data-testid="kpi-projected-expenses"
          label="Money out"
          value={proj ? formatCurrency(Number(proj.projectedExpenses) || 0) : "—"}
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
  const { kinded, markers, incomeByDate } = useChartModel(ctx);
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
          <Help>
            Plans are matched to bank activity by you — nothing is auto-accepted.
            A matched plan leaves the register and lands in the month's bucket.
          </Help>
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
        <p className="span-12 text-micro text-neutral-600" data-testid="filters-note">
          What filters do: the horizon and look-back are sent to the forecast, so they change the curve and every figure
          around it. The month picker and the register views only change which rows are listed.
        </p>

        <ForecastHero ctx={ctx} />
        <SummaryStrip ctx={ctx} />

        <ChartPanel
          ctx={ctx}
          kinded={kinded}
          markers={markers}
          incomeByDate={incomeByDate}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />

        {/* ⚠️ STICKY-SAFE: the review inbox inside pins to <main> under the
            head (FC-44); an `overflow: hidden` panel would hold it in place.
            No entrance transform here — the register hosts the drag overlay. */}
        <Panel
          title={
            // On a phone the two view tabs fill the head (≈ 284 of 332 px), so
            // the title — the selected tab's own words — is read, not shown.
            <span className="max-sm:sr-only">{tab === "register" ? "Register & reconcile" : "Month & bank"}</span>
          }
          span={8}
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

        <div className="span-4 min-w-0 space-y-4">
          <Panel title="Selected day" variant="static" data-testid="selected-day-panel">
            <DayPanel
              ctx={ctx}
              kinded={kinded}
              selectedDate={selectedDate}
              onClear={() => setSelectedDate(null)}
              onOpenRegister={openRegister}
            />
          </Panel>
          {ctx.dateBalance}
        </div>
      </PageGrid>
    </div>
  );
}

/** The route's view of the page: its mode decides the register view. */
export function forecastTitle(mode: ForecastNextCtx["mode"]): string {
  return mode === "review" ? "Review" : "Forecast";
}
