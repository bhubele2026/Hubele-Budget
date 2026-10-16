import { and, eq, inArray, isNotNull } from "drizzle-orm";
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
  categoryDecisionsTable,
  transactionSplitsTable,
  debtBalanceHistoryTable,
  debtStatementsTable,
  debtLedgerEventsTable,
  debtProgressSnapshotsTable,
  debtMilestonesTable,
  settingsTable,
  type MappingRule,
} from "@workspace/db";
import {
  recordRuleChanges,
  ruleSnapshot,
  sameRule,
  type RuleChange,
} from "./mappingRuleAudit";

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

// Restore order: parents before children (see note above). (Task 7, V) Debts
// come FIRST: `budget_categories.debt_id`, `recurring_items.debt_id` and
// `transactions.debt_id` reference them, so a category tied to a debt could
// not be put back before its debt.
const RESTORE_ORDER: TableKey[] = [
  "debts",
  "budgetCategories",
  "budgetMonths",
  "budgetLines",
  "recurringItems",
  "mappingRules",
  "monthlySnapshots",
  "transactions",
];

/**
 * (Task 7, V) The rows the wipe takes WITH its parents. Deleting the user's
 * transactions cascades their category decisions, splits and debt ledger
 * events; deleting the debts cascades their balance history, statements,
 * ledger events and progress snapshots, and empties `debt_milestones.debt_id`
 * (set null: the milestone is kept). None of these is keyed by user, so they
 * are captured by their parent's id, and put back after the parents.
 */
type CascadeKey =
  | "categoryDecisions"
  | "transactionSplits"
  | "debtBalanceHistory"
  | "debtStatements"
  | "debtProgressSnapshots"
  | "debtLedgerEvents";

const CASCADE_TABLES = {
  categoryDecisions: categoryDecisionsTable,
  transactionSplits: transactionSplitsTable,
  debtBalanceHistory: debtBalanceHistoryTable,
  debtStatements: debtStatementsTable,
  debtProgressSnapshots: debtProgressSnapshotsTable,
  debtLedgerEvents: debtLedgerEventsTable,
} as const;

/** Child order on restore (each after the parents it references). */
const CASCADE_ORDER: CascadeKey[] = [
  "categoryDecisions",
  "transactionSplits",
  "debtBalanceHistory",
  "debtStatements",
  "debtProgressSnapshots",
  "debtLedgerEvents",
];

export type ImportSnapshotPayload = Record<TableKey, unknown[]> & {
  /** (Task 7, V) Absent on snapshots taken before it was captured: those restore the parents only. */
  cascade?: Record<CascadeKey, unknown[]> & {
    /** Milestones whose debt link the wipe set to null: put back on restore. */
    debtMilestoneLinks: Array<{ id: string; debtId: string }>;
  };
  /**
   * (Task 7, V) The settings the import rewrites: `refreshAmexAnchor` replaces
   * `preferences.amexAnchor`. `present: false` = the key was not there.
   */
  settings?: { amexAnchor: { present: boolean; value: unknown } };
};

const CHUNK = 500;

async function cascadeRows(exec: typeof db, txnIds: string[], debtIds: string[]) {
  const out = {} as Record<CascadeKey, unknown[]>;
  const byTxn = async (key: "categoryDecisions" | "transactionSplits") => {
    const table = CASCADE_TABLES[key];
    const rows: unknown[] = [];
    for (let i = 0; i < txnIds.length; i += CHUNK) {
      rows.push(...(await exec.select().from(table).where(inArray(table.transactionId, txnIds.slice(i, i + CHUNK)))));
    }
    return rows;
  };
  const byDebt = async (key: "debtBalanceHistory" | "debtStatements" | "debtProgressSnapshots") => {
    const table = CASCADE_TABLES[key];
    return debtIds.length ? await exec.select().from(table).where(inArray(table.debtId, debtIds)) : [];
  };
  out.categoryDecisions = await byTxn("categoryDecisions");
  out.transactionSplits = await byTxn("transactionSplits");
  out.debtBalanceHistory = await byDebt("debtBalanceHistory");
  out.debtStatements = await byDebt("debtStatements");
  out.debtProgressSnapshots = await byDebt("debtProgressSnapshots");
  // A ledger event goes with its debt OR its transaction.
  const events = new Map<string, unknown>();
  const addEvents = (rows: Array<{ id: string }>) => rows.forEach((r) => events.set(r.id, r));
  if (debtIds.length) {
    addEvents(await exec.select().from(debtLedgerEventsTable).where(inArray(debtLedgerEventsTable.debtId, debtIds)));
  }
  for (let i = 0; i < txnIds.length; i += CHUNK) {
    addEvents(
      await exec
        .select()
        .from(debtLedgerEventsTable)
        .where(and(isNotNull(debtLedgerEventsTable.transactionId), inArray(debtLedgerEventsTable.transactionId, txnIds.slice(i, i + CHUNK)))),
    );
  }
  out.debtLedgerEvents = [...events.values()];
  return out;
}

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
  // (Task 7, V) What the wipe takes with the parents, and the anchor it rewrites.
  const txnIds = (payload.transactions as Array<{ id: string }>).map((t) => t.id);
  const debtIds = (payload.debts as Array<{ id: string }>).map((d) => d.id);
  const milestones = debtIds.length
    ? await tx
        .select({ id: debtMilestonesTable.id, debtId: debtMilestonesTable.debtId })
        .from(debtMilestonesTable)
        .where(inArray(debtMilestonesTable.debtId, debtIds))
    : [];
  payload.cascade = {
    ...(await cascadeRows(tx, txnIds, debtIds)),
    debtMilestoneLinks: milestones.filter((m): m is { id: string; debtId: string } => m.debtId !== null),
  };
  const [settings] = await tx
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, opts.userId));
  const prefs = (settings?.preferences ?? null) as Record<string, unknown> | null;
  payload.settings = {
    amexAnchor:
      prefs && Object.prototype.hasOwnProperty.call(prefs, "amexAnchor")
        ? { present: true, value: prefs.amexAnchor }
        : { present: false, value: null },
  };

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
    // (WP5b) The user's rules as they stand, so the restore can record what it
    // changes in the rule history (below).
    const rulesBefore = await tx
      .select()
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, userId));

    // Wipe the user's CURRENT data in the reverse of restore order (children
    // first) so we don't trip any reference while clearing.
    for (const key of [...RESTORE_ORDER].reverse()) {
      const table = TABLES[key];
      await tx.delete(table).where(eq((table as any).userId, userId));
    }

    // Re-insert the snapshotted rows, parents first. Chunk transactions since
    // a power user can have thousands of rows.
    // (Task 7, V) `transactions.confirmed_by_txn_id` points at another
    // transaction, which may sit in a later chunk: insert without it, then put
    // every link back once all the rows are in.
    const links: Array<{ id: string; confirmedByTxnId: string }> = [];
    for (const key of RESTORE_ORDER) {
      const table = TABLES[key];
      const rows = (payload[key] ?? []) as Record<string, unknown>[];
      let inserted = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        if (chunk.length === 0) continue;
        const values = chunk.map(reviveSnapshotRow);
        if (key === "transactions") {
          for (const v of values) {
            if (typeof v.confirmedByTxnId === "string") {
              links.push({ id: String(v.id), confirmedByTxnId: v.confirmedByTxnId });
              v.confirmedByTxnId = null;
            }
          }
        }
        await tx.insert(table).values(values as any);
        inserted += chunk.length;
      }
      counts[key] = inserted;
    }
    for (const l of links) {
      await tx
        .update(transactionsTable)
        .set({ confirmedByTxnId: l.confirmedByTxnId })
        .where(and(eq(transactionsTable.id, l.id), eq(transactionsTable.userId, userId)));
    }

    // (Task 7, V) The rows the import's wipe cascaded away, after their parents.
    if (payload.cascade) {
      for (const key of CASCADE_ORDER) {
        const table = CASCADE_TABLES[key];
        const rows = (payload.cascade[key] ?? []) as Record<string, unknown>[];
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          if (chunk.length) await tx.insert(table).values(chunk.map(reviveSnapshotRow) as any);
        }
        counts[key] = rows.length;
      }
      const restoredDebtIds = new Set((payload.debts as Array<{ id: string }>).map((d) => d.id));
      for (const m of payload.cascade.debtMilestoneLinks ?? []) {
        if (!restoredDebtIds.has(m.debtId)) continue;
        await tx.update(debtMilestonesTable).set({ debtId: m.debtId }).where(eq(debtMilestonesTable.id, m.id));
      }
    }
    // (Task 7, V) The Amex anchor as it was before the import (the other
    // preferences are left as they are now).
    if (payload.settings) {
      const [cur] = await tx
        .select({ preferences: settingsTable.preferences })
        .from(settingsTable)
        .where(eq(settingsTable.userId, userId));
      if (cur) {
        const next = { ...((cur.preferences ?? {}) as Record<string, unknown>) };
        if (payload.settings.amexAnchor.present) next.amexAnchor = payload.settings.amexAnchor.value;
        else delete next.amexAnchor;
        await tx.update(settingsTable).set({ preferences: next, updatedAt: new Date() }).where(eq(settingsTable.userId, userId));
      }
    }

    await recordRuleChanges(
      tx,
      ruleRestoreChanges(
        rulesBefore,
        (payload.mappingRules ?? []) as Record<string, unknown>[],
        snap.householdId ?? null,
        userId,
      ),
    );

    await tx
      .update(importSnapshotsTable)
      .set({ status: "restored", restoredAt: new Date() })
      .where(eq(importSnapshotsTable.id, snapshotId));
  });

  return { ok: true, snapshotId, counts };
}

const RESTORE_NOTE = "Restored from the snapshot taken before a workbook import.";

/**
 * (WP5b) What a restore did to the rules, as history rows: a rule the restore
 * removed is "deleted", a rule it brought back is "created" (under its
 * original id, so its earlier history continues), and a rule present on both
 * sides but different is "updated". Unchanged rules record nothing. Each rule
 * keeps the `updated_at` it had in the snapshot: a restore puts it back as it
 * was, and its history says when that happened.
 */
function ruleRestoreChanges(
  before: MappingRule[],
  restored: Record<string, unknown>[],
  snapshotHouseholdId: string | null,
  actor: string,
): RuleChange[] {
  const restoredById = new Map(
    restored.map((r) => [
      String(r.id),
      {
        householdId: (r.householdId as string | null | undefined) ?? null,
        state: ruleSnapshot({
          pattern: String(r.pattern ?? ""),
          matchType: String(r.matchType ?? "contains"),
          categoryId: (r.categoryId as string | null | undefined) ?? null,
          priority: Number(r.priority ?? 0),
        }),
      },
    ]),
  );
  const beforeIds = new Set(before.map((r) => r.id));
  const changes: RuleChange[] = [];
  for (const b of before) {
    const householdId = b.householdId ?? snapshotHouseholdId;
    if (!householdId) continue;
    const back = restoredById.get(b.id);
    const previous = ruleSnapshot(b);
    if (!back) {
      changes.push({ householdId, ruleId: b.id, action: "deleted", actor, previous, next: null, note: RESTORE_NOTE });
    } else if (!sameRule(previous, back.state)) {
      changes.push({ householdId, ruleId: b.id, action: "updated", actor, previous, next: back.state, note: RESTORE_NOTE });
    }
  }
  for (const [id, back] of restoredById) {
    if (beforeIds.has(id)) continue;
    const householdId = back.householdId ?? snapshotHouseholdId;
    if (!householdId) continue;
    changes.push({ householdId, ruleId: id, action: "created", actor, previous: null, next: back.state, note: RESTORE_NOTE });
  }
  return changes;
}
