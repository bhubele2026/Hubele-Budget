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
 * Per-card brand header band for the Amex page: brand-colored tiles each with
 * statement balance, this-week charges, and a "% cleared" ring. Selecting a
 * tile filters the register below (drill); the All tile clears the filter.
 *
 * Each tile also carries an "Add to Avalanche" action (shared component) for
 * cards not yet tracked as debts — e.g. the Sky Card. Adding one links it to a
 * debt, after which amexAnchor drops it from this band. Tier/name editing lives
 * on the Avalanche page (components/avalanche-card-config.tsx); names/tiers set
 * there flow back here for display via settings preferences.
 */
export function AmexCardBand({
  selected,
  onSelect,
}: {
  /** Current cardFilter: "all" or an external Plaid account_id. */
  selected: string;
  onSelect: (accountId: string) => void;
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

  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={cn(
          "press surface rounded-card p-4 text-left ring-1",
          selected === "all"
            ? "ring-brand-navy/40"
            : "ring-brand-line hover:ring-brand-navy/25",
        )}
        data-testid="amex-tile-all"
        aria-pressed={selected === "all"}
      >
        <div className={fieldLabel}>All cards</div>
        <div className="mt-2 font-mono text-title font-semibold leading-none tabular-nums text-brand-navy">
          <MoneyText amount={data?.combinedStatementBalance ?? 0} />
        </div>
        <div className="mt-1 text-micro text-neutral-400">Combined balance</div>
        <div className="mt-3 border-t border-brand-line pt-2 text-micro text-neutral-500">
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
        return (
          <div
            key={c.accountId}
            className={cn(
              "surface rounded-card ring-1",
              active ? "ring-brand-navy/40" : "ring-brand-line",
            )}
            // ⚠️ THE ONLY NON-NAVY DECISION ON THIS PAGE, AND IT IS IDENTITY,
            // NOT STATUS. The left rule tells two Amex cards apart at a
            // glance; `--card-blue`/`--card-silver` are already inside the
            // navy/platinum ramp, so this spends no new colour.
            style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            data-testid={`amex-tile-${tier}`}
          >
            <button
              type="button"
              onClick={() => onSelect(c.accountId)}
              className="press w-full p-4 text-left"
              aria-pressed={active}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className={cn(fieldLabel, "flex items-center gap-1.5")}>
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                    <span className="truncate">
                      {names[c.accountId] || BRAND_LABEL[tier] || c.name}
                    </span>
                  </span>
                  <div className="mt-2 font-mono text-title font-semibold leading-none tabular-nums text-brand-navy">
                    <MoneyText amount={c.statementBalance} />
                  </div>
                  <div className="mt-1 text-micro text-neutral-400">
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
                  <span className="text-micro uppercase tracking-wide text-neutral-400">
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
    </div>
  );
}
