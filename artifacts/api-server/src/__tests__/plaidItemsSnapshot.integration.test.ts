// (WP3) GET /plaid/items: every account carries its last balance READING
// (`snapshot`, never rolled forward), and `lastBankTxOn` is the shared
// "data through" rule (`lib/bankCoverage.ts`). Read-only; no Plaid call — the
// mocked client throws if anything reaches it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const OWNER = `wp3-snap-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `wp3-snap-o-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";
let HH_OTHER = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HH;
    req.householdOwnerId = OWNER;
    next();
  },
}));
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () =>
      new Proxy({}, { get: () => () => { throw new Error("GET /plaid/items must never call Plaid"); } }),
  };
});

import { db, forecastSettingsTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import { ListPlaidItemsResponse } from "@workspace/api-zod";
import plaidRouter from "../routes/plaid";
import { accountSnapshotOf } from "../lib/accountSnapshot";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const { request } = createTestApp(plaidRouter);

const u = randomUUID().slice(0, 8);
const ids = { chk: "", sav: "", sav2: "", card: "" };

async function wipe() {
  for (const h of [HH, HH_OTHER]) {
    if (!h) continue;
    await db.delete(transactionsTable).where(eq(transactionsTable.householdId, h));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, h));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, h));
  }
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  await wipe();
  const [chase, amex] = await db
    .insert(plaidItemsTable)
    .values([
      { userId: OWNER, householdId: HH, itemId: `wp3-chase-${u}`, accessToken: `access-sandbox-${randomUUID()}`, institutionName: "Chase", institutionSlug: "chase", lastSyncedAt: new Date("2026-10-09T13:00:00Z") },
      { userId: OWNER, householdId: HH, itemId: `wp3-amex-${u}`, accessToken: `access-sandbox-${randomUUID()}`, institutionName: "American Express", institutionSlug: "amex" },
    ])
    .returning({ id: plaidItemsTable.id });
  const accts = await db
    .insert(plaidAccountsTable)
    .values([
      { userId: OWNER, householdId: HH, itemId: chase!.id, accountId: `wp3-chk-${u}`, name: "Total Checking", mask: "5526", type: "depository", subtype: "checking" },
      { userId: OWNER, householdId: HH, itemId: chase!.id, accountId: `wp3-sav-${u}`, name: "Savings", mask: "8801", type: "depository", subtype: "savings" },
      { userId: OWNER, householdId: HH, itemId: chase!.id, accountId: `wp3-sav2-${u}`, name: "Second Savings", mask: "8802", type: "depository", subtype: "savings" },
      { userId: OWNER, householdId: HH, itemId: amex!.id, accountId: `wp3-card-${u}`, name: "Platinum", mask: "1005", type: "credit", subtype: "credit card" },
    ])
    .returning({ id: plaidAccountsTable.id, accountId: plaidAccountsTable.accountId });
  ids.chk = accts[0]!.id;
  ids.sav = accts[1]!.id;
  ids.sav2 = accts[2]!.id;
  ids.card = accts[3]!.id;
  await db.insert(forecastSettingsTable).values({
    userId: OWNER,
    householdId: HH,
    // The household's bank snapshot points at checking, set MANUALLY after
    // the account's own map entry: the manual entry writes only these columns.
    bankSnapshotBalance: "3458.98",
    bankSnapshotAt: new Date("2026-10-02T15:00:00Z"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: ids.chk,
    accountSnapshots: {
      [ids.chk]: { balance: "3100.00", at: "2026-10-01T15:00:00.000Z", source: "plaid", name: "Total Checking", mask: "5526" },
      [ids.sav]: { balance: "0.00", at: "2026-10-06T14:00:00.000Z", source: "plaid", name: "Savings", mask: "8801" },
    },
  });
  // Bank rows: checking's newest is Oct 8; another household's newer row on
  // the same external id never counts.
  await db.insert(transactionsTable).values([
    { userId: OWNER, householdId: HH, occurredOn: "2026-10-08", description: "WP3 NEWEST", amount: "-12.00", source: "plaid:chase", plaidAccountId: `wp3-chk-${u}` },
    { userId: OWNER, householdId: HH, occurredOn: "2026-10-03", description: "WP3 OLDER", amount: "-5.00", source: "plaid:chase", plaidAccountId: `wp3-sav-${u}` },
    { userId: OTHER, householdId: HH_OTHER, occurredOn: "2026-10-09", description: "WP3 NOT OURS", amount: "-1.00", source: "plaid:chase", plaidAccountId: `wp3-chk-${u}` },
  ]);
});
afterAll(wipe);

describe("GET /plaid/items — snapshot and data through (WP3)", () => {
  it("each account carries its last reading by the Chase page's rule; a real zero stays 0.00; none is null", async () => {
    const res = await request("GET", "/plaid/items");
    expect(res.status).toBe(200);
    expect(() => ListPlaidItemsResponse.parse(res.json)).not.toThrow();
    const items = res.json as Array<{ itemId: string; lastBankTxOn: string | null; accounts: Array<{ id: string; snapshot?: unknown }> }>;
    const byId = new Map(items.flatMap((it) => it.accounts.map((a) => [a.id, a.snapshot])));
    // The snapshot account reads the snapshot columns (the newer manual entry), not its stale map entry.
    expect(byId.get(ids.chk)).toEqual({ balance: "3458.98", at: "2026-10-02T15:00:00.000Z", source: "manual" });
    // Any other account reads its own map entry; a real zero is "0.00", never dropped.
    expect(byId.get(ids.sav)).toEqual({ balance: "0.00", at: "2026-10-06T14:00:00.000Z", source: "plaid" });
    // No reading: null (the screen says "not tracked yet"), never borrowed by mask.
    expect(byId.get(ids.sav2)).toBeNull();
    expect(byId.get(ids.card)).toBeNull();
    // Data through: the newest bank row of the household's own accounts.
    const chase = items.find((it) => it.itemId === `wp3-chase-${u}`)!;
    const amex = items.find((it) => it.itemId === `wp3-amex-${u}`)!;
    expect(chase.lastBankTxOn).toBe("2026-10-08");
    expect(amex.lastBankTxOn).toBeNull();
  });
});

describe("accountSnapshotOf (pure)", () => {
  const base = { bankSnapshotBalance: null, bankSnapshotAt: null, bankSnapshotSource: null, bankSnapshotAccountId: null, accountSnapshots: null };
  it("no settings or no entry is null", () => {
    expect(accountSnapshotOf(null, "a")).toBeNull();
    expect(accountSnapshotOf(base, "a")).toBeNull();
  });
  it("the snapshot account with no snapshot columns falls back to its own map entry", () => {
    const s = { ...base, bankSnapshotAccountId: "a", accountSnapshots: { a: { balance: "10.00", at: "2026-10-01T00:00:00.000Z", source: "plaid" as const, name: null, mask: null } } };
    expect(accountSnapshotOf(s, "a")).toEqual({ balance: "10.00", at: "2026-10-01T00:00:00.000Z", source: "plaid" });
  });
  it("an unknown source reads as manual; a blank balance is no reading", () => {
    const s = {
      ...base,
      accountSnapshots: {
        a: { balance: "5.00", at: "2026-10-01T00:00:00.000Z", source: "other" as never, name: null, mask: null },
        b: { balance: "", at: "2026-10-01T00:00:00.000Z", source: "plaid" as const, name: null, mask: null },
      },
    };
    expect(accountSnapshotOf(s, "a")?.source).toBe("manual");
    expect(accountSnapshotOf(s, "b")).toBeNull();
  });
});
