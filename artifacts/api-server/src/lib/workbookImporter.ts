import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { eq, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  importBatchesTable,
  budgetCategoriesTable,
  budgetMonthsTable,
  budgetLinesTable,
  recurringItemsTable,
  mappingRulesTable,
  transactionsTable,
  monthlySnapshotsTable,
} from "@workspace/db";
import { categorize, directionGuard, type RuleRow } from "./autoCategorize";
import { spendContextOf } from "./spendContext";
import { refreshAmexAnchor } from "./amexAnchor";
import {
  captureImportSnapshot,
  fingerprintOf,
  importLockKey,
  readImportState,
  summarizeImportState,
  type ImportStateSummary,
} from "./importSnapshot";
import { recordRuleChanges, ruleSnapshot, type RuleChange } from "./mappingRuleAudit";

type Row = (string | number | Date | null)[];

/**
 * (Task 7, V) A money cell as a 2-dp string. A blank cell or "—" is 0, as
 * before. A cell that holds text that is not a number used to become 0.00 —
 * a typed figure silently replaced by zero — and now stops the import with
 * the sheet, row and field (`where`), before anything is written. `where:
 * null` keeps the old reading (Monthly Tracking's free-form metrics only).
 */
const toNum = (v: unknown, where: { at: string; field: string } | null): string => {
  if (v === null || v === undefined || v === "" || v === "—") return "0";
  const n =
    typeof v === "number"
      ? v
      : parseFloat(String(v).replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) {
    if (where) {
      throw new WorkbookImportError(
        `${where.at}: the ${where.field} ${JSON.stringify(v instanceof Date ? v.toISOString().slice(0, 10) : v)} is not a number.`,
      );
    }
    return "0";
  }
  return n.toFixed(2);
};

/** "Payments row 14" — the row as the spreadsheet numbers it (1-based). */
const rowAt = (sheetName: string, index: number): string => `${sheetName} row ${index + 1}`;

/**
 * Canonical Amex sign convention (Task #93/#130): expense charges are stored
 * POSITIVE, and payments / credits / income are stored NEGATIVE. Matches
 * `scripts/src/importApril2026Amex.ts` and the
 * `artifacts/h2budget/src/pages/amex.tsx` monthTotals split.
 */
export function amexSignedAmount(typeStr: string, amount: number): string {
  const t = typeStr.toLowerCase();
  const isCredit = t.includes("income") || t.includes("credit");
  const n = isCredit ? -Math.abs(amount) : Math.abs(amount);
  return n.toFixed(2);
}

/**
 * (Task 7, V) What is wrong with the FILE, in words the person can act on. The
 * route answers 400 with this message; any other failure is a 500 that says
 * nothing was changed (the whole import is one transaction).
 */
export class WorkbookImportError extends Error {
  /** (W) Every problem found in the file (the message is the first). */
  readonly problems: string[];
  constructor(message: string, problems?: string[]) {
    super(message);
    this.name = "WorkbookImportError";
    this.problems = problems && problems.length ? problems : [message];
  }
}

/**
 * (W) The confirmation does not match what the import would replace now: the
 * file is another one, or the person's data changed since the preview (a sync
 * added rows). The import refuses; the screen shows a fresh preview.
 */
export class ImportPreviewStaleError extends Error {
  constructor() {
    super("Your data or the file changed since the preview. Upload the file again to see a fresh preview.");
    this.name = "ImportPreviewStaleError";
  }
}

export class AprImportError extends WorkbookImportError {
  constructor(message: string) {
    super(message);
    this.name = "AprImportError";
  }
}

// Normalize a workbook APR cell to a decimal string in [0, 1). Accepts
// 0.2849, 34.99 ("bare percent"), or "34.99%". Throws on values that
// still resolve >= 1.0 after normalization.
export const toAprDecimal = (v: unknown, ctx?: string): string => {
  if (v === null || v === undefined || v === "" || v === "—") return "0";
  let raw: number;
  let hadPercentSign = false;
  if (typeof v === "number") {
    raw = v;
  } else {
    const s = String(v).trim();
    hadPercentSign = s.includes("%");
    raw = parseFloat(s.replace(/[%$,\s]/g, ""));
  }
  if (!Number.isFinite(raw)) return "0";
  const decimal = hadPercentSign || raw >= 1 ? raw / 100 : raw;
  if (!Number.isFinite(decimal) || decimal < 0) {
    throw new AprImportError(
      `Invalid APR ${JSON.stringify(v)}${ctx ? ` for ${ctx}` : ""}: must be >= 0.`,
    );
  }
  if (decimal >= 1) {
    throw new AprImportError(
      `APR ${JSON.stringify(v)}${ctx ? ` for ${ctx}` : ""} normalizes to ${decimal} which is >= 1.0; APRs must be a decimal in [0, 1) (e.g. 0.2499 for 24.99%).`,
    );
  }
  return String(decimal);
};
const toStr = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);
const excelDate = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  // (Task 7, V) SheetJS builds a date cell as a Date in the SERVER's local
  // time, so its calendar day is the local one (toISOString shifted a late
  // evening, or any cell east of UTC, to the next or previous day).
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// Returns a Date with a real time-of-day if the cell carries one, otherwise
// null. Used to populate `transactions.occurred_at` so the Reports hourly
// spending clock can chart real hours instead of fabricating them. Cells
// that resolve to exactly midnight (the common Excel "date only" sentinel)
// are treated as time-less.
const excelDateTime = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  let d: Date | null = null;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === "number") {
    const parts = XLSX.SSF.parse_date_code(v);
    if (!parts) return null;
    d = new Date(
      Date.UTC(
        parts.y,
        parts.m - 1,
        parts.d,
        parts.H ?? 0,
        parts.M ?? 0,
        Math.floor(parts.S ?? 0),
      ),
    );
  } else {
    const parsed = new Date(String(v));
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  }
  if (!d) return null;
  // (Task 7, V) A date cell from SheetJS is local midnight (see excelDate): read
  // its time of day locally, or every date-only cell gets an invented time on
  // a server that is not on UTC. Serial numbers and text are built in UTC above.
  const local = v instanceof Date;
  if (
    (local ? d.getHours() : d.getUTCHours()) === 0 &&
    (local ? d.getMinutes() : d.getUTCMinutes()) === 0 &&
    (local ? d.getSeconds() : d.getUTCSeconds()) === 0
  ) {
    return null;
  }
  return d.toISOString();
};

const sheet = (wb: XLSX.WorkBook, name: string): Row[] => {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    blankrows: false,
  }) as Row[];
};

export type ImportRuleAttribution = {
  ruleId: string;
  pattern: string;
  count: number;
};

export type ImportResult = {
  /** The import_batches row the rows carry (created inside the import's transaction when none was passed). */
  batchId: string;
  counts: Record<string, number>;
  // Id of the pre-import safety snapshot taken before the destructive wipe.
  // Surfaced so the client can offer a one-click "Undo this import" that hits
  // POST /api/import/snapshots/:id/restore. Undefined only if snapshotting was
  // explicitly skipped (e.g. internal seed paths).
  snapshotId?: string;
  // Per-rule attribution breakdown for transactions auto-categorized by the
  // user's mapping_rules during this import. Mirrors the Plaid sync result so
  // the client can render the same "Auto-categorized N: X via 'STARBUCKS', Y
  // via 'AMAZON', …" summary toast with a "View" link to the touched rules
  // on the Mapping Rules page. Excludes rows where the workbook's Target
  // column explicitly named the category (those aren't rule attributions)
  // and rows where a user's manual override was preserved.
  ruleAttributions: ImportRuleAttribution[];
  /** (W) What the import replaced (the snapshot's contents, counted). */
  replaced?: ImportStateSummary;
};

// ── (W) The file, read and checked before anything is written ───────────────

const REQUIRED_SHEETS = [
  "Debt Tracker",
  "Monthly Budget",
  "Recurring Items",
  "Mapping",
  "Payments",
];

/** The problems listed by name; any beyond are counted in one last line. */
const MAX_PROBLEMS = 20;

export interface WorkbookPlan {
  debts: Array<{ name: string; type: string | null; apr: string; balance: string; minPayment: string }>;
  /** Monthly Budget rows, in sheet order: one category and one plan line each. */
  categories: Array<{ name: string; planned: string; note: string | null }>;
  recurring: Array<{
    name: string;
    kind: "debt" | "income" | "bill";
    amount: string;
    frequency: string;
    dayOfMonth: number | null;
    anchorDate: string | null;
    active: "true" | "false";
  }>;
  rules: Array<{ pattern: string; target: string | null }>;
  payments: Array<{
    date: string;
    occurredAt: string | null;
    description: string;
    target: string | null;
    signed: string;
    notes: string | null;
  }>;
  tracking: Array<{ monthStart: string; payload: Record<string, string> }>;
}

/**
 * (W) Read and check the whole workbook, writing nothing. The preview and the
 * import both start here, so a file the preview accepts is the file the import
 * writes, row for row. Every problem is collected (the first is the message);
 * a missing sheet stops at once.
 */
export function planWorkbook(wb: XLSX.WorkBook): WorkbookPlan {
  const missing = REQUIRED_SHEETS.filter((s) => !wb.Sheets[s]);
  if (missing.length) {
    throw new WorkbookImportError(
      `Workbook is missing required sheet(s): ${missing.join(", ")}`,
    );
  }
  const problems: string[] = [];
  const checked = <T,>(fallback: T, read: () => T): T => {
    try {
      return read();
    } catch (e) {
      if (e instanceof WorkbookImportError) {
        problems.push(e.message);
        return fallback;
      }
      throw e;
    }
  };
  const plan: WorkbookPlan = { debts: [], categories: [], recurring: [], rules: [], payments: [], tracking: [] };

  // Debts
  const dt = sheet(wb, "Debt Tracker");
  for (let i = 4; i < dt.length; i++) {
    const r = dt[i];
    if (!r || !r[1] || String(r[1]).toUpperCase() === "TOTALS") continue;
    const name = toStr(r[1]);
    if (!name) continue;
    // In the order the import used to check them: APR, balance, minimum.
    const apr = checked("0", () => toAprDecimal(r[3], `debt "${name}"`));
    const balance = checked("0", () => toNum(r[4], { at: rowAt("Debt Tracker", i), field: "balance" }));
    const minPayment = checked("0", () => toNum(r[5], { at: rowAt("Debt Tracker", i), field: "minimum payment" }));
    plan.debts.push({ name, type: toStr(r[2]), apr, balance, minPayment });
  }

  // Categories (Monthly Budget)
  const mb = sheet(wb, "Monthly Budget");
  for (let i = 5; i < mb.length; i++) {
    const r = mb[i];
    if (!r) continue;
    const num = r[0];
    const label = toStr(r[1]);
    if (!label) continue;
    if (num === null && r[2] === null) continue;
    if (label.toLowerCase().startsWith("subtotal")) continue;
    plan.categories.push({
      name: label,
      planned: checked("0", () => toNum(r[2], { at: rowAt("Monthly Budget", i), field: "amount" })),
      note: toStr(r[6]),
    });
  }

  // Recurring items
  const ri = sheet(wb, "Recurring Items");
  for (let i = 5; i < ri.length; i++) {
    const r = ri[i];
    if (!r) continue;
    const name = toStr(r[1]);
    if (!name) continue;
    const kindRaw = String(r[2] ?? "Expense").toLowerCase();
    const kind = kindRaw.includes("debt")
      ? "debt"
      : kindRaw.includes("income")
        ? "income"
        : "bill";
    // (W) A day the database cannot store (text, a fraction, a date cell) used
    // to fail the whole import with a 500; it is the file's problem, said as
    // such. Every day that imported before still imports.
    let dayOfMonth: number | null = null;
    if (r[5] != null && r[5] !== "") {
      const day = Number(r[5]);
      if (!(r[5] instanceof Date) && Number.isInteger(day) && Math.abs(day) <= 2_147_483_647) dayOfMonth = day;
      else problems.push(`${rowAt("Recurring Items", i)}: the day ${JSON.stringify(r[5] instanceof Date ? r[5].toISOString().slice(0, 10) : r[5])} is not a day of the month.`);
    }
    plan.recurring.push({
      name,
      kind,
      amount: checked("0", () => toNum(r[3], { at: rowAt("Recurring Items", i), field: "amount" })),
      frequency: (toStr(r[4]) ?? "monthly").toLowerCase(),
      dayOfMonth,
      anchorDate: excelDate(r[6]),
      active: (toStr(r[7]) ?? "true").toLowerCase() === "no" ? "false" : "true",
    });
  }

  // Mapping rules
  const mp = sheet(wb, "Mapping");
  for (let i = 4; i < mp.length; i++) {
    const r = mp[i];
    if (!r) continue;
    const pattern = toStr(r[0]);
    if (!pattern) continue;
    plan.rules.push({ pattern, target: toStr(r[1]) });
  }

  // Payments (the Amex card register)
  const pay = sheet(wb, "Payments");
  for (let i = 5; i < pay.length; i++) {
    const r = pay[i];
    if (!r || !r[1]) continue;
    const date = excelDate(r[1]);
    if (!date) continue;
    const typeStr = String(r[3] ?? "Expense").toLowerCase();
    const rawAmount = checked("0", () => toNum(r[5], { at: rowAt("Payments", i), field: "amount" }));
    plan.payments.push({
      date,
      occurredAt: excelDateTime(r[1]),
      description: toStr(r[2]) ?? "(no description)",
      target: toStr(r[4]),
      signed: amexSignedAmount(typeStr, Number(rawAmount)),
      notes: toStr(r[7]),
    });
  }

  // Monthly snapshots (optional sheet)
  const mt = sheet(wb, "Monthly Tracking");
  if (mt.length > 5) {
    const headerRow = mt[4] ?? [];
    const cols: { col: number; monthStart: string }[] = [];
    for (let c = 2; c < headerRow.length; c++) {
      const h = headerRow[c];
      if (!h) continue;
      const d = new Date(`1 ${h}`);
      if (!Number.isNaN(d.getTime())) {
        const ms = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
        cols.push({ col: c, monthStart: ms });
      }
    }
    const byMonth = new Map<string, Record<string, string>>();
    for (let i = 5; i < mt.length; i++) {
      const r = mt[i];
      if (!r) continue;
      const metric = toStr(r[1]);
      if (!metric) continue;
      for (const m of cols) {
        const v = r[m.col];
        if (v === null || v === undefined || v === "") continue;
        const bucket = byMonth.get(m.monthStart) ?? {};
        bucket[metric] = toNum(v, null);
        byMonth.set(m.monthStart, bucket);
      }
    }
    for (const [monthStart, payload] of byMonth) plan.tracking.push({ monthStart, payload });
  }

  if (problems.length) {
    const listed = problems.slice(0, MAX_PROBLEMS);
    if (problems.length > MAX_PROBLEMS) listed.push(`…and ${problems.length - MAX_PROBLEMS} more.`);
    throw new WorkbookImportError(problems[0]!, listed);
  }
  return plan;
}

const SEED_PRIORITY = 0;

/**
 * Merge user-edited mapping rules: keep any prior rule whose priority is
 * higher than the workbook seed (0), or whose (pattern, matchType) the
 * workbook does not redefine. (W) One function for the import and its preview.
 */
export function keptPriorRules<R extends { pattern: string; matchType: string; priority: number }>(
  prior: R[],
  seed: Array<{ pattern: string; matchType: string }>,
): R[] {
  const seedKeys = new Set(seed.map((v) => `${v.pattern}|${v.matchType}`));
  return prior.filter(
    (r) => r.priority > SEED_PRIORITY || !seedKeys.has(`${r.pattern}|${r.matchType}`),
  );
}

/** (W) What the file adds, in the counts the screen says. */
export interface ImportAddSummary {
  transactions: number;
  /** First and last day of the file's rows; null with no rows. */
  from: string | null;
  to: string | null;
  categories: number;
  budgetLines: number;
  debts: number;
  rules: number;
  recurring: number;
  monthlySnapshots: number;
}

export function summarizePlan(plan: WorkbookPlan): ImportAddSummary {
  const days = plan.payments.map((p) => p.date).sort();
  return {
    transactions: plan.payments.length,
    from: days[0] ?? null,
    to: days[days.length - 1] ?? null,
    categories: plan.categories.length,
    budgetLines: plan.categories.length,
    debts: plan.debts.length,
    rules: plan.rules.length,
    recurring: plan.recurring.length,
    monthlySnapshots: plan.tracking.length,
  };
}

/** (W) The file's identity, for the confirmation. */
export function fileSha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * (W) The confirmation the import requires: this person, this file, and what
 * the import would replace (counts and the bank rows' span). Not a secret; it
 * makes the import refuse unless the person was shown exactly what it replaces.
 */
export function confirmTokenOf(userId: string, fileSha: string, replaces: ImportStateSummary): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, userId, fileSha, replaces }))
    .digest("hex")
    .slice(0, 32);
}

export interface ImportPreview {
  fileName: string | null;
  confirmToken: string;
  adds: ImportAddSummary;
  replaces: ImportStateSummary;
  /** Rules of the person's that survive the import (re-pointed by name). */
  rulesKept: number;
}

/**
 * (W) The dry run: the same reading and checks as the import, then the
 * person's data read (not written) to say what the import would replace.
 * Writes nothing at all.
 */
export async function previewWorkbookImport(
  userId: string,
  wb: XLSX.WorkBook,
  opts: { fileSha: string; filename?: string | null; plan?: WorkbookPlan },
): Promise<ImportPreview> {
  const plan = opts.plan ?? planWorkbook(wb);
  // One consistent reading, in a READ ONLY transaction: Postgres itself
  // refuses any write here.
  const state = await db.transaction(
    async (tx) => readImportState(tx as unknown as typeof db, userId),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const replaces = summarizeImportState(state);
  const priorRules = state.mappingRules as Array<{ pattern: string; matchType: string; priority: number }>;
  return {
    fileName: opts.filename ?? null,
    confirmToken: confirmTokenOf(userId, opts.fileSha, replaces),
    adds: summarizePlan(plan),
    replaces,
    rulesKept: keptPriorRules(priorRules, plan.rules.map((r) => ({ pattern: r.pattern, matchType: "contains" }))).length,
  };
}

export async function importWorkbook(
  userId: string,
  householdId: string,
  wb: XLSX.WorkBook,
  /**
   * The batch the rows belong to. (Task 7, V) `null`: the import creates it
   * inside its own transaction, so a failed import leaves no batch row behind
   * (`POST /import/workbook` passes null).
   */
  batchIdIn: string | null,
  opts?: {
    filename?: string | null;
    /** (W) The file already read and checked (the route checks it before the confirmation). */
    plan?: WorkbookPlan;
    /** (W) The preview's confirmation: refused unless it still matches. */
    confirm?: { token: string; fileSha: string };
  },
): Promise<ImportResult> {
  // (W) The whole file is read and checked before the first write.
  const plan = opts?.plan ?? planWorkbook(wb);

  const counts: Record<string, number> = {};
  // Per-rule attribution counter — credited only for rows where the
  // workbook's Target column was empty AND the auto-categorize pipeline
  // matched a rule. Rows whose Target was hard-coded in the spreadsheet
  // and rows where a manual override was preserved are NOT attributed
  // (the user didn't rely on the rule there). Map insertion order acts
  // as a stable tiebreaker when counts tie.
  const attributionCounts = new Map<
    string,
    { ruleId: string; pattern: string; count: number }
  >();

  return await db.transaction(async (tx) => {
    // (W) One import or restore at a time per person: a second one waits here,
    // then reads what the first left (so its confirmation no longer matches).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${importLockKey(userId)}::text))`);
    // (W) What the import replaces, read once: the confirmation is checked
    // against it, and it is the snapshot.
    const state = await readImportState(tx as unknown as typeof db, userId);
    const replaced = summarizeImportState(state);
    if (opts?.confirm && confirmTokenOf(userId, opts.confirm.fileSha, replaced) !== opts.confirm.token) {
      throw new ImportPreviewStaleError();
    }

    const batchId =
      batchIdIn ??
      (
        await tx
          .insert(importBatchesTable)
          .values({ userId, householdId, filename: opts?.filename ?? null })
          .returning({ id: importBatchesTable.id })
      )[0]!.id;
    // Snapshot data we want to merge BEFORE wiping, so user-edited mapping
    // rules and manual transaction category overrides survive a re-import.
    const priorCats = await tx
      .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, userId));
    const priorCatNameById = new Map(priorCats.map((c) => [c.id, c.name]));

    const priorRules = await tx
      .select({
        pattern: mappingRulesTable.pattern,
        matchType: mappingRulesTable.matchType,
        categoryId: mappingRulesTable.categoryId,
        priority: mappingRulesTable.priority,
      })
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, userId));

    const priorTx = await tx
      .select({
        occurredOn: transactionsTable.occurredOn,
        description: transactionsTable.description,
        amount: transactionsTable.amount,
        source: transactionsTable.source,
        categoryId: transactionsTable.categoryId,
        categoryLockedByUser: transactionsTable.categoryLockedByUser,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, userId));
    const priorTxByKey = new Map<string, string | null>();
    // (PR-0) The lock each prior row carried, so a preserved override keeps it.
    const priorLockByKey = new Map<string, boolean>();
    for (const t of priorTx) {
      const key = `${t.occurredOn}|${t.description}|${t.amount}|${t.source}`;
      priorTxByKey.set(key, t.categoryId);
      priorLockByKey.set(key, t.categoryLockedByUser);
    }

    // Pre-import safety snapshot. Capture EVERYTHING we're about to wipe
    // (inside this same transaction, so backup+wipe+import are atomic) so an
    // accidental import is recoverable via POST /api/import/snapshots/:id/restore.
    const snapshotId = await captureImportSnapshot(tx as unknown as typeof db, {
      userId,
      householdId,
      importBatchId: batchId,
      filename: opts?.filename ?? null,
      state,
    });

    // Wipe existing user data so re-imports are deterministic
    await tx.delete(transactionsTable).where(eq(transactionsTable.userId, userId));
    await tx.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, userId));
    await tx.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, userId));
    await tx.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, userId));
    // (WP5b) Every wiped rule is recorded as deleted by this import; the
    // rules re-inserted below are recorded as created (new ids).
    const wipedRules = await tx
      .delete(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, userId))
      .returning();
    await recordRuleChanges(
      tx,
      wipedRules.map(
        (r): RuleChange => ({
          householdId: r.householdId ?? householdId,
          ruleId: r.id,
          action: "deleted",
          actor: userId,
          previous: ruleSnapshot(r),
          next: null,
          note: "Replaced by a workbook import.",
        }),
      ),
    );
    await tx.delete(monthlySnapshotsTable).where(eq(monthlySnapshotsTable.userId, userId));
    await tx.delete(debtsTable).where(eq(debtsTable.userId, userId));
    await tx.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, userId));

    // Debts
    const debtValues: typeof debtsTable.$inferInsert[] = plan.debts.map((d) => ({
      userId,
      householdId,
      name: d.name,
      type: d.type,
      apr: d.apr,
      balance: d.balance,
      minPayment: d.minPayment,
      payment: d.minPayment,
    }));
    const insertedDebts = debtValues.length
      ? await tx.insert(debtsTable).values(debtValues).returning({
          id: debtsTable.id,
          name: debtsTable.name,
        })
      : [];
    counts.debts = insertedDebts.length;
    const debtByName = new Map(insertedDebts.map((d) => [d.name, d.id]));

    // Categories
    const catValues: typeof budgetCategoriesTable.$inferInsert[] = plan.categories.map((c, order) => ({
      userId,
      householdId,
      name: c.name,
      kind: "expense",
      sortOrder: order,
    }));
    const insertedCats = catValues.length
      ? await tx.insert(budgetCategoriesTable).values(catValues).returning({
          id: budgetCategoriesTable.id,
          name: budgetCategoriesTable.name,
          kind: budgetCategoriesTable.kind,
          debtId: budgetCategoriesTable.debtId,
        })
      : [];
    counts.budget_categories = insertedCats.length;
    const catByName = new Map(insertedCats.map((c) => [c.name, c.id]));
    // (WP5d) The categories a rule can file into here, for the direction
    // guard. Every imported category is an expense and every row an Amex card
    // row, so today the guard never fires on an import; it is wired so the
    // insert-time fill has one rule everywhere.
    const importCtx = { spendCtx: spendContextOf(insertedCats), uncategorizedIds: new Set<string>() };

    // Budget month + lines (current month)
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    await tx
      .insert(budgetMonthsTable)
      .values({ userId, householdId, monthStart })
      .onConflictDoNothing();
    counts.budget_months = 1;

    const lineRows = plan.categories
      .filter((l) => catByName.has(l.name))
      .map((l) => ({
        userId,
        householdId,
        monthStart,
        categoryId: catByName.get(l.name)!,
        plannedAmount: l.planned,
        note: l.note,
      }));
    if (lineRows.length) {
      await tx.insert(budgetLinesTable).values(lineRows);
    }
    counts.budget_lines = lineRows.length;

    // Recurring items
    const recValues: typeof recurringItemsTable.$inferInsert[] = plan.recurring.map((r) => ({
      userId,
      householdId,
      name: r.name,
      kind: r.kind,
      amount: r.amount,
      frequency: r.frequency,
      dayOfMonth: r.dayOfMonth,
      anchorDate: r.anchorDate,
      active: r.active,
      categoryId: catByName.get(r.name) ?? null,
    }));
    if (recValues.length) {
      await tx.insert(recurringItemsTable).values(recValues);
    }
    counts.recurring_items = recValues.length;

    // Mapping rules
    const mapValues: Array<typeof mappingRulesTable.$inferInsert & { pattern: string; matchType: string }> = plan.rules.map((r) => ({
      userId,
      householdId,
      pattern: r.pattern,
      matchType: "contains",
      categoryId: r.target ? catByName.get(r.target) ?? null : null,
      priority: 0,
    }));
    const insertedRules = mapValues.length
      ? await tx.insert(mappingRulesTable).values(mapValues).returning({
          id: mappingRulesTable.id,
          pattern: mappingRulesTable.pattern,
          matchType: mappingRulesTable.matchType,
          categoryId: mappingRulesTable.categoryId,
          priority: mappingRulesTable.priority,
        })
      : [];
    counts.mapping_rules = insertedRules.length;

    // Merge user-edited mapping rules (see keptPriorRules). categoryId is
    // re-mapped by category name since wiping budget_categories assigned new ids.
    const preservedRuleRows = keptPriorRules(priorRules, mapValues).map((r) => {
      const oldName = r.categoryId
        ? priorCatNameById.get(r.categoryId) ?? null
        : null;
      const remappedCat = oldName ? catByName.get(oldName) ?? null : null;
      return {
        userId,
        householdId,
        pattern: r.pattern,
        matchType: r.matchType,
        categoryId: remappedCat,
        priority: r.priority,
      };
    });
    const insertedPreservedRules = preservedRuleRows.length
      ? await tx
          .insert(mappingRulesTable)
          .values(preservedRuleRows)
          .returning({
            id: mappingRulesTable.id,
            pattern: mappingRulesTable.pattern,
            matchType: mappingRulesTable.matchType,
            categoryId: mappingRulesTable.categoryId,
            priority: mappingRulesTable.priority,
          })
      : [];
    counts.mapping_rules_preserved = insertedPreservedRules.length;
    await recordRuleChanges(tx, [
      ...insertedRules.map(
        (r): RuleChange => ({
          householdId,
          ruleId: r.id,
          action: "created",
          actor: userId,
          previous: null,
          next: ruleSnapshot(r),
          note: "From the workbook's Mapping sheet.",
        }),
      ),
      ...insertedPreservedRules.map(
        (r): RuleChange => ({
          householdId,
          ruleId: r.id,
          action: "created",
          actor: userId,
          previous: null,
          next: ruleSnapshot(r),
          note: "Kept from before the workbook import.",
        }),
      ),
    ]);

    // Sort highest-priority first so categorize() picks the user's most
    // specific rules before generic ones.
    const ruleRows: RuleRow[] = [...insertedRules, ...insertedPreservedRules].sort(
      (a, b) => b.priority - a.priority,
    );

    // Transactions (Payments sheet → Amex card register).
    // Each row is treated as `source = "amex"` so it shows up on the Amex
    // page and contributes to the Amex bucket of the budget source breakdown.
    // When the workbook leaves Target empty we run the rule engine so the
    // user gets out-of-the-box categorization instead of an uncategorized row.
    const txValues: typeof transactionsTable.$inferInsert[] = [];
    let preservedTxOverrides = 0;
    for (const p of plan.payments) {
      const { date, occurredAt, description, target, signed } = p;
      const explicitCat = target ? catByName.get(target) ?? null : null;
      const auto = explicitCat
        ? {
            categoryId: explicitCat,
            isTransfer: false,
            matchedRuleId: null as string | null,
            matchedRulePattern: null as string | null,
          }
        : categorize(
            { description },
            ruleRows,
            directionGuard(importCtx, { amount: signed, source: "amex", accountType: null }),
          );

      // Preserve manual category overrides: if the prior transaction with
      // the same (date, description, amount, source) had a categoryId that
      // differs from what we'd auto-assign now, treat it as a user edit and
      // keep their choice. Fall back to the opposite-sign key so overrides
      // on rows imported under the pre-Task-#130 (flipped) convention still
      // survive the first re-import after the sign normalization.
      let finalCategoryId = auto.categoryId;
      let manualOverrideKept = false;
      const flippedSigned = (-Number(signed)).toFixed(2);
      let priorKey = `${date}|${description}|${signed}|amex`;
      let priorCatId = priorTxByKey.get(priorKey);
      if (priorCatId === undefined) {
        priorKey = `${date}|${description}|${flippedSigned}|amex`;
        priorCatId = priorTxByKey.get(priorKey);
      }
      if (priorCatId !== undefined) {
        const priorName = priorCatId
          ? priorCatNameById.get(priorCatId) ?? null
          : null;
        const remappedPrior = priorName ? catByName.get(priorName) ?? null : null;
        if ((remappedPrior ?? null) !== (auto.categoryId ?? null)) {
          finalCategoryId = remappedPrior;
          preservedTxOverrides++;
          manualOverrideKept = true;
        }
      }

      // Credit per-rule attribution only when the auto-categorize pipeline
      // actually decided this row's category — i.e. no explicit Target
      // column override and no preserved manual override. Otherwise the
      // toast would mislead users into thinking the rule covered rows it
      // never touched.
      if (
        !manualOverrideKept &&
        !explicitCat &&
        auto.matchedRuleId &&
        auto.matchedRulePattern
      ) {
        const existing = attributionCounts.get(auto.matchedRuleId);
        if (existing) {
          existing.count += 1;
        } else {
          attributionCounts.set(auto.matchedRuleId, {
            ruleId: auto.matchedRuleId,
            pattern: auto.matchedRulePattern,
            count: 1,
          });
        }
      }

      txValues.push({
        userId,
        householdId,
        occurredOn: date,
        occurredAt,
        description,
        amount: signed,
        categoryId: finalCategoryId,
        // (PR-0) Locked when a person chose the category: the sheet row
        // named it in Target, or a prior row's override was kept (with the
        // lock that row had). A category the rules picked is not locked.
        categoryLockedByUser: manualOverrideKept
          ? priorLockByKey.get(priorKey) === true && finalCategoryId !== null
          : explicitCat !== null && finalCategoryId === explicitCat,
        isTransfer: auto.isTransfer,
        source: "amex",
        importBatchId: batchId,
        notes: p.notes,
      });
    }
    const CHUNK = 500;
    let txInserted = 0;
    for (let i = 0; i < txValues.length; i += CHUNK) {
      const chunk = txValues.slice(i, i + CHUNK);
      await tx.insert(transactionsTable).values(chunk);
      txInserted += chunk.length;
    }
    counts.transactions = txInserted;
    counts.transactions_preserved = preservedTxOverrides;

    // Monthly snapshots (optional sheet)
    const snapValues: typeof monthlySnapshotsTable.$inferInsert[] = plan.tracking.map((t) => ({
      userId,
      householdId,
      monthStart: t.monthStart,
      payload: t.payload,
    }));
    if (snapValues.length) {
      await tx
        .insert(monthlySnapshotsTable)
        .values(snapValues)
        .onConflictDoNothing();
    }
    counts.monthly_snapshots = snapValues.length;

    // Suppress unused-warning for debt mapping (used implicitly by future features)
    void debtByName;

    // Auto-update the Amex anchor (debt.balance + settings.preferences.amexAnchor)
    // to match the workbook we just imported. `adopt: true` because the
    // debts table was wiped above, so any prior auto-vs-manual distinction
    // no longer applies.
    const anchor = await refreshAmexAnchor(userId, tx, { adopt: true });
    counts.amex_anchor_updated = anchor.changed ? 1 : 0;

    // (W) What this import replaced and the state it leaves, on its batch:
    // the history says the first, a restore compares against the second
    // (anything added, edited or removed since would be lost by a restore).
    const after = fingerprintOf(await readImportState(tx as unknown as typeof db, userId));
    await tx
      .update(importBatchesTable)
      .set({ summary: { v: 1, counts, replaced, after } })
      .where(eq(importBatchesTable.id, batchId));

    // Sort attributions by count desc; insertion order (rule-first-hit
    // order) is the natural tiebreaker because Map preserves it.
    const ruleAttributions: ImportRuleAttribution[] = Array.from(
      attributionCounts.values(),
    ).sort((a, b) => b.count - a.count);

    return { batchId, counts, ruleAttributions, snapshotId, replaced };
  });
}
