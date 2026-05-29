// (#817) Lock in the contract of the one-shot startup Chase "Review
// Bucket" backlog clear (#812). The sweep flips forecast_flag=false on
// genuinely-stuck, already-occurred, non-terminally-resolved Chase
// checking rows for a single household. A regression in the predicate
// could silently zap resolved rows, future-dated rows, or thousands of
// rows at once — these tests pin every guard.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  householdsTable,
  householdMembersTable,
  forecastResolutionsTable,
  transactionsTable,
} from "@workspace/db";
import { runStartupChaseReviewBacklogClear } from "../lib/startupChaseReviewBacklogClear";

// These MUST mirror the constants baked into the production module — the
// sweep only ever touches this exact household + Chase checking account.
const HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";
const CHASE_CHECKING_EXTERNAL_ID = "YEvBBznkA3updAzAk7wyILEPd31z6BSQK184R";
const OWNER_USER = `chase-backlog-owner-${process.pid}-${randomUUID().slice(0, 8)}`;

// Dates relative to "today" so the future-dated carve-out is deterministic.
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const PAST = dayOffset(-30);
const TODAY = dayOffset(0);
const FUTURE = dayOffset(30);

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, HOUSEHOLD_ID));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.householdId, HOUSEHOLD_ID));
}

type SeedTxn = {
  occurredOn?: string;
  forecastFlag?: boolean;
  source?: string;
  plaidAccountId?: string | null;
  sentToReviewAt?: string | null;
};

async function seedTxn(opts: SeedTxn = {}): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: OWNER_USER,
      householdId: HOUSEHOLD_ID,
      occurredOn: opts.occurredOn ?? PAST,
      description: "Chase checking row",
      amount: "-42.00",
      source: opts.source ?? "plaid:chase",
      plaidAccountId:
        opts.plaidAccountId === undefined
          ? CHASE_CHECKING_EXTERNAL_ID
          : opts.plaidAccountId,
      forecastFlag: opts.forecastFlag ?? true,
      sentToReviewAt: opts.sentToReviewAt ?? null,
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

async function addResolution(matchedTxnId: string, status: string): Promise<void> {
  await db.insert(forecastResolutionsTable).values({
    userId: OWNER_USER,
    householdId: HOUSEHOLD_ID,
    status,
    matchedTxnId,
  });
}

async function flagOf(id: string): Promise<boolean> {
  const [row] = await db
    .select({ forecastFlag: transactionsTable.forecastFlag })
    .from(transactionsTable)
    .where(eq(transactionsTable.id, id));
  return row!.forecastFlag;
}

beforeAll(async () => {
  // The sweep is hard-wired to one fixed household id; materialize it.
  await db
    .insert(householdsTable)
    .values({ id: HOUSEHOLD_ID, ownerUserId: OWNER_USER })
    .onConflictDoNothing();
  await db
    .insert(householdMembersTable)
    .values({ userId: OWNER_USER, householdId: HOUSEHOLD_ID, role: "owner" })
    .onConflictDoNothing({ target: householdMembersTable.userId });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await db
    .delete(householdMembersTable)
    .where(eq(householdMembersTable.householdId, HOUSEHOLD_ID));
  await db.delete(householdsTable).where(eq(householdsTable.id, HOUSEHOLD_ID));
});

beforeEach(async () => {
  await cleanup();
});

describe("runStartupChaseReviewBacklogClear (#817)", () => {
  it("clears genuinely-stuck backlog rows but leaves resolved & future rows alone", async () => {
    // Genuinely stuck: flagged, already occurred, no resolution.
    const stuckPast = await seedTxn({ occurredOn: PAST });
    const stuckToday = await seedTxn({ occurredOn: TODAY });
    // Non-terminal resolution ('rescheduled') must NOT protect the row.
    const stuckRescheduled = await seedTxn({ occurredOn: PAST });
    await addResolution(stuckRescheduled, "rescheduled");

    // Terminally resolved rows must be left flagged.
    const matched = await seedTxn({ occurredOn: PAST });
    await addResolution(matched, "matched");
    const ignored = await seedTxn({ occurredOn: PAST });
    await addResolution(ignored, "ignored_unforecasted");
    const unplanned = await seedTxn({ occurredOn: PAST });
    await addResolution(unplanned, "unplanned");

    // Future-dated row must be left flagged.
    const future = await seedTxn({ occurredOn: FUTURE });

    const summary = await runStartupChaseReviewBacklogClear();
    expect(summary.cleared).toBe(3);

    expect(await flagOf(stuckPast)).toBe(false);
    expect(await flagOf(stuckToday)).toBe(false);
    expect(await flagOf(stuckRescheduled)).toBe(false);

    expect(await flagOf(matched)).toBe(true);
    expect(await flagOf(ignored)).toBe(true);
    expect(await flagOf(unplanned)).toBe(true);
    expect(await flagOf(future)).toBe(true);
  });

  it("never touches sentToReviewAt when flipping a backlog row", async () => {
    const id = await seedTxn({
      occurredOn: PAST,
      sentToReviewAt: "2026-05-01T12:00:00.000Z",
    });

    // Read back the persisted value so we compare against the DB's own
    // string representation rather than the literal we passed in.
    const [before] = await db
      .select({ sentToReviewAt: transactionsTable.sentToReviewAt })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, id));
    expect(before!.sentToReviewAt).not.toBeNull();

    const summary = await runStartupChaseReviewBacklogClear();
    expect(summary.cleared).toBe(1);

    const [after] = await db
      .select({
        forecastFlag: transactionsTable.forecastFlag,
        sentToReviewAt: transactionsTable.sentToReviewAt,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, id));
    expect(after!.forecastFlag).toBe(false);
    expect(after!.sentToReviewAt).toBe(before!.sentToReviewAt);
  });

  it("bails out without updating anything when >= 200 rows would clear", async () => {
    const ids: string[] = [];
    const rows = Array.from({ length: 200 }, () => ({
      userId: OWNER_USER,
      householdId: HOUSEHOLD_ID,
      occurredOn: PAST,
      description: "Chase checking bulk row",
      amount: "-1.00",
      source: "plaid:chase",
      plaidAccountId: CHASE_CHECKING_EXTERNAL_ID,
      forecastFlag: true,
    }));
    const inserted = await db
      .insert(transactionsTable)
      .values(rows)
      .returning({ id: transactionsTable.id });
    for (const r of inserted) ids.push(r.id);

    const summary = await runStartupChaseReviewBacklogClear();
    expect(summary.cleared).toBe(0);

    // Every row must still be flagged — the safety guard skipped the update.
    const stillFlagged = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          inArray(transactionsTable.id, ids),
          eq(transactionsTable.forecastFlag, true),
        ),
      );
    expect(stillFlagged.length).toBe(200);
  });

  it("is idempotent — a second run is a no-op", async () => {
    const stuck = await seedTxn({ occurredOn: PAST });

    const first = await runStartupChaseReviewBacklogClear();
    expect(first.cleared).toBe(1);
    expect(await flagOf(stuck)).toBe(false);

    const second = await runStartupChaseReviewBacklogClear();
    expect(second.cleared).toBe(0);
    expect(await flagOf(stuck)).toBe(false);
  });
});
