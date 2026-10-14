// (S5) AN AMEX CARD'S NAME, as every surface prints it. Pure, display only:
// it never touches a figure.
//
// The chain is the one the Amex card band and the W1 card tabs already use
// (`artifacts/h2budget/src/lib/amexBrand.ts` + `amexCardTabs.ts`):
//   1. the name the household gave the card (`preferences.amexCardNames[id]`);
//   2. else its tier word — the owner's tier override
//      (`preferences.amexCardBrands[id]`; a legacy "gold" reads Platinum), else
//      the server's guess from the card's name (`classifyAmexBrand`);
//   3. else Plaid's name.
// The server's `GET /amex/summary` names cards with it; the web's copy is
// pinned equal by `artifacts/h2budget/src/lib/amexCardLabelParity.test.ts`.

export type AmexTier = "blue" | "silver";

/** The tier words. "silver" is the Platinum tier (Gold is retired and reads Platinum). */
export const AMEX_TIER_LABEL: Readonly<Record<AmexTier, string>> = {
  blue: "Blue Cash",
  silver: "Platinum",
};

/** The tier a card shows: the owner's override wins over the server's guess. */
export function amexEffectiveTier(
  accountId: string,
  serverBrand: string | null | undefined,
  overrides: Readonly<Record<string, string>> | null | undefined,
): AmexTier {
  const o = overrides?.[accountId];
  if (o === "blue") return "blue";
  if (o === "silver" || o === "gold") return "silver";
  return serverBrand === "blue" ? "blue" : "silver";
}

/** ⭐ The card's name: the household's, else its tier word, else Plaid's. */
export function amexCardLabel(input: {
  accountId: string;
  serverBrand: string | null | undefined;
  plaidName: string | null | undefined;
  names?: Readonly<Record<string, string>> | null;
  brands?: Readonly<Record<string, string>> | null;
}): string {
  const own = input.names?.[input.accountId];
  if (typeof own === "string" && own) return own;
  const tier = amexEffectiveTier(input.accountId, input.serverBrand, input.brands);
  return AMEX_TIER_LABEL[tier] || input.plaidName || "American Express";
}
