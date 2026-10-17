import { createHash } from "node:crypto";
import { and, desc, eq, getTableColumns, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  importBatchesTable,
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
import { AVALANCHE_PAYMENT_GROUP, AVALANCHE_PAYMENT_NAME } from "../routes/avalanche";

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
 * (W) Everything an import replaces and a restore puts back, as it stands now:
 * the 8 tables by user, the rows the wipe cascades away (by parent id), the
 * milestone links it empties, and the Amex anchor it rewrites. The snapshot
 * stores exactly this; the preview counts it; the fingerprint hashes it.
 */
export async function readImportState(exec: typeof db, userId: string): Promise<ImportSnapshotPayload> {
  const payload = {} as ImportSnapshotPayload;
  for (const key of RESTORE_ORDER) {
    const table = TABLES[key];
    const rows = await exec
      .select()
      .from(table)
      .where(eq((table as any).userId, userId));
    payload[key] = rows;
  }
  // (Task 7, V) What the wipe takes with the parents, and the anchor it rewrites.
  const txnIds = (payload.transactions as Array<{ id: string }>).map((t) => t.id);
  const debtIds = (payload.debts as Array<{ id: string }>).map((d) => d.id);
  const milestones = debtIds.length
    ? await exec
        .select({ id: debtMilestonesTable.id, debtId: debtMilestonesTable.debtId })
        .from(debtMilestonesTable)
        .where(inArray(debtMilestonesTable.debtId, debtIds))
    : [];
  payload.cascade = {
    ...(await cascadeRows(exec, txnIds, debtIds)),
    debtMilestoneLinks: milestones.filter((m): m is { id: string; debtId: string } => m.debtId !== null),
  };
  const [settings] = await exec
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId));
  const prefs = (settings?.preferences ?? null) as Record<string, unknown> | null;
  payload.settings = {
    amexAnchor:
      prefs && Object.prototype.hasOwnProperty.call(prefs, "amexAnchor")
        ? { present: true, value: prefs.amexAnchor }
        : { present: false, value: null },
  };
  return payload;
}

/**
 * Capture every per-user row the importer is about to wipe into one
 * import_snapshots row. Runs INSIDE the import transaction (the `tx` handle is
 * passed in) so the snapshot and the wipe are atomic: either we have a complete
 * pre-import backup AND the import ran, or neither did. Returns the snapshot id.
 * (W) `state`: the reads already made in this transaction (the importer reads
 * once, checks the confirmation against it, and stores it).
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
    state?: ImportSnapshotPayload;
  },
): Promise<string> {
  const payload = opts.state ?? (await readImportState(tx, opts.userId));
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

// ── (W) What the state holds, in counts the screen can say ───────────────────

/** A row the bank sent (Plaid), as against a workbook row or a typed one. */
export function isBankTransaction(t: { source?: unknown; plaidTransactionId?: unknown }): boolean {
  return (
    (typeof t.plaidTransactionId === "string" && t.plaidTransactionId !== "") ||
    String(t.source ?? "").startsWith("plaid")
  );
}

export interface ImportStateSummary {
  transactions: number;
  bankTransactions: number;
  /** First and last day of the bank rows (YYYY-MM-DD); null without bank rows. */
  bankFrom: string | null;
  bankTo: string | null;
  categories: number;
  budgetLines: number;
  debts: number;
  rules: number;
  recurring: number;
  monthlySnapshots: number;
  decisions: number;
  splits: number;
}

export function summarizeImportState(state: ImportSnapshotPayload): ImportStateSummary {
  const txns = (state.transactions ?? []) as Array<{ occurredOn?: unknown; source?: unknown; plaidTransactionId?: unknown }>;
  const bank = txns.filter(isBankTransaction);
  const days = bank.map((t) => String(t.occurredOn ?? "")).filter(Boolean).sort();
  return {
    transactions: txns.length,
    bankTransactions: bank.length,
    bankFrom: days[0] ?? null,
    bankTo: days[days.length - 1] ?? null,
    categories: (state.budgetCategories ?? []).length,
    budgetLines: (state.budgetLines ?? []).length,
    debts: (state.debts ?? []).length,
    rules: (state.mappingRules ?? []).length,
    recurring: (state.recurringItems ?? []).length,
    monthlySnapshots: (state.monthlySnapshots ?? []).length,
    decisions: (state.cascade?.categoryDecisions ?? []).length,
    splits: (state.cascade?.transactionSplits ?? []).length,
  };
}

// ── (W) The state an import leaves, so a restore can tell what changed since ─

/**
 * One short hash per row (every column), per table, plus the milestone links
 * and the Amex anchor. Stored on the import batch when the import commits
 * (`summary.after`). A restore compares the state as it stands with it: any
 * row added, edited or removed since is something the restore would wipe.
 * No clocks are involved, so it is exact.
 */
export interface StateFingerprint {
  v: 1;
  rows: Partial<Record<TableKey | CascadeKey, Record<string, string>>>;
  milestones: Record<string, string>;
  anchor: string;
}

function canon(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]));
  }
  return v === undefined ? null : v;
}
const digest = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(canon(v))).digest("hex").slice(0, 16);

/**
 * What the app writes ON ITS OWN when a page is opened, so it is no change of
 * the person's (found by opening every page after an import, on the fixture):
 *   · `GET /api/debts` records each active debt's balance for the day
 *     (`debt_balance_history`) and fills a missing `debts.original_balance`
 *     (the highest balance seen). Both only describe the debts; a real balance
 *     change shows on the debt row itself, which is compared.
 *   · `GET /api/avalanche/extra` keeps the managed "Avalanche payment"
 *     category and its month line in step with the Avalanche setting (which
 *     the import and the restore do not touch); the next read rebuilds them.
 * A restore removes these with the import's rows, and the app writes them
 * again for the data put back, so they are left out of the comparison. Every
 * other row and column is compared (the nightly budget pass is not on read and
 * still counts as a change).
 */
const DERIVED_DEBT_COLUMNS = ["originalBalance"] as const;
const isManagedCategory = (c: Record<string, unknown>) =>
  c.name === AVALANCHE_PAYMENT_NAME && c.groupName === AVALANCHE_PAYMENT_GROUP;

export function fingerprintOf(state: ImportSnapshotPayload): StateFingerprint {
  const rows: StateFingerprint["rows"] = {};
  const managedCats = new Set(
    ((state.budgetCategories ?? []) as Array<Record<string, unknown>>).filter(isManagedCategory).map((c) => String(c.id)),
  );
  const keep = (key: TableKey | CascadeKey, r: Record<string, unknown>): Record<string, unknown> | null => {
    if (key === "budgetCategories" && managedCats.has(String(r.id))) return null;
    if (key === "budgetLines" && managedCats.has(String(r.categoryId))) return null;
    if (key === "debts") {
      const out = { ...r };
      for (const col of DERIVED_DEBT_COLUMNS) delete out[col];
      return out;
    }
    return r;
  };
  const put = (key: TableKey | CascadeKey, list: unknown[]) => {
    const m: Record<string, string> = {};
    for (const r of list as Array<Record<string, unknown>>) {
      const kept = keep(key, r);
      if (kept) m[String(r.id)] = digest(kept);
    }
    rows[key] = m;
  };
  for (const key of RESTORE_ORDER) put(key, state[key] ?? []);
  for (const key of CASCADE_ORDER) {
    if (key === "debtBalanceHistory") continue;
    put(key, state.cascade?.[key] ?? []);
  }
  const milestones: Record<string, string> = {};
  for (const m of state.cascade?.debtMilestoneLinks ?? []) milestones[m.id] = m.debtId;
  return { v: 1, rows, milestones, anchor: digest(state.settings?.amexAnchor ?? null) };
}

export interface ImportChanges {
  total: number;
  transactionsAdded: number;
  bankRowsAdded: number;
  transactionsEdited: number;
  transactionsRemoved: number;
  categories: number;
  rules: number;
  debts: number;
  decisions: number;
  plan: number;
  other: number;
}

const CHANGE_GROUP: Record<Exclude<TableKey, "transactions"> | CascadeKey, Exclude<keyof ImportChanges, "total" | "transactionsAdded" | "bankRowsAdded" | "transactionsEdited" | "transactionsRemoved">> = {
  budgetCategories: "categories",
  mappingRules: "rules",
  debts: "debts",
  debtBalanceHistory: "debts",
  debtStatements: "debts",
  debtLedgerEvents: "debts",
  debtProgressSnapshots: "debts",
  categoryDecisions: "decisions",
  transactionSplits: "decisions",
  budgetMonths: "plan",
  budgetLines: "plan",
  recurringItems: "plan",
  monthlySnapshots: "plan",
};

/** What differs between the state an import left (`after`) and the state now. */
export function changesSince(after: StateFingerprint, nowState: ImportSnapshotPayload): ImportChanges {
  const now = fingerprintOf(nowState);
  const c: ImportChanges = {
    total: 0, transactionsAdded: 0, bankRowsAdded: 0, transactionsEdited: 0, transactionsRemoved: 0,
    categories: 0, rules: 0, debts: 0, decisions: 0, plan: 0, other: 0,
  };
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  for (const key of [...RESTORE_ORDER, ...CASCADE_ORDER]) {
    const a = after.rows[key] ?? {};
    const b = now.rows[key] ?? {};
    const added: string[] = [];
    let edited = 0;
    let removed = 0;
    for (const [id, h] of Object.entries(b)) {
      if (!has(a, id)) added.push(id);
      else if (a[id] !== h) edited++;
    }
    for (const id of Object.keys(a)) if (!has(b, id)) removed++;
    if (key === "transactions") {
      const addedIds = new Set(added);
      c.transactionsAdded = added.length;
      c.bankRowsAdded = (nowState.transactions as Array<{ id: string; source?: unknown; plaidTransactionId?: unknown }>)
        .filter((t) => addedIds.has(t.id) && isBankTransaction(t)).length;
      c.transactionsEdited = edited;
      c.transactionsRemoved = removed;
    } else {
      c[CHANGE_GROUP[key]] += added.length + edited + removed;
    }
  }
  for (const id of new Set([...Object.keys(after.milestones), ...Object.keys(now.milestones)])) {
    if (after.milestones[id] !== now.milestones[id]) c.other++;
  }
  if (after.anchor !== now.anchor) c.other++;
  c.total =
    c.transactionsAdded + c.transactionsEdited + c.transactionsRemoved +
    c.categories + c.rules + c.debts + c.decisions + c.plan + c.other;
  return c;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 new bank rows, 1 edited row" — what a restore would lose, most telling first. */
export function changesWords(c: ImportChanges): string {
  const parts: string[] = [];
  const typed = c.transactionsAdded - c.bankRowsAdded;
  if (c.bankRowsAdded) parts.push(plural(c.bankRowsAdded, "new bank row"));
  if (typed) parts.push(plural(typed, "new row"));
  if (c.transactionsEdited) parts.push(plural(c.transactionsEdited, "edited row"));
  if (c.transactionsRemoved) parts.push(plural(c.transactionsRemoved, "deleted row"));
  if (c.decisions) parts.push(plural(c.decisions, "filing decision"));
  if (c.categories) parts.push(plural(c.categories, "category change"));
  if (c.rules) parts.push(plural(c.rules, "rule change"));
  if (c.debts) parts.push(plural(c.debts, "debt change"));
  if (c.plan) parts.push(plural(c.plan, "plan change"));
  if (c.other) parts.push(plural(c.other, "other change"));
  return parts.join(", ");
}

// The restore's words (short; the screen prints them as they are).
export const RESTORE_WORDS = {
  notFound: "Import not found.",
  alreadyRestored: "This import was already restored.",
  laterImport: "A later import replaced this one. Restore that one first.",
  tooOld: "Too old to restore safely: H2 cannot tell what changed since.",
  changed: (c: ImportChanges) =>
    `Blocked: ${plural(c.total, "change")} since this import would be lost (${changesWords(c)}).`,
  failed: "The restore could not be saved, so nothing was changed.",
} as const;

export type RestoreBlocker = "already_restored" | "later_import" | "too_old" | "changed_since";

interface RestoreCheck {
  status: "ready" | "blocked" | "restored";
  blockedBy: RestoreBlocker | null;
  reason: string | null;
  changes: ImportChanges | null;
  /** The state as it stands (read for the change check); null when not read. */
  now: ImportSnapshotPayload | null;
}

type SnapshotRow = typeof importSnapshotsTable.$inferSelect;

/**
 * (W) May this snapshot be restored without losing anything? In order: it is
 * still available; no later import of this user is still in place (restore
 * that one first); its import recorded the state it left (older imports did
 * not); and nothing changed since. Same check for the preview and the restore.
 */
async function checkRestore(exec: typeof db, snap: SnapshotRow, userId: string): Promise<RestoreCheck> {
  if (snap.status !== "available") {
    return { status: "restored", blockedBy: "already_restored", reason: RESTORE_WORDS.alreadyRestored, changes: null, now: null };
  }
  const [later] = await exec
    .select({ id: importSnapshotsTable.id })
    .from(importSnapshotsTable)
    .where(
      and(
        eq(importSnapshotsTable.userId, userId),
        eq(importSnapshotsTable.status, "available"),
        sql`${importSnapshotsTable.createdAt} > (select s.created_at from import_snapshots s where s.id = ${snap.id})`,
      ),
    )
    .limit(1);
  if (later) {
    return { status: "blocked", blockedBy: "later_import", reason: RESTORE_WORDS.laterImport, changes: null, now: null };
  }
  const [batch] = snap.importBatchId
    ? await exec
        .select({ after: sql<StateFingerprint | null>`${importBatchesTable.summary} -> 'after'` })
        .from(importBatchesTable)
        .where(and(eq(importBatchesTable.id, snap.importBatchId), eq(importBatchesTable.userId, userId)))
    : [];
  const after = batch?.after ?? null;
  if (!after || after.v !== 1) {
    return { status: "blocked", blockedBy: "too_old", reason: RESTORE_WORDS.tooOld, changes: null, now: null };
  }
  const now = await readImportState(exec, userId);
  const changes = changesSince(after, now);
  if (changes.total > 0) {
    return { status: "blocked", blockedBy: "changed_since", reason: RESTORE_WORDS.changed(changes), changes, now };
  }
  return { status: "ready", blockedBy: null, reason: null, changes, now };
}

export interface RestorePreview {
  snapshotId: string;
  batchId: string | null;
  fileName: string | null;
  importedAt: string;
  restoredAt: string | null;
  status: "ready" | "blocked" | "restored";
  blockedBy: RestoreBlocker | null;
  reason: string | null;
  /** What the restore puts back: the state before the import. */
  putsBack: ImportStateSummary;
  /** What it removes: the state as it stands (this import's rows when nothing changed). */
  removes: ImportStateSummary | null;
  changes: ImportChanges | null;
}

/** (W) What restoring this import would do, or why it cannot. Reads only. */
export async function previewImportRestore(
  snapshotId: string,
  userId: string,
): Promise<{ ok: true; preview: RestorePreview } | { ok: false; error: string; status: number }> {
  const [snap] = await db
    .select()
    .from(importSnapshotsTable)
    .where(and(eq(importSnapshotsTable.id, snapshotId), eq(importSnapshotsTable.userId, userId)));
  if (!snap) return { ok: false, error: RESTORE_WORDS.notFound, status: 404 };
  const check = await checkRestore(db, snap, userId);
  const now = check.now ?? (check.status === "restored" ? null : await readImportState(db, userId));
  return {
    ok: true,
    preview: {
      snapshotId: snap.id,
      batchId: snap.importBatchId,
      fileName: snap.filename,
      importedAt: snap.createdAt.toISOString(),
      restoredAt: snap.restoredAt ? snap.restoredAt.toISOString() : null,
      status: check.status,
      blockedBy: check.blockedBy,
      reason: check.reason,
      putsBack: summarizeImportState(snap.payload as ImportSnapshotPayload),
      removes: now ? summarizeImportState(now) : null,
      changes: check.changes,
    },
  };
}

// ── (W) History: the person's imports, newest first ──────────────────────────

export type ImportRestoreState = "available" | "later_import" | "too_old" | "restored" | "none";

export interface ImportHistoryItem {
  batchId: string;
  fileName: string | null;
  importedAt: string;
  /** The import's own counts (null for imports made before they were kept). */
  counts: Record<string, number> | null;
  replaced: ImportStateSummary | null;
  snapshotId: string | null;
  restoredAt: string | null;
  restore: ImportRestoreState;
}

export async function listImportHistory(userId: string, limit: number): Promise<ImportHistoryItem[]> {
  const rows = await db
    .select({
      batchId: importBatchesTable.id,
      fileName: importBatchesTable.filename,
      importedAt: importBatchesTable.createdAt,
      counts: sql<Record<string, number> | null>`${importBatchesTable.summary} -> 'counts'`,
      replaced: sql<ImportStateSummary | null>`${importBatchesTable.summary} -> 'replaced'`,
      checked: sql<boolean>`(${importBatchesTable.summary} -> 'after') is not null`,
      snapshotId: importSnapshotsTable.id,
      snapshotStatus: importSnapshotsTable.status,
      restoredAt: importSnapshotsTable.restoredAt,
    })
    .from(importBatchesTable)
    .leftJoin(
      importSnapshotsTable,
      and(eq(importSnapshotsTable.importBatchId, importBatchesTable.id), eq(importSnapshotsTable.userId, userId)),
    )
    .where(eq(importBatchesTable.userId, userId))
    .orderBy(desc(importBatchesTable.createdAt), desc(importBatchesTable.id))
    .limit(limit);
  // Only the newest import still in place can be restored (each one before it waits for it).
  const [newest] = await db
    .select({ id: importSnapshotsTable.id })
    .from(importSnapshotsTable)
    .where(and(eq(importSnapshotsTable.userId, userId), eq(importSnapshotsTable.status, "available")))
    .orderBy(desc(importSnapshotsTable.createdAt))
    .limit(1);
  return rows.map((r) => ({
    batchId: r.batchId,
    fileName: r.fileName,
    importedAt: r.importedAt.toISOString(),
    counts: r.counts ?? null,
    replaced: r.replaced ?? null,
    snapshotId: r.snapshotId ?? null,
    restoredAt: r.restoredAt ? r.restoredAt.toISOString() : null,
    restore: !r.snapshotId
      ? "none"
      : r.snapshotStatus !== "available"
        ? "restored"
        : r.snapshotId !== newest?.id
          ? "later_import"
          : r.checked
            ? "available"
            : "too_old",
  }));
}

export interface RestoreResult {
  ok: true;
  snapshotId: string;
  counts: Record<string, number>;
}

// Snapshot rows are stored as JSONB, so Date values come back as ISO-8601
// strings. Drizzle's `timestamp` columns expect a Date on insert (they call
// .toISOString()), so revive them to Date. Date-only columns (`date`, stored
// "YYYY-MM-DD") and string-mode timestamps stay strings. (W) Chosen by the
// COLUMN's type: a text value that happened to look like a date-time used to be
// turned into a Date too (and written back in another form).
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const dateColumnsCache = new Map<unknown, Set<string>>();
function dateColumnsOf(table: unknown): Set<string> {
  let cols = dateColumnsCache.get(table);
  if (!cols) {
    cols = new Set(
      Object.entries(getTableColumns(table as typeof transactionsTable))
        .filter(([, c]) => (c as { columnType?: string }).columnType === "PgTimestamp")
        .map(([k]) => k),
    );
    dateColumnsCache.set(table, cols);
  }
  return cols;
}
function reviveSnapshotRow(
  row: Record<string, unknown>,
  table: unknown,
): Record<string, unknown> {
  const dates = dateColumnsOf(table);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = dates.has(k) && typeof v === "string" && ISO_DATETIME.test(v) ? new Date(v) : v;
  }
  return out;
}

/** A refusal decided inside the restore's transaction (it rolls back, nothing written). */
class RestoreRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: RestoreBlocker | "not_found",
    readonly changes: ImportChanges | null = null,
  ) {
    super(message);
  }
}

export type RestoreRefused = {
  ok: false;
  error: string;
  status: number;
  code: RestoreBlocker | "not_found";
  changes: ImportChanges | null;
};

/** (W) The per-person lock the import and the restore both take first. */
export const importLockKey = (userId: string) => `workbook-import:${userId}`;

/**
 * Replay a snapshot: wipe whatever the user has NOW (which is the post-import
 * data) and re-insert the snapshotted rows verbatim, all inside one
 * transaction. Refuses (and writes nothing) when the snapshot is not this
 * user's (404), already restored (409), or (W) when restoring would lose
 * anything: a later import still in place, an import too old to tell, or any
 * change since the import (409, with the count). It takes the person's import
 * lock and then locks the snapshot row, so a second restore (or an import) at
 * the same moment waits, then sees what the first did and is refused.
 */
export async function restoreImportSnapshot(
  snapshotId: string,
  userId: string,
): Promise<RestoreResult | RestoreRefused> {
  try {
    return await db.transaction(async (tx) => {
      // One import or restore at a time per person (the import takes it too).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${importLockKey(userId)}::text))`);
      const [snap] = await tx
        .select()
        .from(importSnapshotsTable)
        .where(and(eq(importSnapshotsTable.id, snapshotId), eq(importSnapshotsTable.userId, userId)))
        .for("update");
      // Don't leak existence of another user's snapshot.
      if (!snap) throw new RestoreRefusal(404, RESTORE_WORDS.notFound, "not_found");
      const check = await checkRestore(tx as unknown as typeof db, snap, userId);
      if (check.status !== "ready") {
        throw new RestoreRefusal(409, check.reason ?? RESTORE_WORDS.alreadyRestored, check.blockedBy ?? "already_restored", check.changes);
      }
      return await replaySnapshot(tx as unknown as typeof db, snap, userId);
    });
  } catch (e) {
    if (e instanceof RestoreRefusal) {
      return { ok: false, error: e.message, status: e.status, code: e.code, changes: e.changes };
    }
    throw e;
  }
}

async function replaySnapshot(tx: typeof db, snap: SnapshotRow, userId: string): Promise<RestoreResult> {
  const snapshotId = snap.id;
  const payload = snap.payload as ImportSnapshotPayload;
  const counts: Record<string, number> = {};

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
      const values = chunk.map((r) => reviveSnapshotRow(r, table));
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
        if (chunk.length) await tx.insert(table).values(chunk.map((r) => reviveSnapshotRow(r, table)) as any);
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

  // (W) The database's clock, as the import's own time is (History lists both).
  await tx
    .update(importSnapshotsTable)
    .set({ status: "restored", restoredAt: sql`now()` })
    .where(eq(importSnapshotsTable.id, snapshotId));

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
