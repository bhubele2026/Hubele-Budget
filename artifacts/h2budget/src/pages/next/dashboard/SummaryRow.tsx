import { useMemo, type ReactNode } from "react";
import { Link } from "wouter";
import type { Spine } from "@workspace/api-client-react";
import { AccountChip } from "@/components/next";
import { BankBalanceWhy } from "@/components/bank-balance-why";
import { FreshnessLine } from "@/components/data-state";
import { isSyntheticPlaidItem } from "@/components/plaid-reconnect-button";
import { cardOrderOf, identityOf } from "@/lib/accountIdentity";
import { bankBalanceView, sinceSnapshotWords } from "@/lib/bankBalance";
import { debtForAccount, needsLiability } from "@/lib/cardBalance";
import { joinNames, offPlanCards, offPlanWords, remainingDebtScope } from "@/lib/debtBalance";
import { lowPointView } from "@/lib/lowPoint";
import { useSpine } from "@/hooks/useSpine";
import { cn } from "@/lib/utils";
import { useAmexQ, useDebtsQ, useLiabilityAccountsQ, useMoneyPositionQ, usePlaidItemsQ } from "./queries";
import { dayLabel, Kpi, LINK, money, PanelError, rise, weekdayLabel } from "./shared";

/** "$500" for a round amount, "$512.40" otherwise (the buffer is usually round). */
function wholeMoney(v: string | number | null | undefined): string {
  return money(v).replace(/\.00$/, "");
}

// (WP4) Moved to `lib/debtBalance.ts` beside the scope it names; re-exported.
export { joinNames };

/**
 * The words for each money-position figure, ONE phrase per figure everywhere the
 * household reads it (the old "Room in the plan" named `safeToSpendNow` on the
 * cash panel and `availableUntilPayday` in the morning text; the morning text
 * now says "Checking covers $X until <weekday>" too — recap/template.ts,
 * prompt recap.v3):
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
  // (WP1) The checking balance's one model, from the spine itself: the figure
  // (the snapshot rolled forward through the ledger — bank rows AND manual
  // entries on the account, by design, PR #22), whose account it is, and how
  // many entries rolled on top of the snapshot. No second request: the label
  // used to wait on the cash signal and the count on the "Why this number?"
  // diagnostic.
  const v = bankBalanceView(s.bank);
  const acct = v.account;
  const identity = acct
    ? identityOf({ id: "cash", name: acct.name, mask: acct.mask, subtype: acct.subtype, type: "depository", institutionName: null })
    : null;
  const noBank = v.balance == null;
  const bal = Number(s.bank.balance);
  const since = sinceSnapshotWords(v);
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
          {since ? <span data-testid="dash-since-snapshot" className="block w-full">{since}</span> : null}
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
        <span data-testid="dash-room-week" className={cn(p.withinPlan === "over" && "font-semibold text-bad-ink")}>{week}</span>,
        cover ? (
          <span data-testid="dash-room-cover" className={cn(Number(p.availableUntilPayday) <= 0 && "font-semibold text-bad-ink")}>{cover}</span>
        ) : null,
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
        <span className={cn(v.kind === "below" && "font-semibold text-bad-ink")}>
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
  const items = usePlaidItemsQ();
  const pct = s.debt.payoffPct;
  // (WP4) The linked cards, named as the Accounts panel names them, so the
  // tile can say which cards its "$X left" does not cover.
  const cards = useMemo(() => {
    const flat = (items.data ?? []).filter((it) => !isSyntheticPlaidItem(it)).flatMap((it) =>
      it.accounts.map((a) => ({
        id: a.id, accountId: a.accountId, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
        institutionName: it.institutionName, institutionSlug: it.institutionSlug,
      })),
    );
    const cardOrder = cardOrderOf(flat);
    return flat.flatMap((a) => {
      const id = identityOf(a, { cardOrder });
      return id.isCard ? [{ id: a.id, accountId: a.accountId, name: `${id.label}${id.mask4 ? ` ••${id.mask4}` : ""}` }] : [];
    });
  }, [items.data]);
  // Asked only when a card is off the plan: Plaid's stored figures (the
  // Accounts panel's own read, same key) and the weekly payoff's billing word.
  const anyOff = debts.data !== undefined && cards.some((c) => needsLiability(debtForAccount(debts.data, c)));
  const liab = useLiabilityAccountsQ(anyOff);
  const amex = useAmexQ(anyOff);
  let left: ReactNode;
  if (debts.data === undefined) {
    left = debts.isError
      ? <span data-testid="dash-debt-left">The amount left did not load.</span>
      : <span className="skeleton inline-block h-3 w-40 rounded" aria-busy="true" />;
  } else {
    const scope = remainingDebtScope(debts.data);
    left = scope.names.length === 0
      ? <span data-testid="dash-debt-left">No balance left on any active debt.</span>
      : (
        <span data-testid="dash-debt-left">
          <span className="font-mono tabular-nums text-brand-ink">{money(scope.total)}</span>
          {` left on your payoff plan (${joinNames(scope.names)})`}
        </span>
      );
  }
  // Said once both reads have answered (or failed): never a sentence that
  // gains its "paid in full weekly" a moment later.
  const off = anyOff && (liab.data !== undefined || liab.isError) && (amex.data !== undefined || amex.isError)
    ? offPlanWords(offPlanCards(cards, debts.data, {
        liabilities: liab.data,
        weeklyAccountIds: new Set((amex.data?.cards ?? []).filter((c) => c.cadence === "weekly").map((c) => c.accountId)),
      }))
    : null;
  const offLine = off ? (
    <span data-testid="dash-debt-offplan">
      {off.text} · <Link href="/avalanche" className={LINK} data-testid="dash-debt-offplan-link">{off.link}</Link>
    </span>
  ) : null;
  const noDebts = debts.data !== undefined && !debts.data.some((d) => d.status === "active");
  return (
    <Kpi
      testid="dash-kpi-debt"
      label="Debt paid off"
      value={pct == null ? "—" : `${Math.round(pct)}%`}
      missing={noDebts ? "No debts on the payoff plan yet." : pct == null ? "No debt has a starting balance yet." : undefined}
      lines={noDebts ? [offLine] : [left, offLine]}
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
