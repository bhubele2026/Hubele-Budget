import { useGetAmexSummary, getGetAmexSummaryQueryKey } from "@workspace/api-client-react/features";
import {
  useGetAmexWeeklyPayoff,
  useGetSettings,
  getGetAmexWeeklyPayoffQueryKey,
  getListDebtsQueryKey,
} from "@workspace/api-client-react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AddToAvalanche } from "@/components/add-card-to-avalanche";
import {
  BRAND_LABEL,
  brandColor,
  cardBrandOverrides,
  effectiveBrand,
} from "@/lib/amexBrand";
import { cn } from "@/lib/utils";
import { scoped, amexSummaryMatches } from "@/lib/queryState";
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
  const q = useGetAmexSummary(params, {
    query: { queryKey: getGetAmexSummaryQueryKey(params), enabled: period != null },
  });
  // (Q4) Another period's answer (kept while this one loads) is not this
  // period's purchases: it would sit under this period's label.
  const own = scoped(q, (s) => amexSummaryMatches(s, params));
  return { data: own.data, isError: q.isError };
}

type TileFiguresData = { owed: string | null; purchases: string | null };
function figuresOf(
  data: ReturnType<typeof useBandFigures>["data"],
  accountId: string,
): TileFiguresData {
  if (!data) return { owed: null, purchases: null };
  if (accountId === "all") return { owed: data.owed.current, purchases: data.purchases.amount };
  const card = data.scope.cards.find((c) => c.accountId === accountId);
  return { owed: card?.owed ?? null, purchases: card?.purchases.amount ?? null };
}

/**
 * One tile's figures: the head (its name) and owed. (Q6b) The band only
 * selects: the period's purchases, payments and the payoff words live in the
 * Summary above, once.
 */
function TileFigures({
  accountId, period, head, aside, showPurchases,
}: {
  accountId: string;
  period?: BandPeriod | null;
  /** (Q6b) Embedded there is no Summary above: the period's purchases sit on the tile. */
  showPurchases?: boolean;
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
          {showPurchases ? (
            <div className="mt-2 text-micro text-neutral-500" data-testid={`amex-band-purchases-${accountId}`}>
              Purchases{" "}
              <span className="font-mono font-semibold tabular-nums text-brand-navy">
                {loading ? "…" : moneyFace(figures.purchases)}
              </span>
            </div>
          ) : null}
        </div>
        {aside}
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
  showPurchases = false,
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
  /** (Q6b) Embedded (no Summary above): each tile also reads the period's purchases. */
  showPurchases?: boolean;
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
          showPurchases={showPurchases}
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
                showPurchases={showPurchases}
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
              showPurchases={showPurchases}
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
            {c.paidAs?.effectiveMode === "debt_plan" ? (
              <span className="mt-2 text-micro text-neutral-500" data-testid={`amex-tile-plan-word-${c.accountId}`}>On the payoff plan</span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

/**
 * (P1) The selected card's household name and last four, the way its section
 * tab names it (`amexCardTabs`: the name the household gave it, else its tier
 * word, else Plaid's name). `undefined` while the cards are still being read,
 * `null` for "All cards" or a card the roster does not list. Same queries as
 * the band and the tabs: no extra request — and this read keeps the settings
 * (the household's names) loaded for the cache-only tabs.
 */
export function useAmexCardName(
  selected: string,
  masks?: ReadonlyMap<string, string>,
): { name: string; mask: string } | null | undefined {
  const { data } = useGetAmexWeeklyPayoff();
  const { data: settings } = useGetSettings();
  if (selected === "all") return null;
  if (data === undefined) return undefined;
  const c = [...(data.cards ?? []), ...(data.debtLinkedCards ?? [])].find((x) => x.accountId === selected);
  if (!c) return null;
  const names = (settings?.preferences?.amexCardNames as Record<string, string>) ?? {};
  const tier = effectiveBrand(c.accountId, c.brand, cardBrandOverrides(settings));
  const mask = masks?.get(c.accountId) || ("mask" in c ? c.mask : null) || "";
  return { name: names[c.accountId] || BRAND_LABEL[tier] || c.name, mask };
}

/**
 * (Q6b) The selected card's name ••last4 exactly as the band's tile words it
 * (null for "All cards" or until the band's own data is in).
 */
export function useAmexCardTitle(selected: string, masks?: ReadonlyMap<string, string>): string | null {
  const n = useAmexCardName(selected, masks);
  if (!n) return null;
  return `${n.name}${n.mask ? ` ••${n.mask}` : ""}`;
}
