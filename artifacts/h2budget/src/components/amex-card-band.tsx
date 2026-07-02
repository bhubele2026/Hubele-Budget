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
    <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={cn(
          "rounded-2xl border bg-card p-4 text-left transition-colors",
          selected === "all"
            ? "border-primary ring-1 ring-primary/30"
            : "border-card-border hover:border-primary/40",
        )}
        data-testid="amex-tile-all"
      >
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
          All cards
        </div>
        <div className="mt-2 text-xl font-bold">
          <MoneyText amount={data?.combinedStatementBalance ?? 0} />
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {<MoneyText amount={data?.combinedWeekCharges ?? 0} />} charged last week
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
              "rounded-2xl border bg-card p-4",
              active ? "ring-1 ring-inset ring-primary/30" : "",
            )}
            style={{
              borderColor: active ? color : "hsl(var(--card-border))",
              borderLeftColor: color,
              borderLeftWidth: 3,
            }}
            data-testid={`amex-tile-${tier}`}
          >
            <button
              type="button"
              onClick={() => onSelect(c.accountId)}
              className="w-full text-left transition-opacity hover:opacity-90"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: color }}
                  />
                  {names[c.accountId] || BRAND_LABEL[tier] || c.name}
                </span>
                <RingStat
                  value={c.pctOfStatementThisWeek}
                  size={36}
                  stroke={4}
                  color={color}
                  centerText=""
                />
              </div>
              <div className="mt-2 text-xl font-bold">
                <MoneyText amount={c.statementBalance} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                <MoneyText amount={c.weekCharges} /> this week
              </div>
            </button>
            <div className="mt-2">
              <AddToAvalanche card={c} onCreated={refreshAfterCreate} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
