import { useState } from "react";
import {
  useGetAmexWeeklyPayoff,
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  getGetAmexWeeklyPayoffQueryKey,
  getListDebtsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyText } from "@/components/viz";
import {
  BRAND_LABEL,
  brandColor,
  cardBrandOverrides,
  effectiveBrand,
  AMEX_TIERS,
  type AmexTier,
} from "@/lib/amexBrand";
import { cn } from "@/lib/utils";
import { AddToAvalanche } from "@/components/add-card-to-avalanche";

type Cadence = "weekly" | "monthly";

/** Three small swatches to assign a card's tier (Blue / Platinum). */
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
            value === t
              ? "ring-2 ring-foreground scale-110"
              : "opacity-50 hover:opacity-100",
          )}
          style={{ background: brandColor(t) }}
        />
      ))}
    </div>
  );
}

/** Per-card custom name (saved on blur). Cadence is no longer toggled here — it
 *  is derived from the tier (Blue = monthly, Platinum = weekly). */
function CardConfig({
  name,
  placeholder,
  onName,
}: {
  name: string;
  placeholder: string;
  onName: (v: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
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
  );
}

/**
 * Avalanche-page card configuration: assign each Amex card's tier + name +
 * cadence, and add it to the payoff engine as a real debt. Moved off the Amex
 * page so the Amex band is display-only. Tier/name settings live in the shared
 * settings.preferences (amexCardBrands / amexCardNames / amexCardCadence).
 */
export function AvalancheCardConfig() {
  const { data } = useGetAmexWeeklyPayoff();
  const { data: settings } = useGetSettings();
  const updateSettings = useUpdateSettings();
  const qc = useQueryClient();
  const overrides = cardBrandOverrides(settings);
  const names =
    (settings?.preferences?.amexCardNames as Record<string, string>) ?? {};
  const cadences =
    (settings?.preferences?.amexCardCadence as Record<string, Cadence>) ?? {};

  const patchPref = async (patch: Record<string, unknown>) => {
    const prev = settings?.preferences ?? {};
    await updateSettings.mutateAsync({
      data: { preferences: { ...prev, ...patch } },
    });
    await qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
    await qc.invalidateQueries({ queryKey: getGetAmexWeeklyPayoffQueryKey() });
  };
  // Convention: Blue = monthly expenses, Platinum = weekly. The tier DRIVES the
  // cadence — picking a tier writes the matching cadence into the same setting
  // the payoff/kill-stack grouping reads, so there's no separate toggle to keep
  // in sync.
  const cadenceForTier = (tier: AmexTier): Cadence =>
    tier === "blue" ? "monthly" : "weekly";
  const setTier = (accountId: string, tier: AmexTier) =>
    patchPref({
      amexCardBrands: {
        ...(settings?.preferences?.amexCardBrands ?? {}),
        [accountId]: tier,
      },
      amexCardCadence: { ...cadences, [accountId]: cadenceForTier(tier) },
    });
  const setName = (accountId: string, name: string) =>
    patchPref({ amexCardNames: { ...names, [accountId]: name } });

  const refreshAfterCreate = async () => {
    await qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    await qc.invalidateQueries({ queryKey: getGetAmexWeeklyPayoffQueryKey() });
  };

  const cards = data?.cards ?? [];
  if (cards.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Amex cards</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {cards.map((c) => {
        const tier = effectiveBrand(c.accountId, c.brand, overrides);
        const color = brandColor(tier);
        return (
          <div
            key={c.accountId}
            className="rounded-xl border border-card-border p-3"
            style={{ borderLeftColor: color, borderLeftWidth: 3 }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: color }}
                />
                {names[c.accountId] || BRAND_LABEL[tier] || c.name}
              </span>
              <span className="text-xs text-muted-foreground">
                <MoneyText amount={c.statementBalance} />
              </span>
            </div>
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <TierPicker
                  value={tier}
                  onChange={(t) => void setTier(c.accountId, t)}
                />
                <span
                  className="rounded-md border border-card-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                  title="Cadence is set by the tier: Blue = monthly, Platinum = weekly"
                >
                  {tier === "blue" ? "Monthly card" : "Weekly card"}
                </span>
              </div>
              <CardConfig
                name={names[c.accountId] ?? ""}
                placeholder={BRAND_LABEL[tier]}
                onName={(v) => void setName(c.accountId, v)}
              />
              <AddToAvalanche card={c} onCreated={refreshAfterCreate} />
            </div>
          </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
