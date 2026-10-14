import type { AmexWeeklyPayoffCard } from "@workspace/api-client-react";
import { BRAND_LABEL, cardBrandOverrides, effectiveBrand } from "@/lib/amexBrand";
import { amexCardHref, type SectionTab } from "@/lib/navModel";

/** What the tabs read of a linked Plaid item: external account id → last four. */
export interface MaskSource {
  accounts?: ReadonlyArray<{ accountId: string; mask?: string | null }> | null;
}

/**
 * ⭐ ONE TAB PER AMEX CARD, named the way the card band names it: the name the
 * household gave it (Settings → `amexCardNames`), else its tier word, else
 * Plaid's name; then `••last4` from the linked accounts. Pure — it reads data
 * the Amex page already loaded and fetches nothing. No cards yet → no tabs.
 */
export function amexCardTabs(
  cards: readonly Pick<AmexWeeklyPayoffCard, "accountId" | "brand" | "name">[] | undefined | null,
  settings: Parameters<typeof cardBrandOverrides>[0],
  items: readonly MaskSource[] | undefined | null,
): SectionTab[] {
  if (!cards || cards.length === 0) return [];
  const overrides = cardBrandOverrides(settings);
  const names = (settings?.preferences?.amexCardNames as Record<string, string> | undefined) ?? {};
  const masks = new Map<string, string>();
  for (const it of items ?? []) {
    for (const a of it.accounts ?? []) {
      const m = (a.mask ?? "").trim();
      if (a.accountId && m) masks.set(a.accountId, m);
    }
  }
  return cards.map((c) => {
    const tier = effectiveBrand(c.accountId, c.brand, overrides);
    const name = names[c.accountId] || BRAND_LABEL[tier] || c.name;
    const mask = masks.get(c.accountId);
    return {
      name: mask ? `${name} ••${mask}` : name,
      href: amexCardHref(c.accountId),
      testId: `amex-card-${c.accountId}`,
    };
  });
}
