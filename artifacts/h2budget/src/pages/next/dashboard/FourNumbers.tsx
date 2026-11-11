import type { ReactNode } from "react";
import type { Spine } from "@workspace/api-client-react";
import { bankBalanceView } from "@/lib/bankBalance";
import { lowPointView } from "@/lib/lowPoint";
import { weekStory } from "@/lib/weekFigures";
import { useSpine } from "@/hooks/useSpine";
import { cn } from "@/lib/utils";
import { useCashSignalQ, useMoneyPositionQ } from "./queries";
import { dayLabel, money, PanelError, weekdayLabel } from "./shared";
import { Fig, FillBar, FOUR_BODY, FOUR_BOX, FOUR_BOX_BAR, FOUR_GRID, Skel, Tile } from "./tileParts";

/**
 * ⭐ THE FOUR NUMBERS (owner, 2026-11-11: the home page was "cluttered, lots of
 * words"). Checking · Lowest · Spent this week · Debt paid: each box is ONE big
 * number and at most one short line, no status chip, and one whole-card link to
 * the page the matching tile under "More" opens. Nothing is worked out here:
 * every figure is a field an existing tile already reads (the spine's, the
 * money position's weekly plan, the cash signal's weekly amount). Unknown and
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

function Checking({ s, older }: { s: Spine; older?: string | null }) {
  const v = bankBalanceView(s.bank);
  const bal = Number(s.bank.balance);
  const n = s.reviewCount;
  // The Banking tile's own link: the account the balance rolls forward on.
  const href = v.account?.rowId ? `/banking?account=${encodeURIComponent(v.account.rowId)}` : "/banking";
  return (
    <Tile testid="four-checking" title="Checking" href={href} accent="checking" index={2} box={FOUR_BOX} body={FOUR_BODY}>
      <Fig
        big testid="four-checking-value"
        value={v.balance == null ? "—" : money(s.bank.balance)}
        tone={!older && v.balance != null && Number.isFinite(bal) && bal < 0 ? "bad" : "neutral"}
      />
      <Line testid="four-checking-line">{v.balance == null ? "No bank balance yet." : n > 0 ? `${n} to match` : null}</Line>
    </Tile>
  );
}

/** The low point looks 90 days ahead (the spine's horizon, and the link's). */
const LOWEST = (
  <>
    Lowest cash · <span className="whitespace-nowrap">90 days</span>
  </>
);

function Lowest({ s }: { s: Spine }) {
  const f = s.forecast;
  const v = lowPointView(f, { buffer: f.cashBuffer, stale: s.bank.stale });
  const below = v.value != null && v.value < 0;
  const day = v.date ? (weekdayLabel(v.date) ?? dayLabel(v.date)) : null;
  // The Forecast tile's own link: below zero, it opens the day it happens.
  const href = `/forecast?horizon=90${below && v.date ? `&day=${encodeURIComponent(v.date.slice(0, 10))}` : ""}`;
  return (
    <Tile testid="four-lowest" title={LOWEST} href={href} accent="other" index={3} box={FOUR_BOX} body={FOUR_BODY}>
      <Fig big testid="four-lowest-value" value={v.kind === "none" ? "—" : money(v.value)} tone={v.tone} />
      <Line testid="four-lowest-line" bad={below}>
        {v.kind === "none" ? v.words : below ? `Below zero${day ? ` · ${day}` : ""}` : day}
      </Line>
    </Tile>
  );
}

function SpentThisWeek({ s }: { s: Spine }) {
  const pos = useMoneyPositionQ();
  // The same cash signal the header already asked for (same key, no new request).
  const cash = useCashSignalQ(90);
  const cap = pos.data?.weekCap ?? null;
  // No plan: the forecast's own weekly amount, read exactly as the week tile's "Forecast assumes" line reads it.
  const weekly = cap == null
    ? (cash.data?.hookReserves ?? []).filter((r) => r.hook === "weekly").sort((a, b) => (a.occurrenceDate < b.occurrenceDate ? -1 : 1))[0]
    : undefined;
  const of = cap != null ? cap : weekly?.basis === "stored_amount" ? (weekly.storedAmount ?? weekly.amount) : null;
  // The plan against what counts toward it: the spine's own remaining figure (negative when over), said by sign.
  const w = weekStory(s.position);
  const known = Number(w.known);
  // No plan set: the same subtraction against the forecast's weekly amount, so an over week still says "over".
  const ofN = of != null ? Number(of) : NaN;
  const rem = w.planSet ? w.remainingKnown : Number.isFinite(ofN) ? Math.round((ofN - known) * 100) / 100 : null;
  return (
    <Tile testid="four-spent" title="Spent this week" href="/spending/week" accent="checking" index={4} box={FOUR_BOX_BAR} body={FOUR_BODY}>
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
    </Tile>
  );
}

function DebtPaid({ s }: { s: Spine }) {
  const pct = s.debt.payoffPct;
  return (
    <Tile testid="four-debt" title="Debt paid" href="/avalanche" accent="other" index={5} box={FOUR_BOX_BAR} body={FOUR_BODY}>
      <Fig big testid="four-debt-value" value={pct == null ? "—" : `${Math.round(pct)}%`} />
      <Bar testid="four-debt-bar" value={pct ?? undefined} ceiling={pct == null ? undefined : 100} />
      <Line testid="four-debt-line">{pct == null ? "No debt has a starting balance yet." : `${short(s.debt.paidDownMtd)} this month`}</Line>
    </Tile>
  );
}

const LOADING = [
  { testid: "four-checking", title: "Checking", href: "/banking", accent: "checking", box: FOUR_BOX },
  { testid: "four-lowest", title: LOWEST, href: "/forecast?horizon=90", accent: "other", box: FOUR_BOX },
  { testid: "four-spent", title: "Spent this week", href: "/spending/week", accent: "checking", box: FOUR_BOX_BAR },
  { testid: "four-debt", title: "Debt paid", href: "/avalanche", accent: "other", box: FOUR_BOX_BAR },
] as const;

export default function FourNumbers() {
  const spine = useSpine();
  const s = spine.data;
  if (!s && spine.state === "failed") {
    return <div className="span-12"><PanelError what="The numbers" onRetry={spine.refetch} /></div>;
  }
  return (
    <div className={FOUR_GRID} data-testid="dash-four">
      {s ? (
        <>
          <Checking s={s} older={spine.olderWords} />
          <Lowest s={s} />
          <SpentThisWeek s={s} />
          <DebtPaid s={s} />
        </>
      ) : (
        LOADING.map((t, i) => (
          <Tile key={t.testid} {...t} index={i + 2} body={FOUR_BODY}><Skel /></Tile>
        ))
      )}
    </div>
  );
}
