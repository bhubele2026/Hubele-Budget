// (S5) ONE NAME PER AMEX CARD. The server's GET /amex/summary names a card with
// avalanche-core's `amexCardLabel`; the card band and the card tabs name it with
// this app's `amexBrand.ts` chain. This pins the two equal, so a card never
// reads one name on the summary and another on its tab. Test only: no screen
// changes here.

import { describe, expect, it } from "vitest";
import { AMEX_TIER_LABEL, amexCardLabel, amexEffectiveTier } from "@workspace/avalanche-core";
import { BRAND_LABEL, effectiveBrand, type AmexTier } from "./amexBrand";
import { amexCardTabs } from "./amexCardTabs";

describe("Amex card names — the web chain = the server's", () => {
  it("the tier words are the same", () => {
    expect(BRAND_LABEL).toEqual(AMEX_TIER_LABEL);
  });

  it("the effective tier and the name agree on every override, guess and saved name", () => {
    const overrides: Array<Record<string, AmexTier | "gold"> | Record<string, never>> = [{}, { a1: "blue" }, { a1: "silver" }, { a1: "gold" }];
    for (const serverBrand of ["blue", "silver", "gold"]) {
      for (const o of overrides) {
        expect(effectiveBrand("a1", serverBrand, o as Record<string, AmexTier>), `${serverBrand} ${JSON.stringify(o)}`).toBe(
          amexEffectiveTier("a1", serverBrand, o),
        );
        for (const names of [{}, { a1: "Travel card" }, { a1: "" }]) {
          const settings = { preferences: { amexCardBrands: o, amexCardNames: names } } as never;
          const [tab] = amexCardTabs([{ accountId: "a1", brand: serverBrand as never, name: "Gold Card" }], settings, []);
          expect(tab!.name, `${serverBrand} ${JSON.stringify(o)} ${JSON.stringify(names)}`).toBe(
            amexCardLabel({ accountId: "a1", serverBrand, plaidName: "Gold Card", names, brands: o }),
          );
        }
      }
    }
  });
});
