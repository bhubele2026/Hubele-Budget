import type { ReactNode } from "react";
import type { Spine } from "@workspace/api-client-react";
import { bankBalanceView } from "@/lib/bankBalance";
import { lowPointView } from "@/lib/lowPoint";
import { weekStory } from "@/lib/weekFigures";
import { useSpine } from "@/hooks/useSpine";
import { cn } from "@/lib/utils";
import { useCashSignalQ, useMoneyPositionQ } from "./queries";
import { dayLabel, money, PanelError, weekdayLabel } from "./shared";
import { Fig, FOUR_BOX, FOUR_GRID, Skel, Tile } from "./tileParts";

/**
 * ⭐ THE FOUR NUMBERS (owner, 2026-11-11: the home page was "cluttered, lots of
 * words"). Checking · Lowest · Spent this week · Debt paid: each box is ONE big
 * number and at most one short line, no status chip, and one whole-card link to
 * the page the matching tile under "More" opens. Nothing is worked out here:
 * every figure is a field an existing tile already reads (the spine's, the
 * money position's weekly plan, the cash signal's weekly amount). Unknown and
 * loading draw "—" or a skeleton, never $0.
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

function Checking({ s, older }: { s: Spine; older?: string | null }) {
  const v = bankBalanceView(s.bank);
  const bal = Number(s.bank.balance);
  const n = s.reviewCount;
  // The Banking tile's own link: the account the balance rolls forward on.
  const href = v.account?.rowId ? `/banking?account=${encodeURIComponent(v.account.rowId)}` : "/banking";
  return (
    <Tile testid="four-checking" title="Checking" href={href} accent="checking" index={2} box={FOUR_BOX}>
      <Fig
        big testid="four-checking-value"
        value={v.balance == null ? "—" : money(s.bank.balance)}
        tone={!older && v.balance != null && Number.isFinite(bal) && bal < 0 ? "bad" : "neutral"}
      />
      <Line testid="four-checking-line">{v.balance == null ? "No bank balance yet." : n > 0 ? `${n} to match` : null}</Line>
    </Tile>
  );
}

function Lowest({ s }: { s: Spine }) {
  const f = s.forecast;
  const v = lowPointView(f, { buffer: f.cashBuffer, stale: s.bank.stale });
  const below = v.value != null && v.value < 0;
  const day = v.date ? (weekdayLabel(v.date) ?? dayLabel(v.date)) : null;
  // The Forecast tile's own link: below zero, it opens the day it happens.
  const href = `/forecast?horizon=90${below && v.date ? `&day=${encodeURIComponent(v.date.slice(0, 10))}` : ""}`;
  return (
    <Tile testid="four-lowest" title="Lowest" href={href} accent="other" index={3} box={FOUR_BOX}>
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
  return (
    <Tile testid="four-spent" title="Spent this week" href="/spending/week" accent="checking" index={4} box={FOUR_BOX}>
      <Fig big testid="four-spent-value" value={money(weekStory(s.position).known)} />
      <Line testid="four-spent-line">{of != null ? `of ${short(of)}` : null}</Line>
    </Tile>
  );
}

function DebtPaid({ s }: { s: Spine }) {
  const pct = s.debt.payoffPct;
  return (
    <Tile testid="four-debt" title="Debt paid" href="/avalanche" accent="other" index={5} box={FOUR_BOX}>
      <Fig big testid="four-debt-value" value={pct == null ? "—" : `${Math.round(pct)}%`} />
      <Line testid="four-debt-line">{pct == null ? "No debt has a starting balance yet." : `${short(s.debt.paidDownMtd)} this month`}</Line>
    </Tile>
  );
}

const LOADING = [
  { testid: "four-checking", title: "Checking", href: "/banking", accent: "checking" },
  { testid: "four-lowest", title: "Lowest", href: "/forecast?horizon=90", accent: "other" },
  { testid: "four-spent", title: "Spent this week", href: "/spending/week", accent: "checking" },
  { testid: "four-debt", title: "Debt paid", href: "/avalanche", accent: "other" },
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
          <Tile key={t.testid} {...t} index={i + 2} box={FOUR_BOX}><Skel /></Tile>
        ))
      )}
    </div>
  );
}
