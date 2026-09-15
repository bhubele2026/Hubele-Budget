// (PR-H) Pure, DB-free pin: `householdMoney.ts`'s `CARD_LEDGER_SOURCES` mirrors
// `AMEX_TXN_SOURCES` (`amexAnchor.ts`) verbatim, because avalanche-core cannot
// import from api-server. If one list changes without the other, a row
// `classifyMovement` calls "card" timing and a row the Amex anchor/weekly
// payoff treat as an Amex row would quietly stop being the same set.

import { describe, expect, it } from "vitest";
import { CARD_LEDGER_SOURCES } from "@workspace/avalanche-core";
import { AMEX_TXN_SOURCES } from "./amexAnchor";
import { readEverydayHooks } from "./moneyContext";

describe("CARD_LEDGER_SOURCES mirrors AMEX_TXN_SOURCES", () => {
  it("the two lists are the same set", () => {
    expect([...CARD_LEDGER_SOURCES].sort()).toEqual([...AMEX_TXN_SOURCES].sort());
  });
});

describe("readEverydayHooks (PR8r)", () => {
  it("reads the two ids as stored", () => {
    expect(readEverydayHooks({ everydayHooks: { weeklyItemId: "w-1", monthlyItemId: "m-1" } })).toEqual({
      weeklyItemId: "w-1",
      monthlyItemId: "m-1",
    });
  });

  it("anything that is not a non-empty string id reads as null", () => {
    for (const prefs of [null, undefined, 42, "x", {}, { everydayHooks: null }, { everydayHooks: "w-1" }]) {
      expect(readEverydayHooks(prefs), JSON.stringify(prefs)).toEqual({ weeklyItemId: null, monthlyItemId: null });
    }
    expect(readEverydayHooks({ everydayHooks: { weeklyItemId: "", monthlyItemId: 7 } })).toEqual({
      weeklyItemId: null,
      monthlyItemId: null,
    });
  });
});
