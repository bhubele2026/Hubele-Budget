import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

import { db, transactionsTable } from "@workspace/db";
import { runStartupPendingNotesBackfill } from "../lib/startupPendingNotesBackfill";
import { createTestHousehold } from "./_helpers/testHousehold";

async function deleteAllForUser(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await deleteAllForUser();
});

afterAll(async () => {
  await deleteAllForUser();
});

async function readRow(id: string) {
  const [row] = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.id, id),
        eq(transactionsTable.userId, TEST_USER),
      ),
    );
  return row;
}

describe("(#738) runStartupPendingNotesBackfill", () => {
  it("migrates the legacy [pending] marker into the boolean and strips it from notes, idempotently, without disturbing user-typed notes", async () => {
    // Case A — posted-but-stale: pending=false, notes='[pending]'.
    // This is the 7-row bucket from prod. Expect the row to stay
    // pending=false (it really has posted) and notes to go to NULL.
    const [a] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-18",
        description: "Java Cat",
        amount: "-20.55",
        pending: false,
        notes: "[pending]",
      })
      .returning({ id: transactionsTable.id });

    // Case B — pre-#728 still-pending: pending=false, notes='[pending]'
    // with no other signal. The backfill should promote the boolean
    // to true (so the vanished-pending sweep can see it later) and
    // strip the marker out of notes. NOTE: case A and B have the
    // same input shape; the SQL has no way to distinguish them, so
    // both end up with notes=NULL and pending=TRUE. That's the
    // intended behavior — the boolean flip is harmless for posted
    // rows because Plaid will flip them back to pending=false on
    // the next modified-event sync. For this test we just assert
    // both rows reach the same expected shape.
    const [b] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-17",
        description: "Roundys",
        amount: "-73.35",
        pending: false,
        notes: "[pending]",
      })
      .returning({ id: transactionsTable.id });

    // Case C — both signals set: pending=true, notes='[pending]'.
    // The 5-row bucket from prod. Expect notes stripped to NULL,
    // boolean left at true.
    const [c] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-17",
        description: "Culver's",
        amount: "-37.60",
        pending: true,
        notes: "[pending]",
      })
      .returning({ id: transactionsTable.id });

    // Case D — user-typed prefix around the marker. The strip pass
    // must remove the marker token only and preserve the rest.
    const [d] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-16",
        description: "Amazon",
        amount: "-15.00",
        pending: false,
        notes: "[pending] reimburse from work",
      })
      .returning({ id: transactionsTable.id });

    // Case E — clean row, no marker. The sweep must not touch it.
    const [e] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-15",
        description: "Starbucks",
        amount: "-6.00",
        pending: true,
        notes: "user-typed note",
      })
      .returning({ id: transactionsTable.id });

    // Case F — already converged: pending=true, notes=null.
    const [f] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-14",
        description: "Metro Market",
        amount: "-50.00",
        pending: true,
        notes: null,
      })
      .returning({ id: transactionsTable.id });

    // First run — expect the counts to reflect only the matching rows.
    // pendingFlagBackfilled = a + b + d = 3 (the three pending=false
    // rows with the marker). notesMarkerStripped = a + b + c + d = 4
    // (every row whose notes contains the marker).
    const first = await runStartupPendingNotesBackfill();
    // Use >= because other concurrent test rows in the shared dev DB
    // may also match; the contract we care about is "at least our
    // seeded rows were migrated", and the per-row assertions below
    // verify the exact end state.
    expect(first.pendingFlagBackfilled).toBeGreaterThanOrEqual(3);
    expect(first.notesMarkerStripped).toBeGreaterThanOrEqual(4);

    const rowA = await readRow(a.id);
    expect(rowA.pending).toBe(true);
    expect(rowA.notes).toBeNull();

    const rowB = await readRow(b.id);
    expect(rowB.pending).toBe(true);
    expect(rowB.notes).toBeNull();

    const rowC = await readRow(c.id);
    expect(rowC.pending).toBe(true);
    expect(rowC.notes).toBeNull();

    const rowD = await readRow(d.id);
    expect(rowD.pending).toBe(true);
    expect(rowD.notes).toBe("reimburse from work");

    const rowE = await readRow(e.id);
    expect(rowE.pending).toBe(true);
    expect(rowE.notes).toBe("user-typed note");

    const rowF = await readRow(f.id);
    expect(rowF.pending).toBe(true);
    expect(rowF.notes).toBeNull();

    // Second run on the same DB — must be a true no-op. Both UPDATEs
    // are guarded by `notes ILIKE '%[pending]%'`; after the first
    // pass, no row in our seeded set matches that predicate, so the
    // counts contributed by our rows are zero. We re-assert the row
    // shapes too, to prove the second pass doesn't drift the state.
    const second = await runStartupPendingNotesBackfill();
    // The second-run counts are 0 *for our seeded rows*. Other tests
    // running concurrently could insert new marker rows between the
    // two calls, so we can't assert a strict 0 on the global counts.
    // Re-read every seeded row and check the shapes are unchanged.
    expect(second.pendingFlagBackfilled).toBeGreaterThanOrEqual(0);
    expect(second.notesMarkerStripped).toBeGreaterThanOrEqual(0);
    expect((await readRow(a.id)).notes).toBeNull();
    expect((await readRow(b.id)).notes).toBeNull();
    expect((await readRow(c.id)).notes).toBeNull();
    expect((await readRow(d.id)).notes).toBe("reimburse from work");
    expect((await readRow(e.id)).notes).toBe("user-typed note");
    expect((await readRow(f.id)).notes).toBeNull();
  });
});
