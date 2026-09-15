// (PR-H round 2, review M4) `discoverAmexCards` — the Amex card discovery and
// billing-cadence block moved out of `computeWeeklyPayoff`. Round 1 moved it
// with no test of its own: seven mutations (Blue default, explicit override,
// card names, excluded ids, the liability-kind and type filters, the Blue
// brand regex) each passed every Amex test file. This pins each of them
// directly, and pins `computeWeeklyPayoff` reading the same answer.
//
// Synthetic names, masks and ids only.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, plaidAccountsTable, plaidItemsTable, settingsTable } from "@workspace/db";
import { classifyAmexBrand, discoverAmexCards } from "../lib/amexCardCadence";
import { computeWeeklyPayoff } from "../lib/amexAnchor";
import { createTestHousehold } from "./_helpers/testHousehold";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OWNER = `pr-h-amex-cadence-${RUN}`;
const OTHER_OWNER = `pr-h-amex-cadence-other-${RUN}`;
let HH: string;
let OTHER_HH: string;

const ext = (label: string) => `acct-${label}-${randomUUID()}`;
const BLUE = ext("blue"); // Blue, no override → monthly
const PLATINUM = ext("platinum"); // Platinum, liability kind 'credit', no override → weekly
const PLATINUM_MONTHLY = ext("platinum-monthly"); // explicit monthly
const BLUE_WEEKLY = ext("blue-weekly"); // explicit weekly
const GOLD = ext("gold"); // second Amex login ("american_express"), unknown override value → brand default
const REWARDS = ext("rewards"); // depository sub-account on the Amex login → not a card
const LOAN = ext("loan"); // type credit, liability kind 'student' → not a card
const OTHER_BANK_CARD = ext("other-bank"); // a credit card at another institution → not Amex
const OTHER_HOUSEHOLD_CARD = ext("other-household"); // an Amex card in another household
const DISCOVERED = [BLUE, PLATINUM, PLATINUM_MONTHLY, BLUE_WEEKLY, GOLD].sort();

const PREFERENCES = {
  amexCardCadence: { [PLATINUM_MONTHLY]: "monthly", [BLUE_WEEKLY]: "weekly", [GOLD]: "fortnightly" },
  amexCardNames: { [PLATINUM]: "Travel card" },
  amexExcludedTxnIds: ["txn-not-ours-1", "txn-not-ours-2"],
};

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  OTHER_HH = (await createTestHousehold(OTHER_OWNER)).householdId;

  const item = async (userId: string, householdId: string, institutionSlug: string) => {
    const [row] = await db
      .insert(plaidItemsTable)
      .values({ userId, householdId, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug })
      .returning({ id: plaidItemsTable.id });
    return row!.id;
  };
  const amex = await item(OWNER, HH, "amex");
  const amexSecondLogin = await item(OWNER, HH, "american_express");
  const otherBank = await item(OWNER, HH, "chase");
  const otherHouseholdAmex = await item(OTHER_OWNER, OTHER_HH, "amex");

  const account = (
    userId: string,
    householdId: string,
    itemId: string,
    accountId: string,
    name: string,
    mask: string,
    type: string,
    liabilityKind: string | null = null,
  ) => ({ userId, householdId, itemId, accountId, name, mask, type, subtype: type === "credit" ? "credit card" : "savings", liabilityKind });

  await db.insert(plaidAccountsTable).values([
    account(OWNER, HH, amex, BLUE, "Blue Cash Everyday", "2002", "credit"),
    account(OWNER, HH, amex, PLATINUM, "Platinum Card", "2001", "credit", "credit"),
    account(OWNER, HH, amex, PLATINUM_MONTHLY, "Platinum Card", "2003", "credit"),
    account(OWNER, HH, amex, BLUE_WEEKLY, "Blue Business Cash", "2004", "credit"),
    account(OWNER, HH, amexSecondLogin, GOLD, "Gold Card", "2005", "credit"),
    account(OWNER, HH, amex, REWARDS, "Membership Rewards", "2006", "depository"),
    account(OWNER, HH, amex, LOAN, "Personal Loan", "2007", "credit", "student"),
    account(OWNER, HH, otherBank, OTHER_BANK_CARD, "Freedom Card", "2008", "credit"),
    account(OTHER_OWNER, OTHER_HH, otherHouseholdAmex, OTHER_HOUSEHOLD_CARD, "Blue Cash Everyday", "2009", "credit"),
  ]);

  await db
    .insert(settingsTable)
    .values({ userId: OWNER, householdId: HH, preferences: PREFERENCES })
    .onConflictDoUpdate({ target: settingsTable.userId, set: { preferences: PREFERENCES, updatedAt: new Date() } });
});

afterAll(async () => {
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, [OWNER, OTHER_OWNER]));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, [OWNER, OTHER_OWNER]));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, [OWNER, OTHER_OWNER]));
});

describe("discoverAmexCards — which accounts are this household's Amex cards", () => {
  it("exactly the credit-card sub-accounts on this household's Amex logins", async () => {
    const cards = await discoverAmexCards(HH, OWNER);
    expect(cards.cardRows.map((c) => c.accountId).sort()).toEqual(DISCOVERED);
  });

  it("a depository sub-account on the same Amex login is not a card (the type filter)", async () => {
    const ids = (await discoverAmexCards(HH, OWNER)).cardRows.map((c) => c.accountId);
    expect(ids).not.toContain(REWARDS);
  });

  it("a credit account whose liability is not a credit card is not a card (the liability-kind filter)", async () => {
    const ids = (await discoverAmexCards(HH, OWNER)).cardRows.map((c) => c.accountId);
    expect(ids).not.toContain(LOAN);
    // Both allowed liability kinds are kept: none recorded, and 'credit'.
    expect(ids).toContain(BLUE);
    expect(ids).toContain(PLATINUM);
  });

  it("another institution's card and another household's Amex card are never included", async () => {
    const ids = (await discoverAmexCards(HH, OWNER)).cardRows.map((c) => c.accountId);
    expect(ids).not.toContain(OTHER_BANK_CARD);
    expect(ids).not.toContain(OTHER_HOUSEHOLD_CARD);
    const other = await discoverAmexCards(OTHER_HH, OTHER_OWNER);
    expect(other.cardRows.map((c) => c.accountId)).toEqual([OTHER_HOUSEHOLD_CARD]);
  });
});

describe("discoverAmexCards — brand and cadence", () => {
  it("brand comes from the display name: Blue cards are blue, Platinum and Gold are silver", async () => {
    const { brandByAccountId } = await discoverAmexCards(HH, OWNER);
    expect(brandByAccountId.get(BLUE)).toBe("blue");
    expect(brandByAccountId.get(BLUE_WEEKLY)).toBe("blue");
    expect(brandByAccountId.get(PLATINUM)).toBe("silver");
    expect(brandByAccountId.get(PLATINUM_MONTHLY)).toBe("silver");
    expect(brandByAccountId.get(GOLD)).toBe("silver");
  });

  it("with no explicit cadence, a Blue card bills monthly and a Platinum or Gold card weekly", async () => {
    const { cadenceFor } = await discoverAmexCards(HH, OWNER);
    expect(cadenceFor(BLUE)).toBe("monthly");
    expect(cadenceFor(PLATINUM)).toBe("weekly");
    // "fortnightly" is not a cadence: the brand default stands.
    expect(cadenceFor(GOLD)).toBe("weekly");
  });

  it("the owner's explicit cadence wins, in both directions", async () => {
    const { cadenceFor } = await discoverAmexCards(HH, OWNER);
    expect(cadenceFor(PLATINUM_MONTHLY)).toBe("monthly");
    expect(cadenceFor(BLUE_WEEKLY)).toBe("weekly");
  });
});

describe("discoverAmexCards — the owner's per-card preferences", () => {
  it("reads the display names and the 'not mine' charge ids from the owner's settings", async () => {
    const { nameMap, excludedTxnIds } = await discoverAmexCards(HH, OWNER);
    expect(nameMap).toEqual({ [PLATINUM]: "Travel card" });
    expect([...excludedTxnIds].sort()).toEqual(["txn-not-ours-1", "txn-not-ours-2"]);
  });

  it("without an owner there is no config: brand defaults, no names, nothing excluded", async () => {
    const cards = await discoverAmexCards(HH);
    expect(cards.cadenceFor(PLATINUM_MONTHLY)).toBe("weekly");
    expect(cards.cadenceFor(BLUE_WEEKLY)).toBe("monthly");
    expect(cards.nameMap).toEqual({});
    expect(cards.excludedTxnIds.size).toBe(0);
  });

  it("pre-read preferences are used exactly as handed in — the settings row is not read again (review L1)", async () => {
    const cards = await discoverAmexCards(HH, OWNER, {
      preferences: { amexCardCadence: { [BLUE]: "weekly" }, amexCardNames: { [GOLD]: "Spare" } },
    });
    expect(cards.cadenceFor(BLUE)).toBe("weekly");
    // The stored override would say monthly; the handed-in preferences have none.
    expect(cards.cadenceFor(PLATINUM_MONTHLY)).toBe("weekly");
    expect(cards.nameMap).toEqual({ [GOLD]: "Spare" });
    expect(cards.excludedTxnIds.size).toBe(0);

    const none = await discoverAmexCards(HH, OWNER, { preferences: null });
    expect(none.cadenceFor(BLUE_WEEKLY)).toBe("monthly");
    expect(none.nameMap).toEqual({});
  });
});

describe("classifyAmexBrand", () => {
  it("any 'blue' in the name or mask is blue; everything else is silver", () => {
    expect(classifyAmexBrand("Blue Cash Preferred", "1234")).toBe("blue");
    expect(classifyAmexBrand("BLUE BUSINESS", null)).toBe("blue");
    expect(classifyAmexBrand(null, "blue")).toBe("blue");
    expect(classifyAmexBrand("Platinum Card", "1001")).toBe("silver");
    expect(classifyAmexBrand("Gold Card", null)).toBe("silver");
    expect(classifyAmexBrand(null, null)).toBe("silver");
  });
});

describe("computeWeeklyPayoff reads the same discovery", () => {
  it("its cards are the discovered cards, each with the discovered cadence and display name", async () => {
    const payoff = await computeWeeklyPayoff(HH, "2026-09-06", OWNER);
    const byId = new Map(payoff.cards.map((c) => [c.accountId, c]));
    expect([...byId.keys()].sort()).toEqual(DISCOVERED);
    expect(byId.get(BLUE)).toMatchObject({ cadence: "monthly", periodLabel: "this month" });
    expect(byId.get(PLATINUM)).toMatchObject({ cadence: "weekly", periodLabel: "this week", displayName: "Travel card" });
    expect(byId.get(PLATINUM_MONTHLY)!.cadence).toBe("monthly");
    expect(byId.get(BLUE_WEEKLY)!.cadence).toBe("weekly");
    expect(byId.get(GOLD)!.cadence).toBe("weekly");
  });
});
