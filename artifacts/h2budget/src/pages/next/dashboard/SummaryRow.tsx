import type { ReactNode } from "react";
import type { Spine } from "@workspace/api-client-react";
import { AccountChip } from "@/components/next";
import { BankBalanceWhy } from "@/components/bank-balance-why";
import { FreshnessLine } from "@/components/data-state";
import { identityOf } from "@/lib/accountIdentity";
import { remainingDebtScope } from "@/lib/debtBalance";
import { lowPointView } from "@/lib/lowPoint";
import { useSpine } from "@/hooks/useSpine";
import { householdDayOfAt, householdToday } from "@/lib/householdDay";
import { cn } from "@/lib/utils";
import { useBankExplainQ, useCashSignalQ, useDebtsQ, useMoneyPositionQ } from "./queries";
import { dayLabel, Kpi, money, PanelError, rise, weekdayLabel } from "./shared";

/** "$500" for a round amount, "$512.40" otherwise (the buffer is usually round). */
function wholeMoney(v: string | number | null | undefined): string {
  return money(v).replace(/\.00$/, "");
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The words for each money-position figure, ONE phrase per figure everywhere on
 * the dashboard (the old "Room in the plan" named `safeToSpendNow` on the cash
 * panel and `availableUntilPayday` in the morning text):
 *   - `safeToSpendNow`       → "Room to spend"
 *   - `remainingWeek`        → "This week's plan … left / over"
 *   - `availableUntilPayday` → "Checking covers … until <payday> after the buffer"
 */
export function roomLines(p: Spine["position"], buffer: string, reservesHeld?: string | null): { week: string; cover: string | null } {
  const rem = p.remainingWeek == null ? null : Number(p.remainingWeek);
  const week =
    rem == null || !Number.isFinite(rem)
      ? "No weekly plan set"
      : rem < 0
        ? `This week's plan ${money(-rem)} over`
        : `This week's plan ${money(rem)} left`;
  if (p.availableUntilPayday == null) return { week, cover: null };
  const until = p.horizonKind === "payday" && p.paydayDate ? `until ${weekdayLabel(p.paydayDate)}` : "until the week ends";
  const held = reservesHeld != null && Number(reservesHeld) > 0 ? ` and ${money(reservesHeld)} held for goals` : "";
  return { week, cover: `Checking covers ${money(p.availableUntilPayday)} ${until}, after the ${wholeMoney(buffer)} buffer${held}` };
}

function CheckingCell({ s }: { s: Spine }) {
  const cash = useCashSignalQ(90);
  const acct = cash.data?.account;
  const identity = acct && acct.via !== "unresolved"
    ? identityOf({ id: "cash", name: acct.name, mask: acct.mask, subtype: acct.subtype, type: "depository", institutionName: null })
    : null;
  const noBank = !s.bank.source && !s.bank.asOfDate;
  const bal = Number(s.bank.balance);
  // The figure is the snapshot rolled forward through the ledger (bank rows AND
  // manual entries on the account, by design — PR #22). When the snapshot is
  // from an earlier day, say how many rows it adds, from the diagnostic
  // "Why this number?" reads (asked only then).
  const snapDay = s.bank.asOfDate ? householdDayOfAt(s.bank.asOfDate) : null;
  const rolled = !!snapDay && snapDay < householdToday(new Date());
  const explain = useBankExplainQ(rolled);
  const since = rolled ? explain.data?.ledger.sinceAnchor ?? null : null;
  return (
    // `relative`: "Why this number?" pins itself to the corner of its box.
    <div className="relative">
    <Kpi
      testid="dash-kpi-checking"
      label="Checking cash"
      value={money(s.bank.balance)}
      tone={Number.isFinite(bal) && bal < 0 ? "bad" : "neutral"}
      missing={noBank ? "No bank balance yet. Link checking in Settings." : undefined}
      lines={noBank ? [] : [
        identity ? <AccountChip identity={identity} size="sm" wrap /> : <span>Checking</span>,
        <span className="inline-flex flex-wrap items-center gap-x-2 text-micro text-neutral-500" data-testid="dash-freshness">
          <FreshnessLine bank={s.bank} />
          {since && since.rowCount > 0 ? (
            <span data-testid="dash-since-snapshot">
              · includes {since.rowCount} {since.rowCount === 1 ? "entry" : "entries"} since the {dayLabel(snapDay)} snapshot
            </span>
          ) : null}
          <BankBalanceWhy />
        </span>,
      ]}
    />
    </div>
  );
}

function RoomCell({ s }: { s: Spine }) {
  const pos = useMoneyPositionQ();
  const p = s.position;
  const { week, cover } = roomLines(p, s.forecast.cashBuffer, pos.data?.reservesHeld);
  const missing = p.safeToSpendNow == null
    ? s.forecast.status === "no_data" ? "Needs a bank balance first." : "Not known yet."
    : undefined;
  return (
    <Kpi
      testid="dash-kpi-room"
      label="Room to spend"
      value={money(p.safeToSpendNow)}
      tone={p.withinPlan === "over" ? "bad" : "neutral"}
      missing={missing}
      lines={[
        <span data-testid="dash-room-week" className={cn(p.withinPlan === "over" && "font-semibold text-bad")}>{week}</span>,
        cover ? <span data-testid="dash-room-cover">{cover}</span> : null,
      ]}
    />
  );
}

function LowCell({ s }: { s: Spine }) {
  const f = s.forecast;
  const v = lowPointView(f, { buffer: f.cashBuffer, stale: s.bank.stale });
  const when = v.date ? `${weekdayLabel(v.date) ?? dayLabel(v.date)} · next 90 days` : "next 90 days";
  // How far under the buffer, as the cash panel said it (dash-accuracy).
  const buf = Number(f.cashBuffer);
  const short = v.value != null && Number.isFinite(buf) && v.value < buf ? buf - v.value : null;
  return (
    <Kpi
      testid="dash-kpi-low"
      label="Projected low point"
      value={money(v.value)}
      tone={v.tone}
      missing={v.kind === "none" ? v.words : undefined}
      lines={v.kind === "none" ? [] : [
        <span data-testid="dash-low-when">{when}</span>,
        <span className={cn(v.kind === "below" && "font-semibold text-bad")}>
          <span data-testid="dash-low-words">{v.words}</span>
          {short != null ? <span data-testid="dash-under-buffer"> · short by {money(short)}</span> : null}
          {f.runwayDays != null ? <span data-testid="dash-runway"> · below zero in {f.runwayDays} days</span> : null}
        </span>,
      ]}
    />
  );
}

function DebtCell({ s }: { s: Spine }) {
  const debts = useDebtsQ();
  const pct = s.debt.payoffPct;
  let left: ReactNode;
  if (debts.data === undefined) {
    left = debts.isError
      ? <span data-testid="dash-debt-left">The amount left did not load.</span>
      : <span className="skeleton inline-block h-3 w-40 rounded" aria-busy="true" />;
  } else {
    const scope = remainingDebtScope(debts.data);
    left = scope.names.length === 0
      ? <span data-testid="dash-debt-left">No balance left on any active debt.</span>
      : <span data-testid="dash-debt-left"><span className="font-mono tabular-nums text-brand-ink">{money(scope.total)}</span> left across {joinNames(scope.names)}</span>;
  }
  return (
    <Kpi
      testid="dash-kpi-debt"
      label="Debt paid off"
      value={pct == null ? "—" : `${Math.round(pct)}%`}
      missing={pct == null ? "No debt has a starting balance yet." : undefined}
      lines={[left]}
    />
  );
}

/**
 * ⭐ THE SUMMARY ROW: the four answers, in the owner's order: what cash do we
 * have, what can we spend before payday, will we run short (and when), are we
 * making progress on debt. ONE surface split by hairlines (`.kpi-grid`), four
 * across on a desktop and two by two on a phone. Every figure is status-aware:
 * missing data is said in words and drawn as an em dash, never $0; a stale
 * bank balance keeps its figure and says how old it is.
 */
export default function SummaryRow() {
  const spine = useSpine();
  const s = spine.data;
  return (
    <section className={cn("panel span-12", rise(1))} data-testid="dash-summary" aria-label="Summary">
      {s ? (
        <div className="kpi-grid">
          <CheckingCell s={s} />
          <RoomCell s={s} />
          <LowCell s={s} />
          <DebtCell s={s} />
        </div>
      ) : spine.state === "failed" ? (
        <div className="p-4"><PanelError what="The summary" onRetry={spine.refetch} /></div>
      ) : (
        <div className="kpi-grid" aria-busy="true" data-testid="dash-summary-loading">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <div className="skeleton h-3 w-24 rounded" />
              <div className="skeleton mt-2 h-7 w-32 rounded" />
              <div className="skeleton mt-2 h-3 w-40 max-w-full rounded" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
