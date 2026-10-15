// ⭐ (F6 round 5) The round 4 review's lows on "an expired pending hold counts
// nowhere", read through the real routes — findings 6 and 3.
//
// One synthetic household (every name, amount and number here is made up).
// Clock: Thu 2026-10-15 12:00 Central — a row dated 10/07 or before is more than
// 7 days old. Checking ••4410 (the snapshot account): 2,000.00 read Fri 10/02
// 09:00 Central.
//
//   9/15  SHELL OIL 57444          −100.00  pending  a leftover hold: its final posted
//   9/16  SHELL SERVICE STATION     −62.40  posted   lower, so the two never paired
//   10/01 CITY CAR RENTAL HOLD      −80.00  pending  held by the 10/02 read
//   10/04 SHELL OIL 57444          −100.00  pending  a hold after the read (expired)
//   10/06 GREEN GROCER              −45.00  posted
//   10/09 Fuel Transaction         +100.00  pending  the 10/04 hold's reversal
//   10/09 ACME CORP PAYROLL      +1,500.00  posted
//   10/13 CORNER CAFE               −12.00  pending  2 days old: counts
//   10/14 Car Rental Transaction    +80.00  pending  the car hold's reversal
//
// Finding 6: round 4 let the OLDEST charge choose (the 9/15 leftover took the
// 10/09 credit, 24 days later). The snapshot holds that leftover, so the credit
// counted (+100) while the 10/04 hold expired alone: the bank read 100 high.
// Round 5: the credit chooses the most recent charge on or before it (10/04).
// Finding 3: the held car hold and its reversal count in the register (net 0,
// no label); GET /transactions and the GET /forecast bundle labelled both
// "expired". Round 5: one test (`heldExpiredPairs`) for all three.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `f6r5-pairs-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
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
    plaid: () => {
      throw new Error("no Plaid calls in this test");
    },
  };
});

import { db, forecastSettingsTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import bankBalanceExplainRouter from "../routes/bankBalanceExplain";
import forecastRouter from "../routes/forecast";
import transactionsRouter from "../routes/transactions";
import transactionsLedgerRouter from "../routes/transactionsLedger";
import { buildBankingReview } from "../lib/bankingReview";
import { computeCashSignal } from "../lib/cashSignal";
import { computeReviewCount } from "../lib/reviewCount";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-15T12:00:00-05:00");
const CHECKING = `acct-f6r5-chk-${randomUUID()}`;
const id: Record<string, string> = {};

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(transactionsRouter);
app.use(transactionsLedgerRouter);
app.use(bankBalanceExplainRouter);
app.use(forecastRouter);

let server: Server;
let baseUrl: string;

async function get<T = any>(p: string): Promise<T> {
  const r = await fetch(`${baseUrl}${p}`);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function withRule<T>(on: boolean, read: () => Promise<T>): Promise<T> {
  if (on) return read();
  vi.stubEnv("EXPIRED_HOLDS_RULE", "off");
  try {
    return await read();
  } finally {
    vi.unstubAllEnvs();
  }
}

const row = (key: string, on: string, description: string, amount: string, pending = false) => ({
  userId: OWNER,
  householdId: HH,
  key,
  occurredOn: on,
  description,
  amount,
  pending,
  plaidAccountId: CHECKING,
  source: "plaid:lakeside",
  plaidTransactionId: `f6r5-${key}-${randomUUID().slice(0, 8)}`,
  forecastFlag: true,
  createdAt: createdAtStartOfHouseholdDay(on),
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  HH = (await createTestHousehold(OWNER)).householdId;
  const base = { userId: OWNER, householdId: HH };
  const [bank] = await db
    .insert(plaidItemsTable)
    .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "t", institutionName: "Lakeside Bank", institutionSlug: "lakeside" })
    .returning();
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: bank!.id, accountId: CHECKING, name: "Everyday Checking", mask: "4410", type: "depository", subtype: "checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2000.00",
    bankSnapshotAt: new Date("2026-10-02T09:00:00-05:00"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chk!.id,
    bankSnapshotMask: "4410",
  });
  const rows = [
    row("leftover", "2026-09-15", "SHELL OIL 57444", "-100.00", true),
    row("leftoverFinal", "2026-09-16", "SHELL SERVICE STATION", "-62.40"),
    row("carHold", "2026-10-01", "CITY CAR RENTAL HOLD", "-80.00", true),
    row("fuelHold", "2026-10-04", "SHELL OIL 57444", "-100.00", true),
    row("grocer", "2026-10-06", "GREEN GROCER", "-45.00"),
    row("fuelBack", "2026-10-09", "Fuel Transaction", "100.00", true),
    row("payroll", "2026-10-09", "ACME CORP PAYROLL", "1500.00"),
    row("cafe", "2026-10-13", "CORNER CAFE", "-12.00", true),
    row("carBack", "2026-10-14", "Car Rental Transaction", "80.00", true),
  ];
  const out = await db
    .insert(transactionsTable)
    .values(rows.map(({ key: _k, ...r }) => r))
    .returning({ id: transactionsTable.id });
  rows.forEach((r, i) => (id[r.key] = out[i]!.id));
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, OWNER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, OWNER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, OWNER));
});

const ids = (...keys: string[]) => keys.map((k) => id[k]!).sort();

describe("⭐ F6 round 5 · the credit chooses its hold; one held-pair test for the register, the list and the bundle", () => {
  it("⭐ finding 6: bank today 3,523.00 = the base (round 4: 3,623.00) — the 10/09 credit reverses the 10/04 hold, not the 9/15 leftover the snapshot holds", async () => {
    // 2,000.00 − 45.00 + 1,500.00 − 12.00 + 80.00 (the car hold the snapshot held, released).
    expect((await computeCashSignal(HH, OWNER, { horizonDays: 30 })).bankToday).toBe("3523.00");
    expect((await withRule(false, () => computeCashSignal(HH, OWNER, { horizonDays: 30 }))).bankToday).toBe("3523.00");
    // "Why this number?": the rows since the read — grocer, payroll, cafe, the car reversal.
    const explain = await get<{ displayed: { bankToday: string }; ledger: { sinceAnchor: { rowCount: number; net: string } } }>("/forecast/bank-balance-explain");
    expect(explain.displayed.bankToday).toBe("3523.00");
    expect(explain.ledger.sinceAnchor).toEqual({ rowCount: 4, net: "1523.00" });
    // The register ties: today's balance, and the fuel hold and its reversal move it by 0.
    type LedgerRowOut = { id: string; balanceReason: string; balanceAmount: string; expiredHold: boolean; expiredPair: boolean };
    const ledger = await get<{ rows: LedgerRowOut[]; balanceToday: string }>("/transactions/ledger?from=2026-09-01&to=2026-10-15&limit=100");
    expect(ledger.balanceToday).toBe("3523.00");
    for (const k of ["fuelHold", "fuelBack", "leftover"]) {
      expect(ledger.rows.find((r) => r.id === id[k]), k).toMatchObject({ balanceReason: "expired", balanceAmount: "0.00", expiredHold: true, expiredPair: false });
    }
    // The Banking review ties to the cent: the car pair in and out (net 0), the fuel pair and the leftover nowhere.
    const review = await buildBankingReview(HH, OWNER, { from: "2026-10-01", to: "2026-10-15", rowsPerBucket: 25, limit: 25 });
    expect(review.cashFlow).toMatchObject({ moneyIn: "1580.00", moneyOut: "137.00", net: "1443.00" });
    expect(review.reconciliation).toMatchObject({ rowsUnexplained: 0, unexplained: "0.00" });
  });

  it("⭐ finding 3: the register, GET /transactions and the GET /forecast bundle name the same rows — the held car pair counted and unlabelled (expiredPair), the other holds expired", async () => {
    type Flags = { id: string; expiredHold: boolean; expiredPair: boolean };
    const flagsOf = (rows: Flags[]) => ({
      expiredHold: rows.filter((r) => r.expiredHold).map((r) => r.id).sort(),
      expiredPair: rows.filter((r) => r.expiredPair).map((r) => r.id).sort(),
    });
    const expected = { expiredHold: ids("leftover", "fuelHold", "fuelBack"), expiredPair: ids("carHold", "carBack") };
    const ledger = await get<{ rows: Array<Flags & { balanceAmount: string; countsInBalance: boolean }> }>("/transactions/ledger?from=2026-09-01&to=2026-10-15&limit=100");
    const list = await get<Flags[]>("/transactions?from=2026-09-01&to=2026-10-15&limit=100");
    const bundle = await get<{ transactions: Flags[] }>("/forecast");
    expect(flagsOf(ledger.rows)).toEqual(expected);
    expect(flagsOf(list)).toEqual(expected);
    expect(flagsOf(bundle.transactions)).toEqual(expected);
    // The register counts the pair at full amount: −80.00 / +80.00.
    expect(ledger.rows.find((r) => r.id === id.carHold)).toMatchObject({ balanceAmount: "-80.00", countsInBalance: true });
    expect(ledger.rows.find((r) => r.id === id.carBack)).toMatchObject({ balanceAmount: "80.00", countsInBalance: true });
    // The review badge (October) never asks about the pair, nor any other expired row: grocer, payroll, cafe.
    expect(await computeReviewCount(HH, OWNER)).toBe(3);
    // The kill switch: no flag anywhere.
    const off = await withRule(false, () => get<Flags[]>("/transactions?from=2026-09-01&to=2026-10-15&limit=100"));
    expect(off.every((r) => !r.expiredHold && !r.expiredPair)).toBe(true);
    const offBundle = await withRule(false, () => get<{ transactions: Flags[] }>("/forecast"));
    expect(offBundle.transactions.every((r) => !r.expiredHold && !r.expiredPair)).toBe(true);
  });

  it("a list page holding only the car hold still knows its reversal (10/14, after the page): counted, unlabelled", async () => {
    const page = await get<Array<{ id: string; expiredHold: boolean; expiredPair: boolean }>>("/transactions?from=2026-10-01&to=2026-10-01&limit=100");
    expect(page.map((r) => [r.id, r.expiredHold, r.expiredPair])).toEqual([[id.carHold, false, true]]);
  });
});
