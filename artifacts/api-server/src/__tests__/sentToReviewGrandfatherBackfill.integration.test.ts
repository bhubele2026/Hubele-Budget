// (#763) Grandfather backfill follow-up to Phase B (#762).
//
// Verifies the one-off backfill script that promotes historical
// transactions into the "already reviewed" state so they don't flood
// the new Review inbox once the gate is live. The two rules:
//
//   Rule 1: any transaction with at least one matching
//           `forecast_resolutions` row gets `sent_to_review_at = NOW()`.
//   Rule 2: any *remaining* transaction whose `occurred_on` is older
//           than 30 days gets `sent_to_review_at = NOW()`.
//
// Recent unresolved rows (<= 30 days, no resolution) must stay NULL so
// the user can triage them in the new flow. The script must also be
// idempotent — a second run must not touch any row whose
// `sent_to_review_at` is already non-NULL.
//
// This test seeds a representative mix of all three categories, runs
// the backfill twice, and asserts the final state plus idempotency.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  db,
  forecastResolutionsTable,
  transactionsTable,
} from "@workspace/db";
import { createTestHousehold } from "./_helpers/testHousehold";
import {
  applyGrandfatherBackfill,
  countGrandfatherCandidates,
  GRANDFATHER_STALE_DAYS,
} from "../lib/sentToReviewGrandfatherBackfill";

const TEST_USER = `grandfather-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, TEST_HOUSEHOLD_ID));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID));
}

beforeAll(async () => {
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
});

async function seedTxn(opts: { occurredOn: string }): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: opts.occurredOn,
      description: "seed",
      amount: "-1.00",
      source: "chase",
    })
    .returning();
  return row!.id;
}

async function seedResolution(txnId: string): Promise<void> {
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    status: "matched",
    matchedTxnId: txnId,
  });
}

async function getSentAt(id: string): Promise<string | null> {
  const [row] = await db
    .select({ sentToReviewAt: transactionsTable.sentToReviewAt })
    .from(transactionsTable)
    .where(eq(transactionsTable.id, id));
  return row?.sentToReviewAt ?? null;
}

describe("grandfather backfill for sent_to_review_at (#763)", () => {
  it("promotes rule-1 + rule-2 rows and leaves recent unresolved NULL, and is idempotent", async () => {
    // Rule 1: recent row that already has a resolution. Should be
    // grandfathered even though it's well within the 30-day window.
    const recentResolved = await seedTxn({ occurredOn: isoDaysAgo(2) });
    await seedResolution(recentResolved);

    // Rule 1: also a stale row with a resolution. Should be picked up
    // by rule 1 (not double-counted under rule 2).
    const staleResolved = await seedTxn({
      occurredOn: isoDaysAgo(GRANDFATHER_STALE_DAYS + 10),
    });
    await seedResolution(staleResolved);

    // Rule 2: stale row, no resolution.
    const staleUnresolved = await seedTxn({
      occurredOn: isoDaysAgo(GRANDFATHER_STALE_DAYS + 5),
    });

    // Survivor: recent row, no resolution. Must remain NULL so the
    // user can triage it in the new Review flow.
    const recentUnresolved = await seedTxn({ occurredOn: isoDaysAgo(3) });

    // Already-promoted row (simulates a row the user has already sent).
    // Must not be touched on either run.
    const alreadySent = await seedTxn({
      occurredOn: isoDaysAgo(GRANDFATHER_STALE_DAYS + 1),
    });
    await db
      .update(transactionsTable)
      .set({ sentToReviewAt: new Date("2024-01-01T00:00:00Z").toISOString() })
      .where(eq(transactionsTable.id, alreadySent));
    const alreadySentTimestamp = await getSentAt(alreadySent);
    expect(alreadySentTimestamp).not.toBeNull();

    // Dry-run counts: rule1=2, rule2=1.
    const counts = await countGrandfatherCandidates();
    const ours = counts.perHousehold.find(
      (h) => h.householdId === TEST_HOUSEHOLD_ID,
    );
    expect(ours).toBeDefined();
    expect(ours!.rule1).toBe(2);
    expect(ours!.rule2).toBe(1);

    // First apply.
    const first = await applyGrandfatherBackfill();
    expect(first.rule1Updated).toBeGreaterThanOrEqual(2);
    expect(first.rule2Updated).toBeGreaterThanOrEqual(1);

    // Final state for our seed rows.
    expect(await getSentAt(recentResolved)).not.toBeNull();
    expect(await getSentAt(staleResolved)).not.toBeNull();
    expect(await getSentAt(staleUnresolved)).not.toBeNull();
    expect(await getSentAt(recentUnresolved)).toBeNull();
    expect(await getSentAt(alreadySent)).toBe(alreadySentTimestamp);

    // Idempotency: nothing in our household should be left to backfill.
    const after = await countGrandfatherCandidates();
    const oursAfter = after.perHousehold.find(
      (h) => h.householdId === TEST_HOUSEHOLD_ID,
    );
    expect(oursAfter?.rule1 ?? 0).toBe(0);
    expect(oursAfter?.rule2 ?? 0).toBe(0);

    // Capture timestamps then re-run apply; existing timestamps must
    // not change.
    const beforeSecondRun = await db
      .select({
        id: transactionsTable.id,
        sentToReviewAt: transactionsTable.sentToReviewAt,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID),
          inArray(transactionsTable.id, [
            recentResolved,
            staleResolved,
            staleUnresolved,
            recentUnresolved,
            alreadySent,
          ]),
        ),
      );

    await applyGrandfatherBackfill();

    const afterSecondRun = await db
      .select({
        id: transactionsTable.id,
        sentToReviewAt: transactionsTable.sentToReviewAt,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID),
          inArray(transactionsTable.id, [
            recentResolved,
            staleResolved,
            staleUnresolved,
            recentUnresolved,
            alreadySent,
          ]),
        ),
      );
    const beforeMap = new Map(
      beforeSecondRun.map((r) => [r.id, r.sentToReviewAt]),
    );
    for (const r of afterSecondRun) {
      expect(r.sentToReviewAt).toBe(beforeMap.get(r.id));
    }

    // And the recent unresolved row is still NULL after re-run.
    const [stillNull] = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.id, recentUnresolved),
          isNull(transactionsTable.sentToReviewAt),
        ),
      );
    expect(stillNull?.id).toBe(recentUnresolved);
  });
});
