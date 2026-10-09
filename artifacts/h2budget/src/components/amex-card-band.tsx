import {
  useGetAmexWeeklyPayoff,
  useGetSettings,
  getGetAmexWeeklyPayoffQueryKey,
  getListDebtsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { RingStat, MoneyText } from "@/components/viz";
import { AddToAvalanche } from "@/components/add-card-to-avalanche";
import {
  BRAND_LABEL,
  brandColor,
  cardBrandOverrides,
  effectiveBrand,
} from "@/lib/amexBrand";
import { cn } from "@/lib/utils";
import { fieldLabel } from "@/ui";

/**
 * Per-card band for the Amex page (C10): one PANEL per card on the page grid,
 * plus an "All cards" panel. Each card panel carries the Amex identity edge
 * (the teal-green account accent, CLAUDE.md §3), its name and ••mask, the
 * statement balance, this week's charges, and a "% cleared" ring; the card's
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
}: {
  /** Current cardFilter: "all" or an external Plaid account_id. */
  selected: string;
  onSelect: (accountId: string) => void;
  /** External Plaid account_id → last four digits, from the linked items. */
  masks?: ReadonlyMap<string, string>;
  /** Cells the host already placed in the band's first row. */
  leadCount?: number;
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
  if (cards.length === 0) return null;
  // Beside a lead (a span-4 Summary) every cell is span-4: rows of three.
  // Alone: two cells halve the row, four quarter it, otherwise thirds.
  const total = cards.length + 1;
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
        <div className={fieldLabel}>All cards</div>
        <div className="mt-2 font-mono text-title font-semibold leading-none tabular-nums text-brand-navy">
          <MoneyText amount={data?.combinedStatementBalance ?? 0} />
        </div>
        <div className="mt-1 text-micro text-neutral-500">Combined balance</div>
        <div className="mt-auto border-t border-brand-line pt-2 text-micro text-neutral-500">
          <MoneyText
            amount={data?.combinedWeekCharges ?? 0}
            className="font-mono font-semibold tabular-nums text-brand-navy"
          />{" "}
          this week
        </div>
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
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className={cn(fieldLabel, "flex items-center gap-1.5")}>
                    {/* The card's tier colour (identity within Amex); the
                        panel's edge is the account accent. */}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: color }}
                      aria-hidden
                    />
                    <span className="truncate">
                      {names[c.accountId] || BRAND_LABEL[tier] || c.name}
                    </span>
                    {mask ? (
                      <span className="shrink-0 font-mono normal-case tracking-normal tabular-nums text-neutral-500">
                        ••{mask}
                      </span>
                    ) : null}
                  </span>
                  <div className="mt-2 font-mono text-title font-semibold leading-none tabular-nums text-brand-navy">
                    <MoneyText amount={c.statementBalance} />
                  </div>
                  <div className="mt-1 text-micro text-neutral-500">
                    Statement balance
                  </div>
                </div>
                {/* Progress is progress everywhere in this app — navy, not the
                    card's identity colour, or "% cleared" would read as which
                    card it is rather than how far along it is.

                    ⚠️ THE CAPTION SITS UNDER THE RING, NOT INSIDE IT. At 9px
                    with the widest tracking, "cleared" is wider than a 52px
                    ring, so as `centerSub` it spilled past the tile's right
                    edge and read as clipped text. The label still ships —
                    under the palette rule a number like this may not go
                    unlabelled — it just sits where it fits. */}
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <RingStat
                    value={c.pctOfStatementThisWeek}
                    size={52}
                    stroke={5}
                    color="var(--color-brand-navy)"
                    centerText={`${Math.round((c.pctOfStatementThisWeek ?? 0) * 100)}%`}
                  />
                  <span className="text-micro uppercase tracking-wide text-neutral-500">
                    cleared
                  </span>
                </div>
              </div>
              <div className="mt-3 border-t border-brand-line pt-2 text-micro text-neutral-500">
                <MoneyText
                  amount={c.weekCharges}
                  className="font-mono font-semibold tabular-nums text-brand-navy"
                />{" "}
                this week
              </div>
            </button>
            <div className="px-4 pb-4">
              <AddToAvalanche card={c} onCreated={refreshAfterCreate} />
            </div>
          </div>
        );
      })}
    </>
  );
}
