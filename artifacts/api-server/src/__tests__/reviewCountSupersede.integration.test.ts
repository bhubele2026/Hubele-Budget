// ⭐ (S6 fix 2) The review badge counts a charge once, even when the bank never
// linked its pending row to its posted row.
//
// Spending already reads such a pair once: `findSupersededPendingForRange` says
// which pending row its posted row replaced, the pending row counts nowhere and
// the posted row carries what was put on it (`buildSpendingFacts`, the bank
// register). The badge (`computeReviewCount`) counted both rows, and asked
// again about a posted row whose pending row was already answered. Now it uses
// the same pairs: a replaced pending row is out, and the posted row carries the
// pending row's answer when it has none of its own (the banking review's rule).
//
// Pinned now: Wed 2026-10-07 12:00 Central. Checking ••5526 is the forecast's
// account. Synthetic data only.
//
//   10/05 SHELL OIL 57444   −45.00  pending           (no answer)
//   10/06 SHELL OIL 57444   −47.40  posted, replaced the pending row above
//   10/05 KROGER #442       −20.00  pending           answered "not in the plan"
//   10/06 KROGER #442       −20.00  posted, replaced the pending row above
//   10/06 ACE HARDWARE      −15.00  posted            (no answer)
//   10/06 VERIZON WIRELESS  −80.00  posted            answered "not in the plan"
//
//   badge   before: Shell ×2 + Kroger posted + Ace = 4
//           after:  Shell once + Ace               = 2

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const OWNER = `s6-review-pair-${process.pid}-${randomUUID().slice(0, 8)}`;
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

import {
  db,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import forecastRouter from "../routes/forecast";
import spineRouter from "../routes/spine";
import { computeReviewCount } from "../lib/reviewCount";
import { findSupersededPendingForRange } from "../lib/supersededPending";
import { createTestHousehold } from "./_helpers/testHousehold";

const NOW = new Date("2026-10-07T12:00:00-05:00");
const CHECKING = `acct-chk-${randomUUID()}`;
const id: Record<string, string> = {};

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(forecastRouter);
app.use(spineRouter);

let server: Server;
let baseUrl: string;

async function get<T = any>(p: string): Promise<T> {
  const r = await fetch(`${baseUrl}${p}`);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, OWNER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, OWNER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, OWNER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, OWNER));
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  const base = { userId: OWNER, householdId: HH };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionName: "Chase", institutionSlug: "chase" })
    .returning();
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: item!.id, accountId: CHECKING, name: "Chase Checking", mask: "5526", type: "depository", subtype: "checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: chk!.id,
  });
  const bank = (key: string, occurredOn: string, description: string, amount: string, pending: boolean, createdAt: string) => ({
    ...base,
    occurredOn,
    description,
    amount,
    pending,
    createdAt: new Date(createdAt),
    plaidAccountId: CHECKING,
    source: "plaid:chase",
    key,
  });
  const rows = [
    bank("shellPending", "2026-10-05", "SHELL OIL 57444", "-45.00", true, "2026-10-05T09:00:00-05:00"),
    bank("shell", "2026-10-06", "SHELL OIL 57444", "-47.40", false, "2026-10-06T09:00:00-05:00"),
    bank("krogerPending", "2026-10-05", "KROGER #442", "-20.00", true, "2026-10-05T10:00:00-05:00"),
    bank("kroger", "2026-10-06", "KROGER #442", "-20.00", false, "2026-10-06T10:00:00-05:00"),
    bank("ace", "2026-10-06", "ACE HARDWARE", "-15.00", false, "2026-10-06T11:00:00-05:00"),
    bank("verizon", "2026-10-06", "VERIZON WIRELESS", "-80.00", false, "2026-10-06T12:00:00-05:00"),
  ];
  for (const { key, ...values } of rows) {
    const [r] = await db.insert(transactionsTable).values(values).returning({ id: transactionsTable.id });
    id[key] = r!.id;
  }
  await db.insert(forecastResolutionsTable).values([
    { ...base, status: "ignored_unforecasted", matchedTxnId: id.krogerPending },
    { ...base, status: "ignored_unforecasted", matchedTxnId: id.verizon },
  ]);

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

describe("(S6 fix 2) the review badge counts an unlinked pending/posted pair once", () => {
  it("the fixture: spending's pairs say both pending rows were replaced by their posted rows", async () => {
    const s = await findSupersededPendingForRange(HH, "2026-10-01", "2026-10-31");
    expect([...s.replacedIds].sort()).toEqual([id.shellPending, id.krogerPending].sort());
    expect(s.replacedBy.get(id.shell)?.id).toBe(id.shellPending);
    expect(s.replacedBy.get(id.kroger)?.id).toBe(id.krogerPending);
  });

  it("2 to review (was 4): Shell once, the Kroger answer carries to its posted row, Ace; Verizon is answered", async () => {
    expect(await computeReviewCount(HH, OWNER)).toBe(2);
  });

  it("the nav badge and the spine say the same 2", async () => {
    expect((await get("/forecast/review-count")).count).toBe(2);
    expect((await get("/spine")).reviewCount).toBe(2);
  });

  it("the posted row's own answer decides it: answering the posted Shell row leaves 1", async () => {
    const [a] = await db
      .insert(forecastResolutionsTable)
      .values({ userId: OWNER, householdId: HH, status: "ignored_unforecasted", matchedTxnId: id.shell })
      .returning({ id: forecastResolutionsTable.id });
    try {
      expect(await computeReviewCount(HH, OWNER)).toBe(1);
    } finally {
      await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.id, a!.id));
    }
  });
});
