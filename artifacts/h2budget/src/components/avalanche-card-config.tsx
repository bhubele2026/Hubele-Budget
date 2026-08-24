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
import { card, cardHead, th, td, tdNum, inputInline, Help } from "@/ui";
import {
  BRAND_LABEL,
  brandColor,
  cardBrandOverrides,
  effectiveBrand,
  AMEX_TIERS,
  type AmexTier,
} from "@/lib/amexBrand";
import { cn, formatCurrency } from "@/lib/utils";
import { AddToAvalanche } from "@/components/add-card-to-avalanche";

type Cadence = "weekly" | "monthly";

/** Swatches to assign a card's tier (Blue / Platinum). */
function TierPicker({
  value,
  onChange,
}: {
  value: AmexTier;
  onChange: (t: AmexTier) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
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
            "press h-4 w-4 rounded-full ring-offset-1",
            value === t
              ? "ring-2 ring-brand-navy"
              : "opacity-45 hover:opacity-100",
          )}
          style={{ background: brandColor(t) }}
        />
      ))}
    </div>
  );
}

/** Per-card custom name (saved on blur). Cadence is derived from the tier
 *  (Blue = monthly, Platinum = weekly), so there is no separate toggle. */
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
      className={cn(inputInline, "w-full font-sans")}
    />
  );
}

/**
 * Avalanche-page card configuration: assign each Amex card's tier + name, and
 * add it to the payoff engine as a real debt. Moved off the Amex page so the
 * Amex band is display-only. Tier/name settings live in the shared
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
    <div className={card}>
      <div className={cardHead}>
        <span className="text-title font-semibold text-brand-navy">Amex cards</span>
        <Help className="ml-auto">
          Tier sets the cadence — Blue is a monthly card, Platinum is weekly.
          Adding a card to the plan creates it as a debt the avalanche can
          target.
        </Help>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Card</th>
              <th className={`${th} text-right`}>Statement</th>
              <th className={th}>Tier</th>
              <th className={th}>Cadence</th>
              <th className={th}>In plan</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => {
              const tier = effectiveBrand(c.accountId, c.brand, overrides);
              return (
                <tr key={c.accountId}>
                  <td className={`${td} min-w-[180px]`}>
                    <CardConfig
                      name={names[c.accountId] ?? ""}
                      placeholder={BRAND_LABEL[tier]}
                      onName={(v) => void setName(c.accountId, v)}
                    />
                  </td>
                  <td className={tdNum}>{formatCurrency(c.statementBalance)}</td>
                  <td className={td}>
                    <TierPicker
                      value={tier}
                      onChange={(t) => void setTier(c.accountId, t)}
                    />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <span className="chip gray">
                      {tier === "blue" ? "Monthly" : "Weekly"}
                    </span>
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <AddToAvalanche card={c} onCreated={refreshAfterCreate} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
