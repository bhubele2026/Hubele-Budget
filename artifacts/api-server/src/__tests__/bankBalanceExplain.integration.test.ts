import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

/**
 * The balance explainer. Its whole job is to answer, without production
 * credentials, the question that cost an afternoon: "I pressed Sync and the
 * number didn't move — why?"
 */

const TEST_USER = `bank-explain-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import bankBalanceExplainRouter from "../routes/bankBalanceExplain";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use("/api", bankBalanceExplainRouter);

let server: Server;
let baseUrl: string;

type Explain = {
  displayed: { bankToday: string };
  snapshot: { balance: string | null; mask: string | null; storedAccountId: string | null };
  account: { resolvedExternalId: string | null; via: string };
  nextSync: { willRefreshBalance: boolean; whyNot: string | null };
  ledger: {
    anchorDay: string | null;
    sinceAnchor: { rowCount: number; net: string } | null;
    recentRows: { date: string; description: string; amount: string }[];
  };
  accounts: { externalId: string; isSnapshotAccount: boolean }[];
};

async function explain(): Promise<Explain> {
  const res = await fetch(`${baseUrl}/api/forecast/bank-balance-explain`);
  expect(res.status).toBe(200);
  return (await res.json()) as Explain;
}

async function reset(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

async function seedAccount(opts: {
  externalId: string;
  mask: string | null;
  subtype?: string | null;
}): Promise<{ rowId: string; itemRowId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: opts.externalId,
      name: "TOTAL CHECKING",
      mask: opts.mask,
      type: "depository",
      subtype: opts.subtype ?? "checking",
    })
    .returning();
  return { rowId: acct!.id, itemRowId: item!.id };
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await reset();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await reset();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /forecast/bank-balance-explain", () => {
  it("shows the anchor, the rows stacked on it, and the figure they produce", async () => {
    await reset();
    const { rowId } = await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: rowId,
      bankSnapshotBalance: "4726.97",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-08-21",
      description: "HY-VEE",
      amount: "-442.91",
      plaidAccountId: "chase-5526",
      source: "plaid:chase",
    });

    const e = await explain();
    expect(e.snapshot.balance).toBe("4726.97");
    expect(e.ledger.anchorDay).toBe("2026-08-20");
    expect(e.ledger.sinceAnchor).toEqual({ rowCount: 1, net: "-442.91" });
    // The arithmetic on screen, shown rather than asserted at the user.
    expect(e.displayed.bankToday).toBe("4284.06");
    expect(e.ledger.recentRows[0]!.description).toBe("HY-VEE");
    expect(e.account.via).toBe("pointer");
    expect(e.nextSync.willRefreshBalance).toBe(true);
  });

  it("⭐ names why a Sync will not re-read the balance when nothing identifies the account", async () => {
    // Two checking accounts, no stored pointer, no mask on the snapshot: the
    // recovery ladder cannot pick one, so the balance is frozen. THIS is the
    // sentence that was missing all afternoon.
    await reset();
    await seedAccount({ externalId: "chase-a", mask: null });
    await seedAccount({ externalId: "chase-b", mask: null });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotBalance: "4284.06",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      cashBuffer: "0",
    });

    const e = await explain();
    expect(e.account.resolvedExternalId).toBeNull();
    expect(e.account.via).toBe("unresolved");
    expect(e.nextSync.willRefreshBalance).toBe(false);
    expect(e.nextSync.whyNot).toContain("does not resolve");
    // And the frozen figure is stated plainly beside the reason.
    expect(e.displayed.bankToday).toBe("4284.06");
  });

  it("reports the recovery when the stored pointer is dangling but the mask still names it", async () => {
    await reset();
    await seedAccount({ externalId: "chase-5526", mask: "5526" });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: randomUUID(), // points at nothing
      bankSnapshotBalance: "1000.00",
      bankSnapshotAt: new Date("2026-08-20T12:00:00Z"),
      bankSnapshotSource: "plaid",
      bankSnapshotMask: "5526",
      cashBuffer: "0",
    });

    const e = await explain();
    expect(e.account.resolvedExternalId).toBe("chase-5526");
    expect(e.account.via).toBe("snapshot mask");
    expect(e.nextSync.willRefreshBalance).toBe(true);
    expect(e.accounts.find((a) => a.externalId === "chase-5526")!.isSnapshotAccount).toBe(true);
  });
});
