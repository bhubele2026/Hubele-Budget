import type { Settings } from "@workspace/api-client-react";

// Amex per-card tier. Brand is normally regex-guessed server-side from the
// card name; the user can override it (Settings preferences.amexCardBrands)
// when Plaid's name doesn't carry the tier word (e.g. two cards reading
// "Platinum"). Display metadata only — never affects financial math.

// Two tiers only: Blue and Platinum (internal key "silver"). The Gold tier is
// retired — any legacy "gold" value normalizes to Platinum below.
export type AmexTier = "blue" | "silver";
export const AMEX_TIERS: AmexTier[] = ["blue", "silver"];

export const BRAND_LABEL: Record<AmexTier, string> = {
  blue: "Blue Cash",
  silver: "Platinum",
};

/** The --card-* identity token for a tier. */
export function brandColor(tier: string): string {
  return `hsl(var(--card-${tier}))`;
}

/** The user-assigned tier overrides, keyed by external Plaid account_id. */
export function cardBrandOverrides(
  settings: Settings | undefined | null,
): Record<string, AmexTier> {
  const raw = settings?.preferences?.amexCardBrands;
  return (raw as Record<string, AmexTier> | undefined) ?? {};
}

/** Effective tier: a user override wins over the server's regex guess. */
export function effectiveBrand(
  accountId: string,
  serverBrand: string,
  overrides: Record<string, AmexTier>,
): AmexTier {
  const o = overrides[accountId];
  if (o === "blue") return "blue";
  if (o === "silver" || o === "gold") return "silver"; // legacy Gold → Platinum
  // Server guess: only Blue stays Blue; everything else (incl. legacy Gold) is Platinum.
  return serverBrand === "blue" ? "blue" : "silver";
}
