import type { Settings } from "@workspace/api-client-react";

// Amex per-card tier. Brand is normally regex-guessed server-side from the
// card name; the user can override it (Settings preferences.amexCardBrands)
// when Plaid's name doesn't carry the tier word (e.g. two cards reading
// "Platinum"). Display metadata only — never affects financial math.

export type AmexTier = "blue" | "silver" | "gold";
export const AMEX_TIERS: AmexTier[] = ["blue", "silver", "gold"];

export const BRAND_LABEL: Record<AmexTier, string> = {
  blue: "Blue Cash",
  silver: "Platinum",
  gold: "Gold",
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
  if (o === "blue" || o === "silver" || o === "gold") return o;
  return (serverBrand === "blue" || serverBrand === "silver" || serverBrand === "gold"
    ? serverBrand
    : "silver") as AmexTier;
}
