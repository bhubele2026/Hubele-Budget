import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAmexWeeklyPayoff,
  useGetSettings,
  useUpdateSettings,
  useListTransactions,
  useUpdateTransaction,
  getListTransactionsQueryKey,
  getGetSettingsQueryKey,
  getGetAmexWeeklyPayoffQueryKey,
  type GetAmexWeeklyPayoffParams,
  type AmexWeeklyPayoffCard,
  type Transaction,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { RingStat, MoneyText } from "@/components/viz";
import { StatusPill, WhyExpander } from "@/components/stat";
import { RowDateControls } from "@/components/row-date-controls";
import { useToast } from "@/hooks/use-toast";
import {
  BRAND_LABEL,
  brandColor,
  cardBrandOverrides,
  effectiveBrand,
  type AmexTier,
} from "@/lib/amexBrand";
import { cn } from "@/lib/utils";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Shift a YYYY-MM-DD by N days (calendar-safe). */
function shiftISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoOf(new Date(y, m - 1, d + days));
}
/** Sunday of the last fully-completed Sun–Sat week — the newest selectable. */
function lastCompletedSunday(): string {
  const t = new Date();
  const sun = new Date(t.getFullYear(), t.getMonth(), t.getDate() - t.getDay());
  return isoOf(new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() - 7));
}
function fmtTxnDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}
/** First + last day of the calendar month containing a YYYY-MM-DD. */
function monthBoundsOf(iso: string): { start: string; end: string } {
  const [y, m] = iso.split("-").map(Number);
  return { start: `${y}-${pad(m)}-01`, end: isoOf(new Date(y, m, 0)) };
}

function fmtWeekRange(start: string, end: string): string {
  const f = (iso: string) => {
    const [, m, d] = iso.split("-");
    return `${Number(m)}/${Number(d)}`;
  };
  return `${f(start)} – ${f(end)}`;
}

function KillRow({
  card,
  tier,
  txns,
  periodStart,
  periodEnd,
  onMove,
  excludedIds,
  onToggleExclude,
}: {
  card: AmexWeeklyPayoffCard;
  tier: AmexTier;
  txns: Transaction[];
  periodStart: string;
  periodEnd: string;
  onMove: (t: Transaction, nextISO: string) => Promise<boolean>;
  excludedIds: Set<string>;
  onToggleExclude: (id: string, next: boolean) => void;
}) {
  const color = brandColor(tier);
  const hasCharges = card.weekCharges > 0;
  const pctCleared = Math.round((card.pctOfStatementThisWeek || 0) * 100);
  const label = card.displayName || BRAND_LABEL[tier] || card.name;
  // This card's charges inside its billing window (week or month), biggest first.
  const charges = [...txns]
    .filter(
      (t) =>
        (Number(t.amount) || 0) < 0 &&
        t.occurredOn >= periodStart &&
        t.occurredOn <= periodEnd,
    )
    .sort((a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0));
  return (
    <div
      className="rounded-lg border border-card-border bg-card"
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
      data-testid={`killstack-row-${tier}`}
    >
      <Link
        href={`/amex?accountId=${encodeURIComponent(card.accountId)}`}
        className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/40 rounded-t-lg"
      >
        <RingStat
          value={card.pctOfStatementThisWeek}
          size={52}
          stroke={5}
          color={color}
          centerSub="cleared"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="text-sm font-semibold">{label}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {card.chargeCount > 0
              ? `${card.chargeCount} charge${card.chargeCount === 1 ? "" : "s"}${
                  card.topMerchant ? ` · top: ${card.topMerchant.name}` : ""
                }`
              : "Nothing charged this week"}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="mb-1 flex justify-end">
            <StatusPill status={hasCharges ? "warning" : "good"}>
              {hasCharges ? "To pay" : "Clear"}
            </StatusPill>
          </div>
          <MoneyText amount={card.weekCharges} className="text-xl font-bold" />
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {card.periodLabel}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </Link>
      <div className="px-4 pb-3">
        <WhyExpander label={hasCharges ? `Transactions (${card.chargeCount})` : "Why"}>
          <p className="leading-snug">
            {hasCharges ? (
              <>
                <span className="font-medium text-foreground">
                  <MoneyText amount={card.weekCharges} />
                </span>{" "}
                across {card.chargeCount} charge{card.chargeCount === 1 ? "" : "s"} —{" "}
                {pctCleared}% of the {<MoneyText amount={card.statementBalance} />} statement.
              </>
            ) : (
              "Nothing charged on this card this week. Tidy."
            )}
          </p>
          {charges.length > 0 && (
            <ul className="mt-2 divide-y divide-border/60">
              {charges.map((t) => {
                const excluded = excludedIds.has(t.id);
                return (
                  <li
                    key={t.id}
                    className={cn(
                      "flex items-center justify-between gap-2 py-1.5",
                      excluded && "opacity-50",
                    )}
                  >
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-foreground",
                        excluded && "line-through",
                      )}
                    >
                      <span className="text-muted-foreground tabular-nums mr-2">
                        {fmtTxnDate(t.occurredOn)}
                      </span>
                      {t.description || "Charge"}
                    </span>
                    <MoneyText
                      amount={t.amount}
                      abs
                      className={cn(
                        "font-medium tabular-nums shrink-0",
                        excluded && "line-through",
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => onToggleExclude(t.id, !excluded)}
                      title={
                        excluded
                          ? "Add this charge back to the payoff"
                          : "Reimbursement / not paid with our funds — remove from this card's payoff"
                      }
                      data-testid={`killstack-exclude-${t.id}`}
                      className={cn(
                        "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
                        excluded
                          ? "border-primary/40 text-primary hover:bg-primary/10"
                          : "border-card-border text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {excluded ? "Add back" : "Not mine"}
                    </button>
                    <RowDateControls tx={t} onMove={(next) => onMove(t, next)} />
                  </li>
                );
              })}
            </ul>
          )}
          <Link
            href={`/amex?accountId=${encodeURIComponent(card.accountId)}`}
            className="mt-2 inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
          >
            Open this card <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </WhyExpander>
      </div>
    </div>
  );
}

/**
 * The signature element — a per-card weekly payoff stack that reads like a
 * bank statement crossed with a leaderboard. Blue / Silver / Gold cards
 * stacked, each showing this-week's charges to pay, a per-card ring for "% of
 * statement cleared", a combined total, and a one-line sassy directive.
 *
 * Consumes GET /amex/weekly-payoff. Reused on Home and as the spine of the
 * Allowance page (pass `weekStart`).
 */
export function KillStack({
  weekStart: initialWeekStart,
  emphasize = true,
  className,
}: {
  /** Sunday of the target week; omit for the last completed week. */
  weekStart?: string;
  /** Apply the violet focus-glow ring (Home hero treatment). */
  emphasize?: boolean;
  className?: string;
}) {
  // Selected week (Sunday). undefined = let the server pick the last completed
  // week; the prev/next controls then pin an explicit week.
  const [weekStart, setWeekStart] = useState<string | undefined>(initialWeekStart);
  const params: GetAmexWeeklyPayoffParams | undefined = weekStart
    ? { weekStart }
    : undefined;
  const { data, isLoading } = useGetAmexWeeklyPayoff(params);

  // The week's Amex transactions, fetched once and split per card for the
  // "Transactions" expanders. Read-only; no money recomputed.
  // Fetch over the month containing the week so both weekly cards (week
  // window) and monthly cards (month window) have their charges available.
  const month = data?.weekStart ? monthBoundsOf(data.weekStart) : null;
  const txnFrom = month && month.start < (data?.weekStart ?? "") ? month.start : data?.weekStart ?? "";
  const txnTo = month && month.end > (data?.weekEnd ?? "") ? month.end : data?.weekEnd ?? "";
  const txnParams = { from: txnFrom, to: txnTo, limit: 500 };
  const { data: weekTxns } = useListTransactions(txnParams, {
    query: {
      enabled: Boolean(data?.weekStart),
      queryKey: getListTransactionsQueryKey(txnParams),
    },
  });
  // User-assigned card tiers (override Plaid's regex-guessed brand for label +
  // color). Display metadata only.
  const { data: settings } = useGetSettings();
  const brandOverrides = cardBrandOverrides(settings);
  const updateSettings = useUpdateSettings();
  const txnsByCard = useMemo(() => {
    const m = new Map<string, Transaction[]>();
    for (const t of weekTxns ?? []) {
      if (!t.plaidAccountId) continue;
      const arr = m.get(t.plaidAccountId) ?? [];
      arr.push(t);
      m.set(t.plaidAccountId, arr);
    }
    return m;
  }, [weekTxns]);

  // Move a charge to a different day — same mechanism as the Amex page. The
  // weekly payoff buckets on `occurredOn`, so pulling a "paid Saturday, posted
  // Sunday" charge back a day re-files it into the right Sun–Sat week. The
  // server flips occurredOnUserOverridden so Plaid won't restamp it.
  const updateTx = useUpdateTransaction();
  const qc = useQueryClient();
  const { toast } = useToast();
  const moveTxn = async (t: Transaction, nextISO: string): Promise<boolean> => {
    const next = (nextISO ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return false;
    if (next === t.occurredOn.slice(0, 10)) return true;
    try {
      await updateTx.mutateAsync({ id: t.id, data: { occurredOn: next } });
      await qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      await qc.invalidateQueries({ queryKey: getGetAmexWeeklyPayoffQueryKey() });
      toast({ title: "Date updated" });
      return true;
    } catch (e) {
      toast({
        title: "Couldn't update date",
        description: (e as Error).message,
        variant: "destructive",
      });
      return false;
    }
  };

  const TIER_ORDER: Record<AmexTier, number> = { blue: 0, silver: 1, gold: 2 };
  const allCards = [...(data?.cards ?? [])].sort(
    (a, b) =>
      TIER_ORDER[effectiveBrand(a.accountId, a.brand, brandOverrides)] -
      TIER_ORDER[effectiveBrand(b.accountId, b.brand, brandOverrides)],
  );

  // First-run default: with three cards, the MIDDLE one is the monthly "Sky
  // Card" (top + bottom stay weekly). Seed it once into settings so the backend
  // windows its charges over the month and it renders in the monthly box below.
  // Pinned by accountId, so it sticks even if the stack re-sorts. Only fires
  // when cadence has never been configured — never fights a later manual change.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!settings) return;
    const prefs = settings.preferences ?? {};
    if (prefs.amexCardCadence !== undefined) return; // already configured
    if (allCards.length < 3) return;
    const middle = allCards[1];
    if (!middle) return;
    seededRef.current = true;
    const prevNames = (prefs.amexCardNames as Record<string, string>) ?? {};
    void (async () => {
      await updateSettings.mutateAsync({
        data: {
          preferences: {
            ...prefs,
            amexCardCadence: { [middle.accountId]: "monthly" },
            amexCardNames: { ...prevNames, [middle.accountId]: prevNames[middle.accountId] || "Sky Card" },
          },
        },
      });
      await qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      await qc.invalidateQueries({ queryKey: getGetAmexWeeklyPayoffQueryKey() });
    })();
  }, [settings, allCards, updateSettings, qc]);

  // Charges the user flagged "not mine" (reimbursements). Stored in settings;
  // the backend payoff sum skips them, so toggling here re-drops the card total.
  const excludedIds = useMemo(
    () => new Set((settings?.preferences?.amexExcludedTxnIds as string[]) ?? []),
    [settings],
  );
  const toggleExclude = (id: string, next: boolean) => {
    const prefs = settings?.preferences ?? {};
    const cur = new Set((prefs.amexExcludedTxnIds as string[]) ?? []);
    if (next) cur.add(id);
    else cur.delete(id);
    void (async () => {
      await updateSettings.mutateAsync({
        data: { preferences: { ...prefs, amexExcludedTxnIds: [...cur] } },
      });
      await qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      await qc.invalidateQueries({ queryKey: getGetAmexWeeklyPayoffQueryKey() });
    })();
  };

  // Weekly cards live in the box; monthly cards sit separately beneath it.
  const cards = allCards.filter((c) => c.cadence !== "monthly");
  const monthlyCards = allCards.filter((c) => c.cadence === "monthly");
  const hasCards = cards.length > 0;
  // A card's billing window — weekly cards use the selected week, monthly cards
  // the calendar month — for filtering its transaction list.
  const periodFor = (card: AmexWeeklyPayoffCard) =>
    card.cadence === "monthly" && month
      ? month
      : { start: data?.weekStart ?? "", end: data?.weekEnd ?? "" };

  // Week navigation bounds: can't go past the last completed week.
  const latest = lastCompletedSunday();
  const curWeek = data?.weekStart ?? weekStart ?? latest;
  const atLatest = curWeek >= latest;

  return (
    <div className="space-y-4">
    <Card
      className={cn(emphasize && "focus-glow", className)}
      data-testid="kill-stack"
    >
      <CardContent className="p-5 space-y-4">
        {/* Header: eyebrow + week nav + combined total */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              Kill Stack · pay this for the week
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setWeekStart(shiftISO(curWeek, -7))}
                className="rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Previous week"
                data-testid="killstack-prev-week"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs tabular-nums text-muted-foreground min-w-[5.5rem] text-center">
                {data ? fmtWeekRange(data.weekStart, data.weekEnd) : "—"}
              </span>
              <button
                type="button"
                onClick={() => !atLatest && setWeekStart(shiftISO(curWeek, 7))}
                disabled={atLatest}
                className="rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                aria-label="Next week"
                data-testid="killstack-next-week"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="text-right">
            <MoneyText
              amount={data?.combinedWeekCharges ?? 0}
              className="text-2xl font-bold leading-none"
            />
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
              combined
            </div>
          </div>
        </div>

        {/* Coach directive */}
        {data?.directive && (
          <p className="text-sm font-medium leading-snug text-foreground">
            {data.directive}
          </p>
        )}

        {/* The stack */}
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Tallying the week…
          </div>
        ) : hasCards ? (
          <div className="space-y-2">
            {cards.map((c) => {
              const p = periodFor(c);
              return (
                <KillRow
                  key={c.accountId}
                  card={c}
                  tier={effectiveBrand(c.accountId, c.brand, brandOverrides)}
                  txns={txnsByCard.get(c.accountId) ?? []}
                  periodStart={p.start}
                  periodEnd={p.end}
                  onMove={moveTxn}
                  excludedIds={excludedIds}
                  onToggleExclude={toggleExclude}
                />
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-card-border px-4 py-6 text-sm text-muted-foreground">
            No Amex cards linked yet — link American Express to see exactly what
            to pay each week.{" "}
            <Link href="/amex" className="text-primary hover:underline">
              Link Amex
            </Link>
          </div>
        )}
      </CardContent>
    </Card>

    {monthlyCards.length > 0 && (
      <Card data-testid="kill-stack-monthly">
        <CardContent className="p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                Monthly cards · pay at month-end
              </div>
              {month && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {fmtTxnDate(month.start)} – {fmtTxnDate(month.end)}
                </div>
              )}
            </div>
            <div className="text-right">
              <MoneyText
                amount={monthlyCards.reduce((s, c) => s + c.weekCharges, 0)}
                className="text-2xl font-bold leading-none"
              />
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
                this month
              </div>
            </div>
          </div>
          <div className="space-y-2">
            {monthlyCards.map((c) => {
              const p = periodFor(c);
              return (
                <KillRow
                  key={c.accountId}
                  card={c}
                  tier={effectiveBrand(c.accountId, c.brand, brandOverrides)}
                  txns={txnsByCard.get(c.accountId) ?? []}
                  periodStart={p.start}
                  periodEnd={p.end}
                  onMove={moveTxn}
                  excludedIds={excludedIds}
                  onToggleExclude={toggleExclude}
                />
              );
            })}
          </div>
        </CardContent>
      </Card>
    )}
    </div>
  );
}
