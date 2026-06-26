import { useGetAmexWeeklyPayoff } from "@workspace/api-client-react";
import { RingStat, MoneyText } from "@/components/viz";
import { cn } from "@/lib/utils";

const BRAND_LABEL: Record<string, string> = {
  blue: "Blue Cash",
  silver: "Platinum",
  gold: "Gold",
};
function brandColor(brand: string): string {
  return `hsl(var(--card-${brand}))`;
}

/**
 * Per-card brand header band for the Amex page: three brand-colored tiles
 * (Blue / Silver / Gold), each with statement balance, this-week charges, and
 * a RingStat for "% of statement cleared this week". Selecting a tile filters
 * the register below to that card (drill); the All tile clears the filter.
 *
 * Consumes GET /amex/weekly-payoff (deduped with the Kill Stack).
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
  const cards = data?.cards ?? [];
  if (cards.length === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={cn(
          "rounded-xl border bg-card p-4 text-left transition-colors",
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
        const color = brandColor(c.brand);
        const active = selected === c.accountId;
        return (
          <button
            key={c.accountId}
            type="button"
            onClick={() => onSelect(c.accountId)}
            className={cn(
              "rounded-xl border bg-card p-4 text-left transition-colors",
              active ? "ring-1 ring-primary/30" : "hover:border-primary/40",
            )}
            style={{
              borderColor: active ? color : "hsl(var(--card-border))",
              borderLeftColor: color,
              borderLeftWidth: 3,
            }}
            data-testid={`amex-tile-${c.brand}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: color }}
                />
                {BRAND_LABEL[c.brand] ?? c.name}
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
        );
      })}
    </div>
  );
}
