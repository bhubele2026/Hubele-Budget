import { useState } from "react";
import {
  useGetAmexWeeklyPayoff,
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  getGetAmexWeeklyPayoffQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { RingStat, MoneyText } from "@/components/viz";
import {
  BRAND_LABEL,
  brandColor,
  cardBrandOverrides,
  effectiveBrand,
  AMEX_TIERS,
  type AmexTier,
} from "@/lib/amexBrand";
import { cn } from "@/lib/utils";

type Cadence = "weekly" | "monthly";

/** Per-card config row: custom name (saved on blur) + weekly/monthly toggle. */
function CardConfig({
  name,
  cadence,
  placeholder,
  onName,
  onCadence,
}: {
  name: string;
  cadence: Cadence;
  placeholder: string;
  onName: (v: string) => void;
  onCadence: (v: Cadence) => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <div className="space-y-1.5">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== name && onName(draft.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder={placeholder}
        aria-label="Card name"
        className="w-full rounded-md border border-card-border bg-background px-2 py-1 text-xs"
      />
      <div className="inline-flex items-center rounded-md border border-card-border p-0.5 text-[10px] font-medium">
        {(["weekly", "monthly"] as Cadence[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onCadence(c)}
            aria-pressed={cadence === c}
            data-testid={`amex-cadence-${c}`}
            className={cn(
              "rounded px-2 py-0.5 uppercase tracking-wide transition-colors",
              cadence === c ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {c === "weekly" ? "Weekly" : "Monthly"}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Three small swatches to assign a card's tier. Sits below the select tile. */
function TierPicker({
  value,
  onChange,
}: {
  value: AmexTier;
  onChange: (t: AmexTier) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
        Tier
      </span>
      {AMEX_TIERS.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          title={BRAND_LABEL[t]}
          aria-label={`Set tier ${BRAND_LABEL[t]}`}
          aria-pressed={value === t}
          data-testid={`amex-tier-set-${t}`}
          className={cn(
            "h-4 w-4 rounded-full ring-offset-1 transition-all",
            value === t ? "ring-2 ring-foreground scale-110" : "opacity-50 hover:opacity-100",
          )}
          style={{ background: brandColor(t) }}
        />
      ))}
    </div>
  );
}

/**
 * Per-card brand header band for the Amex page: brand-colored tiles each with
 * statement balance, this-week charges, and a "% cleared" ring. Selecting a
 * tile filters the register below (drill); the All tile clears the filter.
 *
 * Each card carries a TIER picker — the tier label/color come from a user
 * override (settings.preferences.amexCardBrands) over Plaid's regex guess, so
 * two cards that both read "Platinum" can be set to Silver / Gold correctly.
 * Display metadata only; no financial math touched.
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
  const updateSettings = useUpdateSettings();
  const qc = useQueryClient();
  const overrides = cardBrandOverrides(settings);
  const names = (settings?.preferences?.amexCardNames as Record<string, string>) ?? {};
  const cadences = (settings?.preferences?.amexCardCadence as Record<string, Cadence>) ?? {};

  const patchPref = async (patch: Record<string, unknown>) => {
    const prev = settings?.preferences ?? {};
    await updateSettings.mutateAsync({ data: { preferences: { ...prev, ...patch } } });
    await qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
    // Cadence/name affect the payoff grouping + labels, so refresh it too.
    await qc.invalidateQueries({ queryKey: getGetAmexWeeklyPayoffQueryKey() });
  };
  const setTier = (accountId: string, tier: AmexTier) =>
    patchPref({ amexCardBrands: { ...(settings?.preferences?.amexCardBrands ?? {}), [accountId]: tier } });
  const setName = (accountId: string, name: string) =>
    patchPref({ amexCardNames: { ...names, [accountId]: name } });
  const setCadence = (accountId: string, cadence: Cadence) =>
    patchPref({ amexCardCadence: { ...cadences, [accountId]: cadence } });

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
            className="rounded-2xl border bg-card"
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
              className={cn(
                "w-full rounded-t-2xl p-4 text-left transition-colors",
                active ? "ring-1 ring-inset ring-primary/30" : "hover:bg-accent/30",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                  {names[c.accountId] || BRAND_LABEL[tier] || c.name}
                </span>
                <RingStat value={c.pctOfStatementThisWeek} size={36} stroke={4} color={color} centerText="" />
              </div>
              <div className="mt-2 text-xl font-bold">
                <MoneyText amount={c.statementBalance} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                <MoneyText amount={c.weekCharges} /> this week
              </div>
            </button>
            <div className="px-4 pb-3 space-y-2">
              <TierPicker value={tier} onChange={(t) => void setTier(c.accountId, t)} />
              <CardConfig
                name={names[c.accountId] ?? ""}
                cadence={cadences[c.accountId] === "monthly" ? "monthly" : "weekly"}
                placeholder={BRAND_LABEL[tier]}
                onName={(v) => void setName(c.accountId, v)}
                onCadence={(v) => void setCadence(c.accountId, v)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
