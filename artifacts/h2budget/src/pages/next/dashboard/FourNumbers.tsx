import type { ReactNode } from "react";
import type { Spine } from "@workspace/api-client-react";
import { bankBalanceView } from "@/lib/bankBalance";
import { lowPointView } from "@/lib/lowPoint";
import { weekStory } from "@/lib/weekFigures";
import { useSpine } from "@/hooks/useSpine";
import { cn } from "@/lib/utils";
import { useReadyMark } from "@/lib/perfMarks";
import { dayLabel, money, PanelError, weekdayLabel } from "./shared";
import { Fig, FillBar, FOUR_BODY, FOUR_BOX, FOUR_BOX_BAR, FOUR_GRID, Skel, Tile } from "./tileParts";

/**
 * ⭐ THE FOUR NUMBERS (owner, 2026-11-11: the home page was "cluttered, lots of
 * words"). Checking · Lowest · Spent this week · Debt paid: each box is ONE big
 * number and at most one short line, no status chip, and one whole-card link to
 * the page the matching tile under "More" opens. Nothing is worked out here:
 * every figure is a spine field (PERF: the week's cap and the forecast's
 * weekly amount ride on it too, from their owners), so the four boxes wait on one request. Unknown and
 * loading draw "—" or a skeleton, never $0.
 *
 * (Home says less, 2026-11-11) Spent this week and Debt paid each carry one
 * thin bar under the number (`FillBar`: navy, deep orange once past the
 * plan). The bar paints a quantity the box already says in words; it is never
 * the only signal. The week's line is the server's own remaining figure, said
 * by sign: "$X left" or "$X over".
 */

/** A whole-dollar amount loses its ".00" in a line (as the week tile's "Forecast assumes" line does). */
const short = (v: string | number | null | undefined) => money(v).replace(/\.00$/, "");

/** The one short line under a number. Its height is held when empty, so the four boxes stay level. */
function Line({ children, bad, testid }: { children?: ReactNode; bad?: boolean; testid: string }) {
  return (
    <div className={cn("min-h-[1lh] text-label", bad ? "font-semibold text-bad-ink" : "text-neutral-600")}>
      {children != null && children !== "" ? <span data-testid={testid}>{children}</span> : null}
    </div>
  );
}

/** The thin bar's place under a number. Its height is held with no bar to draw, so the box never changes size. */
function Bar({ value, ceiling, testid }: { value?: number; ceiling?: number; testid: string }) {
  return (
    <div className="h-1.5">
      {value != null && ceiling != null && Number.isFinite(value) && Number.isFinite(ceiling) && ceiling > 0 ? (
        <span className="block" data-testid={testid}>
          <FillBar value={value} ceiling={ceiling} />
        </span>
      ) : null}
    </div>
  );
}

/** The low point looks 90 days ahead (the spine's horizon, and the link's). */
const LOWEST = (
  <>
    Lowest cash · <span className="whitespace-nowrap">90 days</span>
  </>
);

/**
 * Each box while the spine is on its way. (Motion pass, 2026-11-11) The SAME component draws the skeleton and the
 * figure, so the box is one node from first paint on: its entrance plays once. Swapping a skeleton tile for a
 * different component remounted it, and the four boxes blinked out and rose in a second time when the numbers came.
 */
const LOADING = {
  checking: { testid: "four-checking", title: "Checking", href: "/banking", accent: "checking", box: FOUR_BOX },
  lowest: { testid: "four-lowest", title: LOWEST, href: "/forecast?horizon=90", accent: "other", box: FOUR_BOX },
  spent: { testid: "four-spent", title: "Spent this week", href: "/spending/week", accent: "checking", box: FOUR_BOX_BAR },
  debt: { testid: "four-debt", title: "Debt paid", href: "/avalanche", accent: "other", box: FOUR_BOX_BAR },
} as const;

function Checking({ s, older }: { s: Spine | undefined; older?: string | null }) {
  if (!s) return <Tile cell {...LOADING.checking} index={2} body={FOUR_BODY}><Skel /></Tile>;
  const v = bankBalanceView(s.bank);
  const bal = Number(s.bank.balance);
  const n = s.reviewCount;
  // The Banking tile's own link: the account the balance rolls forward on. With rows to match it lands on
  // Banking's "Needs you" list, where each one is answered with OK or Change.
  const base = v.account?.rowId ? `/banking?account=${encodeURIComponent(v.account.rowId)}` : "/banking";
  const href = n > 0 && v.balance != null ? `${base}#needs-you` : base;
  return (
    <Tile cell testid="four-checking" title="Checking" href={href} accent="checking" index={2} box={FOUR_BOX} body={FOUR_BODY}>
      <Fig
        big testid="four-checking-value"
        value={v.balance == null ? "—" : money(s.bank.balance)}
        tone={!older && v.balance != null && Number.isFinite(bal) && bal < 0 ? "bad" : "neutral"}
      />
      <Line testid="four-checking-line">{v.balance == null ? "No bank balance yet." : n > 0 ? `${n} ${n === 1 ? "needs" : "need"} you` : null}</Line>
    </Tile>
  );
}

function Lowest({ s }: { s: Spine | undefined }) {
  if (!s) return <Tile cell {...LOADING.lowest} index={3} body={FOUR_BODY}><Skel /></Tile>;
  const f = s.forecast;
  const v = lowPointView(f, { buffer: f.cashBuffer, stale: s.bank.stale });
  const below = v.value != null && v.value < 0;
  const day = v.date ? (weekdayLabel(v.date) ?? dayLabel(v.date)) : null;
  // The Forecast tile's own link: below zero, it opens the day it happens.
  const href = `/forecast?horizon=90${below && v.date ? `&day=${encodeURIComponent(v.date.slice(0, 10))}` : ""}`;
  return (
    <Tile cell testid="four-lowest" title={LOWEST} href={href} accent="other" index={3} box={FOUR_BOX} body={FOUR_BODY}>
      <Fig big testid="four-lowest-value" value={v.kind === "none" ? "—" : money(v.value)} tone={v.tone} />
      <Line testid="four-lowest-line" bad={below}>
        {v.kind === "none" ? v.words : below ? `Below zero${day ? ` · ${day}` : ""}` : day}
      </Line>
    </Tile>
  );
}

/** The box is one node from skeleton to figure; what it reads (and asks for) mounts with the spine, as before. */
function SpentThisWeek({ s }: { s: Spine | undefined }) {
  return (
    <Tile cell {...LOADING.spent} index={4} body={FOUR_BODY}>
      {s ? <SpentBody s={s} /> : <Skel />}
    </Tile>
  );
}

function SpentBody({ s }: { s: Spine }) {
  // ⭐ (PERF) Everything this box says comes from the spine: the week's cap (the money position's) and, with no
  // plan, the forecast's own weekly amount — so Home's four numbers wait on one answer, not three.
  const cap = s.position.weekCap ?? null;
  const of = cap != null ? cap : (s.position.weekForecastAmount ?? null);
  // The plan against what counts toward it: the spine's own remaining figure (negative when over), said by sign.
  const w = weekStory(s.position);
  const known = Number(w.known);
  // No plan set: the same subtraction against the forecast's weekly amount, so an over week still says "over".
  const ofN = of != null ? Number(of) : NaN;
  const rem = w.planSet ? w.remainingKnown : Number.isFinite(ofN) ? Math.round((ofN - known) * 100) / 100 : null;
  // (PERF-0) All four boxes real: this body mounts with the spine, which now carries all it reads.
  useReadyMark("h2:home-numbers-ready", true);
  return (
    <>
      <Fig big testid="four-spent-value" value={money(w.known)} />
      {/* The bar's length only: spent against (spent + what is left), which is the week's amount. */}
      <Bar testid="four-spent-bar" value={rem != null ? known : undefined} ceiling={rem != null ? known + rem : undefined} />
      {rem != null ? (
        <Line testid="four-spent-line" bad={rem < 0}>
          {rem < 0 ? `${short(-rem)} over` : `${short(rem)} left`}
          {of != null ? <span className="sr-only"> of the {short(of)} {cap != null ? "planned" : "the forecast sets aside"} for this week</span> : null}
        </Line>
      ) : (
        <Line testid="four-spent-line">{null}</Line>
      )}
    </>
  );
}

function DebtPaid({ s }: { s: Spine | undefined }) {
  if (!s) return <Tile cell {...LOADING.debt} index={5} body={FOUR_BODY}><Skel /></Tile>;
  const pct = s.debt.payoffPct;
  return (
    <Tile cell testid="four-debt" title="Debt paid" href="/avalanche" accent="other" index={5} box={FOUR_BOX_BAR} body={FOUR_BODY}>
      <Fig big testid="four-debt-value" value={pct == null ? "—" : `${Math.round(pct)}%`} />
      <Bar testid="four-debt-bar" value={pct ?? undefined} ceiling={pct == null ? undefined : 100} />
      <Line testid="four-debt-line">{pct == null ? "No debt has a starting balance yet." : `${short(s.debt.paidDownMtd)} this month`}</Line>
    </Tile>
  );
}

export default function FourNumbers() {
  const spine = useSpine();
  const s = spine.data;
  if (!s && spine.state === "failed") {
    return <div className="span-12"><PanelError what="The numbers" onRetry={spine.refetch} /></div>;
  }
  return (
    <div className={FOUR_GRID} data-testid="dash-four">
      <Checking s={s} older={spine.olderWords} />
      <Lowest s={s} />
      <SpentThisWeek s={s} />
      <DebtPaid s={s} />
    </div>
  );
}
