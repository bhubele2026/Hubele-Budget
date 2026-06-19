import { eq } from "drizzle-orm";
import {
  db,
  importSnapshotsTable,
  transactionsTable,
  budgetLinesTable,
  budgetMonthsTable,
  recurringItemsTable,
  mappingRulesTable,
  monthlySnapshotsTable,
  debtsTable,
  budgetCategoriesTable,
} from "@workspace/db";

// The set of per-user tables that POST /api/import/workbook WIPES (see
// lib/workbookImporter.ts → the `tx.delete(...).where(eq(... .userId, userId))`
// block). The snapshot must capture exactly these so a restore returns the
// user to the pre-import state. Order matters for restore: categories are
// re-inserted FIRST because budget lines / recurring items / mapping rules /
// transactions reference category ids; the FKs are nullable / not enforced at
// the column level here, but inserting parents first keeps the data coherent.
//
// Keep this list in lockstep with the importer's wipe block — if a table is
// added to the wipe, add it here too or an accidental import becomes
// unrecoverable for that table.
type TableKey =
  | "budgetCategories"
  | "debts"
  | "budgetMonths"
  | "budgetLines"
  | "recurringItems"
  | "mappingRules"
  | "monthlySnapshots"
  | "transactions";

const TABLES = {
  budgetCategories: budgetCategoriesTable,
  debts: debtsTable,
  budgetMonths: budgetMonthsTable,
  budgetLines: budgetLinesTable,
  recurringItems: recurringItemsTable,
  mappingRules: mappingRulesTable,
  monthlySnapshots: monthlySnapshotsTable,
  transactions: transactionsTable,
} as const;

// Restore order: parents before children (see note above).
const RESTORE_ORDER: TableKey[] = [
  "budgetCategories",
  "debts",
  "budgetMonths",
  "budgetLines",
  "recurringItems",
  "mappingRules",
  "monthlySnapshots",
  "transactions",
];

export type ImportSnapshotPayload = Record<TableKey, unknown[]>;

/**
 * Capture every per-user row the importer is about to wipe into one
 * import_snapshots row. Runs INSIDE the import transaction (the `tx` handle is
 * passed in) so the snapshot and the wipe are atomic: either we have a complete
 * pre-import backup AND the import ran, or neither did. Returns the snapshot id.
 *
 * `tx` is typed loosely (the drizzle transaction handle) to avoid leaking the
 * importer's internal transaction type; it exposes the same `.select()` /
 * `.insert()` surface as `db`.
 */
export async function captureImportSnapshot(
  tx: typeof db,
  opts: {
    userId: string;
    householdId: string;
    importBatchId: string;
    filename: string | null;
  },
): Promise<string> {
  const payload = {} as ImportSnapshotPayload;
  for (const key of RESTORE_ORDER) {
    const table = TABLES[key];
    const rows = await tx
      .select()
      .from(table)
      .where(eq((table as any).userId, opts.userId));
    payload[key] = rows;
  }

  const [row] = await tx
    .insert(importSnapshotsTable)
    .values({
      userId: opts.userId,
      householdId: opts.householdId,
      importBatchId: opts.importBatchId,
      filename: opts.filename,
      payload,
      status: "available",
    })
    .returning({ id: importSnapshotsTable.id });
  return row!.id;
}

export interface RestoreResult {
  ok: true;
  snapshotId: string;
  counts: Record<string, number>;
}

// Snapshot rows are stored as JSONB, so Date values come back as ISO-8601
// strings. Drizzle's `timestamp` columns expect a Date on insert (they call
// .toISOString()), so revive full datetime strings to Date. Date-only columns
// (`date`, stored "YYYY-MM-DD") must stay strings — the `T` guard skips them.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
function reviveSnapshotRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" && ISO_DATETIME.test(v) ? new Date(v) : v;
  }
  return out;
}

/**
 * Replay a snapshot: wipe whatever the user has NOW (which is the post-import
 * data, or a partially-failed import) and re-insert the snapshotted rows
 * verbatim, all inside one transaction. Idempotent at the row level because we
 * insert with the original ids. Refuses to restore a snapshot that isn't
 * 'available' or doesn't belong to the calling user.
 */
export async function restoreImportSnapshot(
  snapshotId: string,
  userId: string,
): Promise<
  RestoreResult | { ok: false; error: string; status?: number }
> {
  const [snap] = await db
    .select()
    .from(importSnapshotsTable)
    .where(eq(importSnapshotsTable.id, snapshotId));

  if (!snap || snap.userId !== userId) {
    // Don't leak existence of another user's snapshot.
    return { ok: false, error: "Snapshot not found", status: 404 };
  }
  if (snap.status !== "available") {
    return {
      ok: false,
      error: `Snapshot is ${snap.status}, not available`,
      status: 409,
    };
  }

  const payload = snap.payload as ImportSnapshotPayload;
  const counts: Record<string, number> = {};

  await db.transaction(async (tx) => {
    // Wipe the user's CURRENT data in the reverse of restore order (children
    // first) so we don't trip any reference while clearing.
    for (const key of [...RESTORE_ORDER].reverse()) {
      const table = TABLES[key];
      await tx.delete(table).where(eq((table as any).userId, userId));
    }

    // Re-insert the snapshotted rows, parents first. Chunk transactions since
    // a power user can have thousands of rows.
    const CHUNK = 500;
    for (const key of RESTORE_ORDER) {
      const table = TABLES[key];
      const rows = (payload[key] ?? []) as Record<string, unknown>[];
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        if (chunk.length === 0) continue;
        await tx.insert(table).values(chunk.map(reviveSnapshotRow) as any);
        inserted += chunk.length;
      }
      counts[key] = inserted;
    }

    await tx
      .update(importSnapshotsTable)
      .set({ status: "restored", restoredAt: new Date() })
      .where(eq(importSnapshotsTable.id, snapshotId));
  });

  return { ok: true, snapshotId, counts };
}
