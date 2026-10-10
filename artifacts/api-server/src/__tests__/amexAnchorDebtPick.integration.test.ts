// ⭐ (WP2) WHICH DEBT THE AMEX ANCHOR WRITES — one, or none.
//
// `refreshAmexAnchor` compared `debts.plaid_account_id` (a uuid) with the
// external Plaid account ids the Amex rows carry. They can never be equal, so
// every Plaid household fell through to "the first debt named like amex" and
// overwrote whichever row that was. It now resolves the external ids to
// `plaid_accounts.id`, writes only a SOLE linked debt, never a balance Plaid
// owns (unless adopting), and uses the name only among unlinked debts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, debtsTable, plaidAccountsTable, plaidItemsTable, settingsTable, transactionsTable } from "@workspace/db";
import { refreshAmexAnchor } from "../lib/amexAnchor";
import { createTestHousehold } from "./_helpers/testHousehold";

const USER = `amex-pick-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, USER));
}

beforeAll(async () => {
  HH = (await createTestHousehold(USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(cleanup);

/** An Amex card account with one $86.33 charge on it (a Plaid row: money out is negative). */
async function card(mask: string): Promise<{ rowId: string; ext: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: USER, householdId: HH, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "amex" })
    .returning();
  const ext = `ext-amex-${mask}-${randomUUID().slice(0, 8)}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ userId: USER, householdId: HH, itemId: item!.id, accountId: ext, name: `Card ${mask}`, mask, type: "credit", subtype: "credit card" })
    .returning();
  await db.insert(transactionsTable).values({
    userId: USER,
    householdId: HH,
    occurredOn: "2026-10-06",
    description: "KROGER #442",
    amount: "-86.33",
    source: "plaid:amex",
    plaidAccountId: ext,
    plaidTransactionId: `${ext}-kroger`,
  });
  return { rowId: acct!.id, ext };
}

async function debt(o: { name: string; balance: string; plaidAccountId?: string | null; balanceSource?: string }): Promise<string> {
  const [d] = await db
    .insert(debtsTable)
    .values({
      userId: USER,
      householdId: HH,
      name: o.name,
      balance: o.balance,
      plaidAccountId: o.plaidAccountId ?? null,
      balanceSource: o.balanceSource ?? "manual",
    })
    .returning({ id: debtsTable.id });
  return d!.id;
}

const balanceOf = async (id: string) => (await db.select().from(debtsTable).where(eq(debtsTable.id, id)))[0]!.balance;
const anchorOf = async () =>
  ((await db.select().from(settingsTable).where(eq(settingsTable.userId, USER)))[0]?.preferences as { amexAnchor?: { balance: number } } | undefined)
    ?.amexAnchor;

describe("(WP2) refreshAmexAnchor writes one debt, or none", () => {
  it("the manual debt linked to the card is written; a manual decoy named 'Amex' is untouched", async () => {
    const plat = await card("1005");
    const linked = await debt({ name: "Platinum", balance: "500.00", plaidAccountId: plat.rowId });
    const decoy = await debt({ name: "Amex", balance: "123.45" });
    const r = await refreshAmexAnchor(USER);
    expect(r).toMatchObject({ changed: true, updatedDebt: true, balance: 86.33 });
    expect(await balanceOf(linked)).toBe("86.33");
    expect(await balanceOf(decoy)).toBe("123.45");
  });

  it("a linked debt whose balance Plaid owns is not written — and the decoy is not written in its place", async () => {
    const plat = await card("1005");
    const linked = await debt({ name: "Platinum", balance: "3842.98", plaidAccountId: plat.rowId, balanceSource: "plaid" });
    const decoy = await debt({ name: "American Express", balance: "123.45" });
    const r = await refreshAmexAnchor(USER);
    expect(r).toMatchObject({ changed: true, updatedDebt: false, balance: 86.33 });
    expect(await balanceOf(linked)).toBe("3842.98");
    expect(await balanceOf(decoy)).toBe("123.45");
    // The anchor itself still advances.
    expect((await anchorOf())?.balance).toBe(86.33);
  });

  it("two debts linked to the Amex cards: the combined anchor is neither's balance, so none is written", async () => {
    const blue = await card("1001");
    const plat = await card("1005");
    const a = await debt({ name: "Blue Cash", balance: "700.00", plaidAccountId: blue.rowId });
    const b = await debt({ name: "Platinum", balance: "900.00", plaidAccountId: plat.rowId });
    const r = await refreshAmexAnchor(USER);
    expect(r).toMatchObject({ changed: true, updatedDebt: false, balance: 172.66 });
    expect(await balanceOf(a)).toBe("700.00");
    expect(await balanceOf(b)).toBe("900.00");
  });

  it("adopting (the workbook re-import) may write a Plaid-owned linked balance", async () => {
    const plat = await card("1005");
    const linked = await debt({ name: "Platinum", balance: "3842.98", plaidAccountId: plat.rowId, balanceSource: "plaid" });
    const r = await refreshAmexAnchor(USER, db, { adopt: true });
    expect(r.updatedDebt).toBe(true);
    expect(await balanceOf(linked)).toBe("86.33");
  });

  it("no linked debt: the name match picks the ONE unlinked Amex debt, or none when two answer", async () => {
    await card("1005"); // rows on a card no debt links
    const only = await debt({ name: "American Express", balance: "10.00" });
    expect((await refreshAmexAnchor(USER)).updatedDebt).toBe(true);
    expect(await balanceOf(only)).toBe("86.33");

    await cleanup();
    await card("1005");
    const one = await debt({ name: "Amex Blue", balance: "10.00" });
    const two = await debt({ name: "Amex Gold", balance: "20.00" });
    expect((await refreshAmexAnchor(USER)).updatedDebt).toBe(false);
    expect(await balanceOf(one)).toBe("10.00");
    expect(await balanceOf(two)).toBe("20.00");
  });
});
