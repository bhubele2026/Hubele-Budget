import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useGetSettings, type Spine } from "@workspace/api-client-react";
import { amexCardLabel } from "@workspace/avalanche-core";
import { FreshnessLine } from "@/components/data-state";
import { isSyntheticPlaidItem } from "@/lib/plaidReauth";
import { cardOrderOf, identityOf } from "@/lib/accountIdentity";
import { bankBalanceView } from "@/lib/bankBalance";
import { cardOwedView, debtForAccount, needsLiability } from "@/lib/cardBalance";
import { lowPointView } from "@/lib/lowPoint";
import { warmHandlers, warmRoute } from "@/lib/warmRoutes";
import { useSpine } from "@/hooks/useSpine";
import { cn } from "@/lib/utils";
import { useDebtsQ, useLiabilityAccountsQ, useMoneyPositionQ, usePlaidItemsQ } from "./queries";
import { dayLabel, money, PanelError, weekdayLabel } from "./shared";
import { Fig, Skel, Tile, Why, leftOver, type TileStatus } from "./tileParts";

/**
 * ⭐ THE SIX TILES: the home base. Each is one whole-card link (a stretched
 * link, so a "Why?" can sit above it), 2 or 3 figures, ONE status chip and an
 * arrow. No money is computed here: every figure is the spine's, the money
 * position's or the debts' own. Unknown and loading draw "—" or a skeleton,
 * never $0; "Plan not set" is never over.
 */

// ── Banking ─────────────────────────────────────────────────────────────────
function BankingTile({ s }: { s: Spine | undefined }) {
  if (!s) return <Tile testid="banking" title="Banking" href="/banking" accent="checking" index={1}><Skel /></Tile>;
  const v = bankBalanceView(s.bank);
  const acct = v.account;
  const identity = acct
    ? identityOf({ id: "cash", name: acct.name, mask: acct.mask, subtype: acct.subtype, type: "depository", institutionName: null })
    : null;
  const bal = Number(s.bank.balance);
  const n = s.reviewCount;
  const href = acct?.rowId ? `/banking?account=${encodeURIComponent(acct.rowId)}` : "/banking";
  return (
    <Tile
      testid="banking" title="Banking" href={href} accent="checking" index={1}
      sub={identity ? <span data-testid="tile-banking-account">{identity.label}{identity.mask4 ? ` ••${identity.mask4}` : ""}</span> : "Checking"}
      status={{ word: n > 0 ? `${n} to review` : "Up to date", tone: n > 0 ? "bad" : "ok" }}
    >
      <Fig
        label="Checking" big testid="tile-banking-balance"
        value={v.balance == null ? "—" : money(s.bank.balance)}
        tone={Number.isFinite(bal) && bal < 0 ? "bad" : "neutral"}
      />
      <div className="text-micro text-neutral-500" data-testid="tile-banking-fresh">
        {v.balance == null ? "No bank balance yet." : <FreshnessLine bank={s.bank} />}
      </div>
    </Tile>
  );
}

// ── Amex ────────────────────────────────────────────────────────────────────
export interface AmexTileProps {
  /** Reserved for W4: this week's card charges. Nothing renders while absent (never $0). */
  weekCharges?: ReactNode;
}

function AmexTile({ weekCharges }: AmexTileProps) {
  const items = usePlaidItemsQ();
  const debts = useDebtsQ();
  const { data: settings } = useGetSettings();
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
      // Amex cards only: other credit cards stay under Banking › Accounts and Debt.
      if (id.kind !== "amex") return [];
      // The Amex page's name for the card (household name, else tier word, else Plaid's).
      const name = amexCardLabel({
        accountId: a.accountId,
        serverBrand: /blue/i.test(`${a.name ?? ""} ${a.mask ?? ""}`) ? "blue" : "silver",
        plaidName: a.name,
        names: settings?.preferences?.amexCardNames as Record<string, string> | undefined,
        brands: settings?.preferences?.amexCardBrands as Record<string, string> | undefined,
      });
      return [{ id: a.id, label: `${name}${id.mask4 ? ` ••${id.mask4}` : ""}` }];
    });
  }, [items.data, settings]);
  // Asked only when a card is off the plan (the Accounts read, same key).
  const needLiab = debts.data !== undefined && cards.some((c) => needsLiability(debtForAccount(debts.data, c)));
  const liab = useLiabilityAccountsQ(needLiab);
  const waiting = items.data === undefined || debts.data === undefined || (needLiab && liab.data === undefined && !liab.isError);
  const failed = (items.data === undefined && items.isError) || (debts.data === undefined && debts.isError);
  return (
    <Tile testid="amex" title="Amex" href="/amex" accent="amex" index={2} sub="Owed on each card">
      {failed ? (
        <PanelError what="The cards" />
      ) : waiting ? (
        <Skel />
      ) : cards.length === 0 ? (
        <p className="text-label text-neutral-500" data-testid="tile-amex-none">No card linked yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="tile-amex-cards">
          {cards.map((c) => {
            const debt = debtForAccount(debts.data, c);
            const la = needsLiability(debt) ? (liab.data ?? []).find((l) => l.id === c.id) : undefined;
            const view = cardOwedView({ debt, liability: la });
            const owed = view.owed ?? view.creditorCurrent?.balance ?? null;
            return (
              <li key={c.id} className="flex items-baseline justify-between gap-3" data-testid="tile-amex-card">
                <span className="min-w-0 text-label text-brand-ink [overflow-wrap:anywhere]">{c.label}</span>
                <span className="font-mono text-body font-semibold tabular-nums text-brand-navy" data-testid="tile-amex-owed">{money(owed)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {weekCharges != null && weekCharges !== false ? <div className="empty:hidden" data-testid="tile-amex-weekcharges">{weekCharges}</div> : null}
    </Tile>
  );
}

// ── This week / This month ─────────────────────────────────────────────────
// (F4) The week tile's headline is the KNOWN figure (period breakdown). That read
// lives in the `features` sub-module, which the landing must not import, so the
// tile that reads it is a lazy chunk; the spine-based tile below shows until it lands.
const WeekKnownTile = lazy(() => import("./WeekKnownTile"));

function WeekTile({ s }: { s: Spine | undefined }) {
  const base = <WeekTileBase s={s} />;
  if (!s) return base;
  return (
    <Suspense fallback={base}>
      <WeekKnownTile s={s} base={base} />
    </Suspense>
  );
}

function WeekTileBase({ s }: { s: Spine | undefined }) {
  const pos = useMoneyPositionQ();
  if (!s) return <Tile testid="week" title="This week" href="/spending/week" accent="checking" index={3}><Skel /></Tile>;
  const rem = s.position.remainingWeek == null ? null : Number(s.position.remainingWeek);
  const planSet = rem != null && Number.isFinite(rem);
  const w = s.position.withinPlan;
  const status: TileStatus = !planSet
    ? { word: "Plan not set", tone: "neutral" }
    : w === "over" || rem < 0 ? { word: "Over", tone: "bad" }
    : w === "tight" ? { word: "Tight", tone: "neutral" }
    : { word: "On plan", tone: "ok" };
  const lo = planSet ? leftOver(rem) : null;
  return (
    <Tile
      testid="week" title="This week" href="/spending/week" accent="checking" index={3} status={status}
      why={<Why>Weekly spending plus purchases not filed yet, refunds taken off.</Why>}
    >
      <Fig
        label="Counts toward plan" big testid="tile-week-spent"
        value={pos.data ? money(pos.data.spentWeekDiscretionary) : pos.isError ? "—" : <Skel />}
      />
      {planSet ? (
        <>
          <Fig label="Plan" value={money(pos.data?.weekCap)} testid="tile-week-plan" />
          <div className={cn("font-mono text-body font-semibold tabular-nums", lo!.over ? "text-bad-ink" : "text-brand-navy")} data-testid="tile-week-left">{lo!.text}</div>
        </>
      ) : null /* the chip already says "Plan not set" */}
    </Tile>
  );
}

function MonthTile({ s }: { s: Spine | undefined }) {
  if (!s) return <Tile testid="month" title="Monthly allowance" href="/spending/month" accent="checking" index={4}><Skel /></Tile>;
  const m = s.monthAllowance;
  const planSet = m.plan != null;
  // The server's verdict (status) picks the word; (S6) the line is the server's
  // own `remaining`, said by sign exactly as the week tile says its own — no
  // money is computed here (`over` is −remaining when over, by construction).
  const lo = planSet && m.remaining != null ? leftOver(Number(m.remaining)) : null;
  const status: TileStatus = !planSet
    ? { word: "Plan not set", tone: "neutral" }
    : m.status === "over" ? { word: "Over", tone: "bad" } : { word: "Within", tone: "ok" };
  return (
    <Tile testid="month" title="Monthly allowance" href="/spending/month" accent="checking" index={4} status={status}>
      <Fig label="Spent" big testid="tile-month-spent" value={money(m.actual)} />
      {planSet ? (
        <>
          <Fig label="Plan" value={money(m.plan)} testid="tile-month-plan" />
          <div className={cn("font-mono text-body font-semibold tabular-nums", lo!.over ? "text-bad-ink" : "text-brand-navy")} data-testid="tile-month-left">{lo!.text}</div>
        </>
      ) : (
        <p className="text-label text-neutral-600" data-testid="tile-month-noplan">Plan not set</p>
      )}
    </Tile>
  );
}

// ── Forecast ────────────────────────────────────────────────────────────────
function ForecastTile({ s }: { s: Spine | undefined }) {
  if (!s) return <Tile testid="forecast" title="Forecast" href="/forecast" accent="other" index={5}><Skel /></Tile>;
  const f = s.forecast;
  const v = lowPointView(f, { buffer: f.cashBuffer, stale: s.bank.stale });
  const status: TileStatus | null = v.kind === "none" ? null
    : v.value != null && v.value < 0 ? { word: "Below zero", tone: "bad" }
    : v.kind === "below" ? { word: "Below buffer", tone: "bad" }
    : { word: "Above buffer", tone: "ok" };
  const nb = s.nextBill;
  return (
    <Tile testid="forecast" title="Forecast" href="/forecast" accent="other" index={5} status={status}>
      <Fig
        label={`Lowest point${v.date ? ` · ${weekdayLabel(v.date) ?? dayLabel(v.date)}` : ""}`} big testid="tile-forecast-low"
        value={v.kind === "none" ? "—" : money(v.value)} tone={v.tone}
      />
      {nb ? (
        <div className="flex items-baseline justify-between gap-3" data-testid="tile-forecast-next">
          <span className="min-w-0 text-label text-brand-ink [overflow-wrap:anywhere]">Next: {nb.name}</span>
          <span className="font-mono text-body font-semibold tabular-nums text-brand-navy">{money(nb.amount)}</span>
        </div>
      ) : v.kind === "none" ? (
        <p className="text-label text-neutral-600">{v.words}</p>
      ) : null}
    </Tile>
  );
}

// ── Debt ────────────────────────────────────────────────────────────────────
function DebtTile({ s }: { s: Spine | undefined }) {
  if (!s) return <Tile testid="debt" title="Debt" href="/avalanche" accent="other" index={6}><Skel /></Tile>;
  const pct = s.debt.payoffPct;
  return (
    <Tile testid="debt" title="Debt" href="/avalanche" accent="other" index={6}>
      <Fig label="Paid off" big testid="tile-debt-pct" value={pct == null ? "—" : `${Math.round(pct)}%`} />
      {pct == null ? (
        <p className="text-label text-neutral-600">No debt has a starting balance yet.</p>
      ) : (
        <Fig label="Paid down this month" value={money(s.debt.paidDownMtd)} testid="tile-debt-mtd" />
      )}
    </Tile>
  );
}

export default function Tiles(props: AmexTileProps = {}) {
  const spine = useSpine();
  const s = spine.data;
  if (!s && spine.state === "failed") {
    return <div className="span-12"><PanelError what="The tiles" onRetry={spine.refetch} /></div>;
  }
  return (
    <>
      <BankingTile s={s} />
      <AmexTile {...props} />
      <WeekTile s={s} />
      <MonthTile s={s} />
      <ForecastTile s={s} />
      <DebtTile s={s} />
    </>
  );
}
