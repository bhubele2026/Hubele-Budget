import { useGetAmexSummary, getGetAmexSummaryQueryKey } from "@workspace/api-client-react/features";
import {
  useGetAmexWeeklyPayoff,
  useGetSettings,
  getGetAmexWeeklyPayoffQueryKey,
  getListDebtsQueryKey,
} from "@workspace/api-client-react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RingStat } from "@/components/viz";
import { AddToAvalanche } from "@/components/add-card-to-avalanche";
import {
  BRAND_LABEL,
  brandColor,
  cardBrandOverrides,
  effectiveBrand,
} from "@/lib/amexBrand";
import { cn } from "@/lib/utils";
import { moneyFace } from "@/components/data-state";
import { fieldLabel } from "@/ui";

/** The period the Summary below reads; the band asks the server for the same one. */
export interface BandPeriod {
  from: string;
  to: string;
}

/**
 * Every tile's `owed` and period purchases from ONE call: the `accountId=all`
 * summary (P4). Its `scope.cards[]` carries each card's own owed + purchases
 * (the same rule as that card's own summary, parity-tested on the server), so
 * the band makes no per-card summary calls. Unknown is "—", loading is a pulse.
 */
function useBandFigures(period: BandPeriod | null | undefined) {
  const params = { accountId: "all", from: period?.from ?? "", to: period?.to ?? "" };
  return useGetAmexSummary(params, {
    query: { queryKey: getGetAmexSummaryQueryKey(params), enabled: period != null },
  });
}

type TileFiguresData = { owed: string | null; purchases: string | null };
function figuresOf(
  data: ReturnType<typeof useBandFigures>["data"],
  accountId: string,
): TileFiguresData {
  if (!data) return { owed: null, purchases: null };
  if (accountId === "all") return { owed: data.owed.current, purchases: data.purchases.amount };
  const card = data.scope.cards.find((c) => c.accountId === accountId);
  return { owed: card?.owed ?? null, purchases: card?.purchases?.amount ?? null };
}

function FigureLine({
  label, amount, loading, testId,
}: { label: string; amount: string | null | undefined; loading: boolean; testId: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2" data-testid={testId}>
      <span className="text-micro text-neutral-500">{label}</span>
      {loading ? (
        <span className="h-3 w-14 animate-pulse rounded bg-platinum-2" aria-busy="true" />
      ) : (
        <span className="font-mono text-label font-semibold tabular-nums text-brand-navy">{moneyFace(amount)}</span>
      )}
    </div>
  );
}

/**
 * One tile's figures: the head (its name) and owed on the left, an optional
 * aside (the ring) on the right, and the period's purchases across the foot.
 */
function TileFigures({
  accountId, period, periodLabel, head, aside,
}: {
  accountId: string;
  period?: BandPeriod | null;
  periodLabel?: string;
  head: ReactNode;
  aside?: ReactNode;
}) {
  const q = useBandFigures(period);
  const figures = figuresOf(q.data, accountId);
  const loading = period != null && q.data === undefined && !q.isError;
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {head}
          <div className="mt-2 font-mono text-title font-semibold leading-none tabular-nums text-brand-navy" data-testid={`amex-owed-${accountId}`}>
            {loading ? <span className="inline-block h-5 w-24 animate-pulse rounded bg-platinum-2 align-middle" aria-busy="true" /> : moneyFace(figures.owed)}
          </div>
          <div className="mt-1 text-micro text-neutral-500">Owed</div>
        </div>
        {aside}
      </div>
      <div className="mt-3 border-t border-brand-line pt-2">
        <FigureLine
          testId={`amex-purchases-${accountId}`}
          label={periodLabel ? `Purchases · ${periodLabel}` : "Purchases"}
          amount={figures.purchases}
          loading={loading}
        />
      </div>
    </>
  );
}

/**
 * Per-card band for the Amex page (C10): one PANEL per card on the page grid,
 * plus an "All cards" panel. Each card panel carries the Amex identity edge
 * (the teal-green account accent, CLAUDE.md §3), its name and ••mask, the
 * card's current balance, this week's charges, and a "% cleared" ring; the card's
 * tier colour stays as the small dot beside its name (AX-26). Selecting a
 * panel filters the register below (drill); "All cards" clears the filter.
 *
 * ⚠️ IT RENDERS GRID CELLS, NOT A GRID. The cells sit directly in the page's
 * `PageGrid`, after any `lead` panel the host put first (the account Summary
 * on `/next/accounts/:id`), so `leadCount` tells the band how many cells are
 * already in its row: beside one (a span-4 Summary) the cells are span-4, a
 * row of three; alone, 2 cells → span-6, 4 → span-3, otherwise span-4.
 *
 * Each card also carries an "Add to Avalanche" action (shared component) for
 * cards not yet tracked as debts — e.g. the Sky Card. Adding one links it to a
 * debt, after which amexAnchor drops it from this band. Tier/name editing lives
 * on the Avalanche page (components/avalanche-card-config.tsx); names/tiers set
 * there flow back here for display via settings preferences.
 */
export function AmexCardBand({
  selected,
  onSelect,
  masks,
  leadCount = 0,
  period,
  periodLabel,
}: {
  /** Current cardFilter: "all" or an external Plaid account_id. */
  selected: string;
  onSelect: (accountId: string) => void;
  /** External Plaid account_id → last four digits, from the linked items. */
  masks?: ReadonlyMap<string, string>;
  /** Cells the host already placed in the band's first row. */
  leadCount?: number;
  /** The Summary's period: owed + purchases come from the server for it. */
  period?: BandPeriod | null;
  periodLabel?: string;
}) {
  const { data } = useGetAmexWeeklyPayoff();
  const { data: settings } = useGetSettings();
  const overrides = cardBrandOverrides(settings);
  const names =
    (settings?.preferences?.amexCardNames as Record<string, string>) ?? {};
  const qc = useQueryClient();
  // After a card is added to Avalanche it gains a debtId and the band refetch
  // drops it (amexAnchor filters debt-linked cards).
  const refreshAfterCreate = async () => {
    await qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    await qc.invalidateQueries({ queryKey: getGetAmexWeeklyPayoffQueryKey() });
  };

  const cards = data?.cards ?? [];
  // (W4) A card on the payoff plan (debt-linked) is still a card to review.
  const planCards = data?.debtLinkedCards ?? [];
  if (cards.length === 0 && planCards.length === 0) return null;
  // Beside a lead (a span-4 Summary) every cell is span-4: rows of three.
  // Alone: two cells halve the row, four quarter it, otherwise thirds.
  const total = cards.length + planCards.length + 1;
  const span =
    leadCount > 0 ? "span-4" : total === 2 ? "span-6" : total % 4 === 0 ? "span-3" : "span-4";
  const tile =
    "panel press flex h-full w-full flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40";

  return (
    <>
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={cn(
          tile,
          span,
          "p-4",
          selected === "all"
            ? "ring-2 ring-brand-navy/40"
            : "hover:shadow-lift",
        )}
        data-testid="amex-tile-all"
        aria-pressed={selected === "all"}
      >
        <TileFigures
          accountId="all"
          period={period}
          periodLabel={periodLabel}
          head={<div className={fieldLabel}>All cards</div>}
        />
      </button>

      {cards.map((c) => {
        const tier = effectiveBrand(c.accountId, c.brand, overrides);
        const color = brandColor(tier);
        const active = selected === c.accountId;
        const mask = masks?.get(c.accountId) ?? "";
        return (
          <div
            key={c.accountId}
            className={cn(
              "panel panel-accent-amex flex flex-col",
              span,
              active && "ring-2 ring-brand-navy/40",
            )}
            data-testid={`amex-tile-${tier}`}
            data-account-id={c.accountId}
          >
            <button
              type="button"
              onClick={() => onSelect(c.accountId)}
              className="press w-full flex-1 p-4 text-left hover:bg-platinum-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-navy/40"
              aria-pressed={active}
            >
              <TileFigures
                accountId={c.accountId}
                period={period}
                periodLabel={periodLabel}
                head={
                  <span className={cn(fieldLabel, "flex flex-wrap items-center gap-x-1.5")}>
                    {/* The card's tier colour (identity within Amex); the
                        panel's edge is the account accent. */}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: color }}
                      aria-hidden
                    />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {names[c.accountId] || BRAND_LABEL[tier] || c.name}
                    </span>
                    {mask ? (
                      <span className="shrink-0 font-mono normal-case tracking-normal tabular-nums text-neutral-500">
                        ••{mask}
                      </span>
                    ) : null}
                  </span>
                }
                /* The ring is the WEEKLY PAYOFF PLAN's, not the Summary's:
                   named so, so no two figures share a name. Navy, not the
                   card's identity colour. ⚠️ The caption sits under the ring:
                   at the widest tracking it is wider than a 52px ring. */
                aside={
                  <div className="flex shrink-0 flex-col items-center gap-1">
                    <RingStat
                      value={c.pctOfStatementThisWeek}
                      size={52}
                      stroke={5}
                      color="var(--color-brand-navy)"
                      centerText={`${Math.round((c.pctOfStatementThisWeek ?? 0) * 100)}%`}
                    />
                    <span
                      className="text-micro uppercase tracking-wide text-neutral-500"
                      title="Share of the card's balance charged this week, from the weekly payoff plan"
                    >
                      cleared this wk
                    </span>
                  </div>
                }
              />
            </button>
            <div className="px-4 pb-4">
              <AddToAvalanche card={c} onCreated={refreshAfterCreate} />
            </div>
          </div>
        );
      })}
      {planCards.map((c) => {
        const tier = effectiveBrand(c.accountId, c.brand, overrides);
        const color = brandColor(tier);
        const active = selected === c.accountId;
        const mask = masks?.get(c.accountId) || c.mask || "";
        return (
          <button
            key={c.accountId}
            type="button"
            onClick={() => onSelect(c.accountId)}
            aria-pressed={active}
            className={cn(
              "panel panel-accent-amex press flex h-full w-full flex-col p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40",
              span,
              active && "ring-2 ring-brand-navy/40",
            )}
            data-testid={`amex-tile-plan-${c.accountId}`}
            data-account-id={c.accountId}
          >
            <TileFigures
              accountId={c.accountId}
              period={period}
              periodLabel={periodLabel}
              head={
            <span className={cn(fieldLabel, "flex flex-wrap items-center gap-x-1.5")}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {names[c.accountId] || BRAND_LABEL[tier] || c.name}
              </span>
              {mask ? (
                <span className="shrink-0 font-mono normal-case tracking-normal tabular-nums text-neutral-500">••{mask}</span>
              ) : null}
            </span>
              }
            />
            <span className="mt-2 text-micro text-neutral-500">On the payoff plan</span>
          </button>
        );
      })}
    </>
  );
}
