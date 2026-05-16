// (#672) Cross-path per-item serialization guarantee.
//
// Task #671 added a per-item promise chain (syncPlaidItemSerialized)
// so that the three independent triggers that can fire a sync for the
// same Plaid item — the webhook-driven `scheduleSyncForItem` runner,
// the manual "Sync now" route handler, and the frequent forced-refresh
// cron — all queue behind one another instead of racing the cursor.
// Two overlapping syncs against the same access_token would each fetch
// from the same starting cursor, both upsert the same batch, and race
// to write `next_cursor`. Whichever wrote last could rewind the other's
// advance and silently drop the in-between Plaid batch on the *next*
// sync — exactly the regression the user was hitting before #671.
//
// This test proves the chain actually serializes by exercising the two
// most likely-to-race trigger paths back-to-back against the same
// itemRowId:
//   - The scheduler path: scheduleSyncForItem (whose defaultRunner
//     routes through syncPlaidItemSerialized).
//   - The manual-click path: a real HTTP POST to /plaid/sync mounted
//     on the actual Express router (so a regression that reverts the
//     route handler from syncPlaidItemSerialized → syncPlaidItem
//     fails this test deterministically, not just a regression in the
//     scheduler).
// And asserts:
//   1. /transactions/sync is never in flight more than once for the
//      same access_token (i.e. the critical section did not overlap).
//   2. The second sync's /transactions/sync call passes the cursor
//      that the first sync just wrote — proving the second cursor
//      read happened-after the first cursor write, not in parallel.
//   3. Both trigger paths were actually exercised, identified by
//      distinct request markers — so the "both fired" assertion
//      can't be satisfied by retries inside a single run.
//   4. Different items DO overlap in flight (the lock is per-item,
//      not a global mutex that would bottleneck every user).

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const SCHEDULER_USER = `serialize-sched-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const MANUAL_USER = `serialize-manual-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

// Mock requireAuth so the real /plaid/sync route handler resolves an
// authenticated user from the request body marker. Distinct userIds
// per trigger path give every Plaid call a provable provenance tag
// (the userId stamped on transactions / sync_attempts), so the
// "both paths fired" assertion can't be faked by retries within a
// single run.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      body?: { actorUserId?: string };
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    const u = req.body?.actorUserId ?? MANUAL_USER;
    req.userId = u;
    req.actualUserId = u;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = SCHEDULER_USER;
    next();
  },
}));

// Per-token inflight gauge + ordered call log. The mock yields to the
// event loop with a real timer so any race actually has a window to
// interleave; without the awaited delay Node's microtask scheduling
// would mask overlap.
let syncInflightByToken: Map<string, number> = new Map();
let maxConcurrentSyncByToken: Map<string, number> = new Map();
// (4) GLOBAL inflight gauge across all tokens — used to prove the
// different-items test really sees two syncs in flight at the same
// time, not just sequential ones. A global lock regression would
// hold this at 1.
let globalInflight = 0;
let maxGlobalInflight = 0;
type SyncCall = { token: string; cursorIn: string | undefined; cursorOut: string };
let syncCallLog: SyncCall[] = [];
let nextCursorCounter = 0;

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsRefresh: async () => ({ data: {} }),
      transactionsSync: async ({
        access_token,
        cursor,
      }: {
        access_token: string;
        cursor?: string;
      }) => {
        const cur = (syncInflightByToken.get(access_token) ?? 0) + 1;
        syncInflightByToken.set(access_token, cur);
        const peak = Math.max(
          maxConcurrentSyncByToken.get(access_token) ?? 0,
          cur,
        );
        maxConcurrentSyncByToken.set(access_token, peak);
        globalInflight++;
        if (globalInflight > maxGlobalInflight) maxGlobalInflight = globalInflight;
        await new Promise((r) => setTimeout(r, 40));
        nextCursorCounter++;
        const cursorOut = `c${nextCursorCounter}`;
        syncCallLog.push({ token: access_token, cursorIn: cursor, cursorOut });
        syncInflightByToken.set(
          access_token,
          (syncInflightByToken.get(access_token) ?? 1) - 1,
        );
        globalInflight--;
        return {
          data: {
            added: [],
            modified: [],
            removed: [],
            next_cursor: cursorOut,
            has_more: false,
          },
        };
      },
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "x", consent_expiration_time: null } },
      }),
    }),
  };
});

// Tight retry budget so the poll-after-refresh loop in syncPlaidItem
// doesn't dominate test time.
process.env.PLAID_REFRESH_POLL_DELAYS_MS = "5,5";
// Near-instant debounce so scheduleSyncForItem fires promptly.
process.env.PLAID_SYNC_DEBOUNCE_MS = "5";
process.env.PLAID_SYNC_GRACE_DEBOUNCE_MS = "5";

import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  syncPlaidItemSerialized,
  _resetPlaidSyncChainForTests,
} from "../lib/plaidSync";
import {
  scheduleSyncForItem,
  _flushPlaidSyncSchedulerForTests,
  _resetPlaidSyncSchedulerForTests,
} from "../lib/plaidSyncScheduler";
import plaidRouter from "../routes/plaid";
import { createTestHousehold } from "./_helpers/testHousehold";

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  for (const u of [SCHEDULER_USER, MANUAL_USER]) {
    await db
      .delete(transactionsTable)
      .where(eq(transactionsTable.userId, u));
    await db
      .delete(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
}

beforeAll(async () => {
  const h = await createTestHousehold(SCHEDULER_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  // Add MANUAL_USER as a member of the same household so the route's
  // householdId-scoped lookups still resolve to the seeded item.
  await db.execute(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import("drizzle-orm")).sql`
      INSERT INTO household_members (household_id, user_id, role)
      VALUES (${TEST_HOUSEHOLD_ID}, ${MANUAL_USER}, 'member')
      ON CONFLICT DO NOTHING
    `,
  );
  await cleanup();

  // Mount the real plaid router on a minimal Express app — same
  // handler that runs in production. requireAuth is mocked above to
  // tag the request with the test's actorUserId so we can exercise
  // the actual route call site (POST /plaid/sync) without dragging
  // in Clerk.
  const app = express();
  app.use(express.json());
  app.use("/api", plaidRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  _resetPlaidSyncSchedulerForTests();
  _resetPlaidSyncChainForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await cleanup();
  syncInflightByToken = new Map();
  maxConcurrentSyncByToken = new Map();
  globalInflight = 0;
  maxGlobalInflight = 0;
  syncCallLog = [];
  nextCursorCounter = 0;
  _resetPlaidSyncChainForTests();
  _resetPlaidSyncSchedulerForTests();
});

async function seedItem(opts: {
  ownerUserId: string;
}): Promise<{ itemRowId: string; accessToken: string }> {
  const accessToken = `access-sandbox-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: opts.ownerUserId,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken,
      institutionName: "Chase",
      institutionSlug: "chase",
      cursor: "c0",
    })
    .returning();
  await db.insert(plaidAccountsTable).values({
    userId: opts.ownerUserId,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accessToken,
    accountId: `acct-${randomUUID()}`,
    name: "Chase Checking",
    mask: "1234",
    type: "depository",
    subtype: "checking",
  });
  return { itemRowId: item!.id, accessToken };
}

async function postSync(
  itemId: string,
  actorUserId: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/plaid/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemId, actorUserId, force: true }),
  });
}

describe("(#672) per-item sync chain serializes across trigger paths", () => {
  it("scheduler + a real POST /plaid/sync click never overlap, and the second cursor read sees the first cursor write", async () => {
    const { itemRowId, accessToken } = await seedItem({
      ownerUserId: SCHEDULER_USER,
    });

    // Fire the webhook scheduler first. Its defaultRunner is
    // syncPlaidItemSerialized — so a regression that reverts it
    // breaks assertion (1).
    scheduleSyncForItem(SCHEDULER_USER, itemRowId);
    // Immediately hit the actual /plaid/sync route. The route
    // handler in routes/plaid.ts also calls syncPlaidItemSerialized
    // — a regression that reverts THAT call site likewise breaks
    // assertion (1). Hitting the real handler over HTTP (not just
    // calling syncPlaidItemSerialized directly) is what makes this
    // a route-level regression guard.
    const httpClick = postSync(itemRowId, MANUAL_USER);

    const [, httpRes] = await Promise.all([
      _flushPlaidSyncSchedulerForTests(),
      httpClick,
    ]);
    expect(httpRes.status).toBe(200);

    // (1) The critical section never overlapped: at no point were
    // two /transactions/sync calls in flight against the same
    // access_token. This breaks the moment any trigger path goes
    // around the chain.
    expect(maxConcurrentSyncByToken.get(accessToken) ?? 0).toBe(1);

    // (3) Both paths actually fired — proven by the distinct
    // provenance markers. The scheduler stamped its sync_attempt
    // row with SCHEDULER_USER; the route stamped its with
    // MANUAL_USER (via the actorUserId body marker → requireAuth
    // mock → req.userId). If the test were only seeing retries
    // from one path, only one of those userIds would appear.
    const { plaidSyncAttemptsTable } = await import("@workspace/db");
    const attempts = await db
      .select({ userId: plaidSyncAttemptsTable.userId })
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    const actors = new Set(attempts.map((a) => a.userId));
    expect(actors.has(SCHEDULER_USER)).toBe(true);
    expect(actors.has(MANUAL_USER)).toBe(true);

    // Plaid was called at least once per path.
    const callsForToken = syncCallLog.filter((c) => c.token === accessToken);
    expect(callsForToken.length).toBeGreaterThanOrEqual(2);

    // (2) The second cursor read saw the first cursor write. First
    // call started from seeded "c0"; second call must have started
    // from the next_cursor the first call returned, not "c0" again
    // (which is exactly what two overlapping syncs would do).
    expect(callsForToken[0]!.cursorIn).toBe("c0");
    expect(callsForToken[1]!.cursorIn).toBe(callsForToken[0]!.cursorOut);
  });

  it("syncs for *different* items overlap in flight (the lock is per-item, not global)", async () => {
    // Belt-and-suspenders against a future maintainer "fixing" the
    // race by introducing a global mutex — that would bottleneck
    // every user's syncs behind every other user's. We assert
    // GLOBAL concurrency ≥ 2 (two distinct items syncing at the
    // same wall-clock moment), not just per-token non-overlap.
    const a = await seedItem({ ownerUserId: SCHEDULER_USER });
    const b = await seedItem({ ownerUserId: SCHEDULER_USER });

    await Promise.all([
      syncPlaidItemSerialized(SCHEDULER_USER, a.itemRowId, {
        forceRefresh: true,
      }),
      syncPlaidItemSerialized(SCHEDULER_USER, b.itemRowId, {
        forceRefresh: true,
      }),
    ]);

    // Each token's own critical section was still serialized
    // against itself.
    expect(maxConcurrentSyncByToken.get(a.accessToken) ?? 0).toBe(1);
    expect(maxConcurrentSyncByToken.get(b.accessToken) ?? 0).toBe(1);
    // …but globally, the two items were in /transactions/sync at
    // the same time at some point. With the 40ms artificial delay
    // inside the mock and a true per-item lock, this peak must
    // reach 2. A global mutex regression would hold it at 1.
    expect(maxGlobalInflight).toBeGreaterThanOrEqual(2);
  });
});
