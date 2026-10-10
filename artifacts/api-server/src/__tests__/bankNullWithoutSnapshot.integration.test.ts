// (WP10) No bank snapshot, no bank balance — null on every reader, never "0.00"
// (owner's decision, 2026-10-10).
//
// Without a snapshot the cash signal used to report `bankToday` as the
// household's starting balance — "0.00" by default — and every reader passed it
// on as if it were the bank's: the spine's `bank.balance`, the cash signal, the
// "Why this number?" route's displayed figure. `/transactions/balances` already
// answered null. Now all four agree: null, with the forecast curve still running
// off the starting balance (`startingBalance`, `status: no_data`). With a
// snapshot they agree on the number, as before.
//
// (WP9b) The avalanche schedule's `bankBalance` joins them: it said 0 with no
// snapshot (`Number(bankToday) || 0`); now null (spec nullable), and with a
// snapshot the same number as the spine.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const users = {
  none: `nullbank-none-${process.pid}-${randomUUID().slice(0, 8)}`,
  start: `nullbank-start-${process.pid}-${randomUUID().slice(0, 8)}`,
  snap: `nullbank-snap-${process.pid}-${randomUUID().slice(0, 8)}`,
};
const households: Record<string, string> = {};
let current = users.none;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = current;
    req.actualUserId = current;
    req.householdId = households[current];
    req.householdOwnerId = current;
    next();
  },
}));

import { db, forecastSettingsTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import { GetForecastAvalancheScheduleResponse } from "@workspace/api-zod";
import spineRouter from "../routes/spine";
import forecastRouter from "../routes/forecast";
import bankBalanceExplainRouter from "../routes/bankBalanceExplain";
import transactionsLedgerRouter from "../routes/transactionsLedger";
import { householdTodayISO } from "../lib/householdClock";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
for (const r of [spineRouter, forecastRouter, bankBalanceExplainRouter, transactionsLedgerRouter]) app.use(r);

let server: Server;
let baseUrl = "";

async function cleanup(): Promise<void> {
  for (const u of Object.values(users)) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, u));
    await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, u));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
}

async function linkChecking(user: string): Promise<string> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: user,
      householdId: households[user]!,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning({ id: plaidItemsTable.id });
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: user,
      householdId: households[user]!,
      itemId: item!.id,
      accountId: `acct-${randomUUID()}`,
      name: "Chase Total Checking",
      mask: "5526",
      type: "depository",
      subtype: "checking",
    })
    .returning({ id: plaidAccountsTable.id });
  return acct!.id;
}

beforeAll(async () => {
  for (const u of Object.values(users)) households[u] = (await createTestHousehold(u)).householdId;
  await cleanup();
  // A household with a bank linked and a starting balance set, but no snapshot.
  await linkChecking(users.start);
  await db.insert(forecastSettingsTable).values({ userId: users.start, householdId: households[users.start]!, startingBalance: "750.00" });
  // A household with a snapshot on its checking account.
  const acct = await linkChecking(users.snap);
  await db.insert(forecastSettingsTable).values({
    userId: users.snap,
    householdId: households[users.snap]!,
    bankSnapshotBalance: "4812.37",
    bankSnapshotAt: new Date(Date.now() - 3_600_000),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct,
  });
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

type Readers = { spine: string | null; cash: string | null; explain: string | null; balance: string | null };

async function readers(): Promise<
  Readers & { status: string; startingBalance: string | null; reason: string | null; schedule: number | null }
> {
  const today = householdTodayISO();
  const spine = await get<{ bank: { balance: string | null } }>("/spine");
  const cash = await get<{ bankToday: string | null; status: string; startingBalance: string | null }>(
    "/forecast/cash-signal?horizonDays=90",
  );
  const explain = await get<{ displayed: { bankToday: string | null } }>("/forecast/bank-balance-explain");
  const balances = await get<{ balances: Array<{ date: string; balance: string | null }>; balanceUnavailableReason: string | null }>(
    `/transactions/balances?dates=${today}`,
  );
  // (WP9b) Parsed with the generated response schema: null must be allowed.
  const schedule = GetForecastAvalancheScheduleResponse.parse(await get<unknown>("/forecast/avalanche-schedule"));
  return {
    spine: spine.bank.balance,
    cash: cash.bankToday,
    explain: explain.displayed.bankToday,
    balance: balances.balances[0]!.balance,
    status: cash.status,
    startingBalance: cash.startingBalance,
    reason: balances.balanceUnavailableReason,
    schedule: schedule.bankBalance,
  };
}

describe("(WP10) the bank balance with no snapshot is null on every reader", () => {
  it("an empty household: spine, cash signal, explain, balances and the avalanche schedule all say null — never 0.00", async () => {
    current = users.none;
    const r = await readers();
    expect({ spine: r.spine, cash: r.cash, explain: r.explain, balance: r.balance, schedule: r.schedule }).toEqual({
      spine: null,
      cash: null,
      explain: null,
      balance: null,
      schedule: null,
    });
    expect(r.status).toBe("no_data");
  });

  it("a bank linked and a starting balance set, but no snapshot: still null; the curve keeps the starting balance", async () => {
    current = users.start;
    const r = await readers();
    expect([r.spine, r.cash, r.explain, r.balance, r.schedule]).toEqual([null, null, null, null, null]);
    expect(r.status).toBe("no_data");
    expect(r.startingBalance).toBe("750.00");
    expect(r.reason).toBe("no_snapshot");
  });

  it("with a snapshot, the four readers agree on the number, as before", async () => {
    current = users.snap;
    const r = await readers();
    expect(r.spine).toBe("4812.37");
    expect([r.cash, r.explain, r.balance]).toEqual([r.spine, r.spine, r.spine]);
    // (WP9b) The schedule carries the same number (as a number).
    expect(r.schedule).toBe(4812.37);
    expect(r.status).not.toBe("no_data");
  });
});
