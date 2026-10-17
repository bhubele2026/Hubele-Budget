// ⭐ (W) THE WORKBOOK IMPORT AS A RECOVERABLE FLOW, THROUGH THE REAL ROUTES.
//
//   preview (writes nothing) → confirm → import (+ snapshot) → history →
//   restore check → restore (refused, with the reason and the count, whenever
//   it would lose anything) — on an isolated test database, with synthetic
//   files from `_helpers/workbookFiles.ts` uploaded as multipart.
//
// Pinned: the dry run writes nothing and its counts are the import's; no
// confirmation → 428; a confirmation that no longer matches → 409; every
// problem in a bad file is listed before anything is written; a failure after
// every row is in, and a failure at the restore's last step, leave nothing;
// any change after the import blocks the restore (exactly: put the change back
// and it is allowed again); a second restore and a concurrent one are refused;
// another person gets 404; restores go newest first; an import from before the
// change record is too old to restore. Synthetic data only. No Plaid, no model,
// no texts.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, count, eq, inArray } from "drizzle-orm";

const TEST_USER = `w-import-${process.pid}-${randomUUID().slice(0, 8)}`;
const MEMBER = `${TEST_USER}-member`;
let TEST_HOUSEHOLD_ID = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string; headers?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    const who = req.headers?.["x-test-user"] === "member" ? MEMBER : TEST_USER;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

// Injected failures, off unless a test turns one on.
const inject = vi.hoisted(() => ({ afterRows: false, restoreLastStep: false }));
vi.mock("../lib/amexAnchor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/amexAnchor")>();
  return {
    ...actual,
    // The importer's last write, after the snapshot, the wipe and every row.
    refreshAmexAnchor: async (...args: Parameters<typeof actual.refreshAmexAnchor>) => {
      if (inject.afterRows) throw new Error("injected: the import fails after every row is in");
      return actual.refreshAmexAnchor(...args);
    },
  };
});
vi.mock("../lib/mappingRuleAudit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mappingRuleAudit")>();
  return {
    ...actual,
    // The restore's last write before its status flip: the rule history.
    recordRuleChanges: async (...args: Parameters<typeof actual.recordRuleChanges>) => {
      if (inject.restoreLastStep && args[1].some((c) => (c.note ?? "").startsWith("Restored"))) {
        throw new Error("injected: the restore fails at its last step");
      }
      return actual.recordRuleChanges(...args);
    },
  };
});

import {
  db,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  categoryDecisionsTable,
  debtBalanceHistoryTable,
  debtsTable,
  importBatchesTable,
  importSnapshotsTable,
  mappingRuleHistoryTable,
  mappingRulesTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { householdToday, weekBounds } from "@workspace/avalanche-core";
import fullRouter from "../routes";
import { createTestHousehold } from "./_helpers/testHousehold";
import { workbookFile, type WorkbookSpec } from "./_helpers/workbookFiles";
import { readImportState, summarizeImportState, type ImportSnapshotPayload } from "../lib/importSnapshot";

// ── The server: the real router under /api ──────────────────────────────────
const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use("/api", fullRouter);
let server: Server;
let base = "";

type Who = "owner" | "member";
type Res = { status: number; json: Record<string, any> | null };
async function send(path: string, file: Buffer, filename: string, opts: { as?: Who; confirm?: string | null } = {}): Promise<Res> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(file)]), filename);
  if (opts.confirm) fd.append("confirm", opts.confirm);
  const res = await fetch(`${base}/api${path}`, { method: "POST", body: fd, headers: opts.as === "member" ? { "x-test-user": "member" } : {} });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}
const previewOf = (file: Buffer, name: string, as: Who = "owner") => send("/import/workbook/preview", file, name, { as });
const importOf = (file: Buffer, name: string, confirm: string | null, as: Who = "owner") => send("/import/workbook", file, name, { as, confirm });
async function previewThenImport(file: Buffer, name: string): Promise<{ preview: Res; result: Res }> {
  const preview = await previewOf(file, name);
  expect(preview.status).toBe(200);
  return { preview, result: await importOf(file, name, String(preview.json!.confirmToken)) };
}
async function api(method: string, path: string, as: Who = "owner"): Promise<Res> {
  const res = await fetch(`${base}/api${path}`, { method, headers: as === "member" ? { "x-test-user": "member" } : {} });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

// ── Dates (the household's) ─────────────────────────────────────────────────
const TODAY = householdToday(new Date());
const WEEK = weekBounds(TODAY);
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
const OLD_A = "2026-08-03";
const OLD_B = "2026-08-21";

// ── The household before any import: what every restore must return to ─────
const RUN = randomUUID().slice(0, 8);
const CHECKING = `w-chk-${RUN}`;
const ids: Record<string, string> = {};
async function seed(): Promise<void> {
  const hh = TEST_HOUSEHOLD_ID;
  const own = { userId: TEST_USER, householdId: hh };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...own, itemId: `w-item-${RUN}`, accessToken: `access-sandbox-${RUN}`, institutionName: "Synthetic Bank", institutionSlug: "synthetic" })
    .returning();
  await db.insert(plaidAccountsTable).values({ ...own, itemId: item!.id, accountId: CHECKING, name: "Synth Checking", mask: "0202", type: "depository", subtype: "checking" });
  const [debt] = await db.insert(debtsTable).values({ ...own, name: "Synth Loan", balance: "900.00", apr: "0.0500", minPayment: "50.00", payment: "50.00", type: "loan" }).returning();
  const [cat] = await db.insert(budgetCategoriesTable).values({ ...own, name: "Synth Groceries", kind: "expense", groupName: "Prior" }).returning();
  await db.insert(budgetCategoriesTable).values({ ...own, name: "Synth Fuel", kind: "expense", groupName: "Prior" });
  ids.cat = cat!.id;
  ids.debt = debt!.id;
  await db.insert(budgetMonthsTable).values({ ...own, monthStart: MONTH_START });
  await db.insert(budgetLinesTable).values({ ...own, monthStart: MONTH_START, categoryId: cat!.id, plannedAmount: "300.00" });
  await db.insert(recurringItemsTable).values({ ...own, name: "Synth Rent", kind: "bill", amount: "800.00", frequency: "monthly", dayOfMonth: 1, active: "true" });
  await db.insert(mappingRulesTable).values({ ...own, pattern: "SYNTH GROCER", matchType: "contains", categoryId: cat!.id, priority: 5 });
  const bank = await db
    .insert(transactionsTable)
    .values([
      { ...own, occurredOn: OLD_A, description: "SYNTH GROCER 1", amount: "-31.00", source: "plaid:synthetic", plaidAccountId: CHECKING, plaidTransactionId: `w-b1-${RUN}`, categoryId: cat!.id },
      { ...own, occurredOn: OLD_B, description: "SYNTH FUEL 2", amount: "-22.50", source: "plaid:synthetic", plaidAccountId: CHECKING, plaidTransactionId: `w-b2-${RUN}` },
      { ...own, occurredOn: TODAY, description: "SYNTH GROCER 3", amount: "-18.40", source: "plaid:synthetic", plaidAccountId: CHECKING, plaidTransactionId: `w-b3-${RUN}`, categoryId: cat!.id, weeklyAllowance: true },
    ])
    .returning();
  await db.insert(transactionsTable).values({ ...own, occurredOn: TODAY, description: "SYNTH TYPED CASH", amount: "6.00", source: "manual", categoryId: cat!.id, categoryLockedByUser: true });
  await db.insert(categoryDecisionsTable).values({ householdId: hh, transactionId: bank[0]!.id, source: "user", categoryId: cat!.id, confidence: "1.000", band: "auto", explanation: "Filed by hand.", inputHash: `w-${RUN}` });
  await db
    .insert(settingsTable)
    .values({ userId: TEST_USER, householdId: hh, preferences: { keepMe: "unchanged" } })
    .onConflictDoUpdate({ target: settingsTable.userId, set: { preferences: { keepMe: "unchanged" } } });
}

// ── Everything an import replaces, read back in full ────────────────────────
const sortById = (rows: unknown[]) => [...(rows as Array<{ id: string }>)].sort((a, b) => a.id.localeCompare(b.id));
async function userState() {
  const s: ImportSnapshotPayload = await readImportState(db, TEST_USER);
  const norm = (rows: unknown[] | undefined) => sortById(rows ?? []);
  return {
    budgetCategories: norm(s.budgetCategories),
    debts: norm(s.debts),
    budgetMonths: norm(s.budgetMonths),
    budgetLines: norm(s.budgetLines),
    recurringItems: norm(s.recurringItems),
    mappingRules: norm(s.mappingRules),
    monthlySnapshots: norm(s.monthlySnapshots),
    transactions: norm(s.transactions),
    ...Object.fromEntries(Object.entries(s.cascade ?? {}).map(([k, v]) => [k, norm(v as unknown[])])),
    settings: s.settings,
  };
}
async function bookkeeping() {
  const [b] = await db.select({ n: count() }).from(importBatchesTable).where(eq(importBatchesTable.userId, TEST_USER));
  const [s] = await db.select({ n: count() }).from(importSnapshotsTable).where(eq(importSnapshotsTable.userId, TEST_USER));
  const [h] = await db.select({ n: count() }).from(mappingRuleHistoryTable).where(eq(mappingRuleHistoryTable.householdId, TEST_HOUSEHOLD_ID));
  const [p] = await db.select({ prefs: settingsTable.preferences }).from(settingsTable).where(eq(settingsTable.userId, TEST_USER));
  return { batches: Number(b!.n), snapshots: Number(s!.n), ruleHistory: Number(h!.n), prefs: p?.prefs ?? null };
}
async function totals() {
  const spine = (await api("GET", "/spine")).json!;
  const week = (await api("GET", `/money/period-breakdown?period=week&start=${WEEK.start}`)).json!;
  return { spentWeek: Number(spine.spentWeek), spentMonth: Number(spine.spentMonth), weekActual: Number(week.actual) };
}

// ── The files ───────────────────────────────────────────────────────────────
const FILE: WorkbookSpec = {
  debts: [
    { name: "Synth Card A", type: "Card", apr: 0.1999, balance: 410, min: 25 },
    { name: "Synth Card B", type: "Card", apr: "17.5%", balance: "$220.00", min: "$15.00" },
  ],
  budget: [
    { name: "Synth Groceries", planned: 450 },
    { name: "Synth Dining", planned: "$120.00" },
    { name: "Synth Home", planned: 60 },
  ],
  recurring: [
    { name: "Synth Phone", kind: "Expense", amount: 45, frequency: "monthly", day: 9 },
    { name: "Synth Salary", kind: "Income", amount: "$1,900.00", frequency: "biweekly", anchor: "2026-10-02" },
  ],
  rules: [
    { pattern: "SYNTH MARKET", target: "Synth Groceries" },
    { pattern: "SYNTH DINER", target: "Synth Dining" },
  ],
  payments: [
    { date: "2026-09-02", description: "SYNTH MARKET 10", amount: 41.2 },
    { date: "2026-09-14", description: "SYNTH DINER 11", amount: 23.75 },
    { date: OLD_B, description: "SYNTH HOME STORE", target: "Synth Home", amount: 12 },
    { date: TODAY, description: "SYNTH MARKET 12", amount: 9.99 },
    { date: TODAY, description: "SYNTH RETURN", type: "Credit", amount: 5 },
    { date: "2026-09-30", description: "SYNTH CARD PAYMENT", type: "Income", amount: 60 },
  ],
  tracking: { months: ["Sep 2026"], metrics: [{ name: "Net worth", values: [500] }] },
};
const FILE_DAYS = ["2026-09-02", "2026-09-14", OLD_B, TODAY, TODAY, "2026-09-30"].sort();
const OTHER_FILE: WorkbookSpec = { ...FILE, payments: FILE.payments!.slice(0, 2), budget: FILE.budget!.slice(0, 1) };

let PRE: Awaited<ReturnType<typeof userState>>;
let PRE_BOOKS: Awaited<ReturnType<typeof bookkeeping>>;
let PRE_TOTALS: Awaited<ReturnType<typeof totals>>;

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await seed();
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
  PRE = await userState();
  PRE_BOOKS = await bookkeeping();
  PRE_TOTALS = await totals();
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { householdsTable } = await import("@workspace/db");
  await db.delete(importSnapshotsTable).where(inArray(importSnapshotsTable.userId, [TEST_USER, MEMBER]));
  await db.delete(importBatchesTable).where(inArray(importBatchesTable.userId, [TEST_USER, MEMBER]));
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, [TEST_USER, MEMBER]));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
  await db.delete(householdsTable).where(eq(householdsTable.id, TEST_HOUSEHOLD_ID)); // cascades the rest
});

// The pre-import data, as the preview and the restore count it.
const PRE_REPLACES = {
  transactions: 4,
  bankTransactions: 3,
  bankFrom: OLD_A,
  bankTo: TODAY,
  categories: 2,
  budgetLines: 1,
  debts: 1,
  rules: 1,
  recurring: 1,
  monthlySnapshots: 0,
  decisions: 1,
  splits: 0,
};

describe("(W) preview: the dry run", () => {
  it("says what the file adds and what it replaces (bank rows counted, with their first and last day) and writes nothing", async () => {
    const res = await previewOf(workbookFile(FILE), "synthetic-household.xlsx");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      fileName: "synthetic-household.xlsx",
      confirmToken: expect.stringMatching(/^[0-9a-f]{32}$/),
      adds: { transactions: 6, from: FILE_DAYS[0], to: FILE_DAYS[5], categories: 3, budgetLines: 3, debts: 2, rules: 2, recurring: 2, monthlySnapshots: 1 },
      replaces: PRE_REPLACES,
      // The person's priority-5 rule survives the import.
      rulesKept: 1,
    });
    expect(await userState()).toEqual(PRE);
    expect(await bookkeeping()).toEqual(PRE_BOOKS);
  });

  it("the same file previewed twice gives the same confirmation; another person's preview differs", async () => {
    const a = await previewOf(workbookFile(FILE), "a.xlsx");
    const b = await previewOf(workbookFile(FILE), "b.xlsx");
    const m = await previewOf(workbookFile(FILE), "a.xlsx", "member");
    expect(a.json!.confirmToken).toBe(b.json!.confirmToken);
    expect(m.status).toBe(200);
    expect(m.json!.confirmToken).not.toBe(a.json!.confirmToken);
    // The member has nothing of their own: an import of theirs replaces nothing.
    expect(m.json!.replaces).toMatchObject({ transactions: 0, bankTransactions: 0, bankFrom: null, bankTo: null, categories: 0 });
  });

  it("a file with problems: every one listed in the file's words, before anything is written (preview and import alike)", async () => {
    const bad = workbookFile({
      ...FILE,
      budget: [...FILE.budget!, { name: "Synth Fun", planned: "lots" }],
      recurring: [...FILE.recurring!, { name: "Synth Gym", amount: 30, day: "soon" as unknown as number }],
      payments: [...FILE.payments!, { date: TODAY, description: "SYNTH BAD", amount: "twelve" }],
    });
    const expected = [
      'Monthly Budget row 9: the amount "lots" is not a number.',
      'Recurring Items row 8: the day "soon" is not a day of the month.',
      'Payments row 12: the amount "twelve" is not a number.',
    ];
    const p = await previewOf(bad, "bad.xlsx");
    expect(p.status).toBe(400);
    expect(p.json).toEqual({ error: expected[0], errors: expected });
    // The import checks the file before it asks for a confirmation.
    const i = await importOf(bad, "bad.xlsx", null);
    expect(i.status).toBe(400);
    expect(i.json).toEqual({ error: expected[0], errors: expected });
    const notWorkbook = await previewOf(Buffer.from("PK\u0003\u0004 not a zip"), "broken.xlsx");
    expect(notWorkbook).toEqual({ status: 400, json: { error: "This file is not a workbook H2 can read.", errors: ["This file is not a workbook H2 can read."] } });
    expect(await userState()).toEqual(PRE);
    expect(await bookkeeping()).toEqual(PRE_BOOKS);
  });
});

describe("(W) a long list of problems", () => {
  it("lists the first 20 by name and counts the rest in one line", async () => {
    const payments = Array.from({ length: 25 }, (_, i) => ({ date: TODAY, description: `SYNTH BAD ${i}`, amount: "n/a" }));
    const res = await previewOf(workbookFile({ ...FILE, payments }), "many.xlsx");
    expect(res.status).toBe(400);
    const errors = res.json!.errors as string[];
    expect(errors).toHaveLength(21);
    expect(errors[0]).toBe('Payments row 6: the amount "n/a" is not a number.');
    expect(errors[19]).toBe('Payments row 25: the amount "n/a" is not a number.');
    expect(errors[20]).toBe("…and 5 more.");
    expect(await bookkeeping()).toEqual(PRE_BOOKS);
  });
});

describe("(W) the import requires the preview's confirmation", () => {
  it("without it: 428, nothing written", async () => {
    const res = await importOf(workbookFile(FILE), "synthetic-household.xlsx", null);
    expect(res).toEqual({ status: 428, json: { error: "Preview the file first, then confirm the import.", code: "confirm_required" } });
    expect(await userState()).toEqual(PRE);
    expect(await bookkeeping()).toEqual(PRE_BOOKS);
  });

  it("a confirmation for another file: 409, nothing written", async () => {
    const p = await previewOf(workbookFile(OTHER_FILE), "other.xlsx");
    const res = await importOf(workbookFile(FILE), "synthetic-household.xlsx", String(p.json!.confirmToken));
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "Your data or the file changed since the preview. Upload the file again to see a fresh preview.", code: "preview_stale" });
    expect(await userState()).toEqual(PRE);
    expect(await bookkeeping()).toEqual(PRE_BOOKS);
  });

  it("a confirmation the data no longer matches (a bank row arrived since the preview): 409, nothing written", async () => {
    const p = await previewOf(workbookFile(FILE), "synthetic-household.xlsx");
    const [synced] = await db
      .insert(transactionsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: TODAY, description: "SYNTH LATE BANK ROW", amount: "-3.00", source: "plaid:synthetic", plaidAccountId: CHECKING, plaidTransactionId: `w-late-${RUN}` })
      .returning();
    const during = await userState();
    const res = await importOf(workbookFile(FILE), "synthetic-household.xlsx", String(p.json!.confirmToken));
    expect(res.status).toBe(409);
    expect(res.json!.code).toBe("preview_stale");
    expect(await userState()).toEqual(during);
    await db.delete(transactionsTable).where(eq(transactionsTable.id, synced!.id));
    expect(await userState()).toEqual(PRE);
    expect(await bookkeeping()).toEqual(PRE_BOOKS);
  });

  it("a failure after every row is in (injected at the importer's last write): 500 in plain words; no row, no batch, no snapshot", async () => {
    const p = await previewOf(workbookFile(FILE), "synthetic-household.xlsx");
    inject.afterRows = true;
    try {
      const res = await importOf(workbookFile(FILE), "synthetic-household.xlsx", String(p.json!.confirmToken));
      expect(res).toEqual({ status: 500, json: { error: "The import could not be saved, so nothing was changed." } });
    } finally {
      inject.afterRows = false;
    }
    expect(await userState()).toEqual(PRE);
    expect(await bookkeeping()).toEqual(PRE_BOOKS);
  });
});

let FIRST = { batchId: "", snapshotId: "" };
let AFTER_IMPORT: Awaited<ReturnType<typeof userState>>;

describe("(W) the confirmed import, its history and its restore", () => {
  it("the confirmed import = the preview's counts; the response names the snapshot, which holds what the preview said it replaces", async () => {
    const { preview, result } = await previewThenImport(workbookFile(FILE), "synthetic-household.xlsx");
    expect(result.status).toBe(200);
    const a = preview.json!.adds;
    expect(result.json!.counts).toMatchObject({
      transactions: a.transactions,
      budget_categories: a.categories,
      budget_lines: a.budgetLines,
      debts: a.debts,
      mapping_rules: a.rules,
      recurring_items: a.recurring,
      monthly_snapshots: a.monthlySnapshots,
      mapping_rules_preserved: preview.json!.rulesKept,
    });
    expect(result.json!.replaced).toEqual(preview.json!.replaces);
    expect(result.json!.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    FIRST = { batchId: String(result.json!.batchId), snapshotId: String(result.json!.snapshotId) };
    const [snap] = await db.select().from(importSnapshotsTable).where(eq(importSnapshotsTable.id, FIRST.snapshotId));
    expect(snap).toMatchObject({ userId: TEST_USER, importBatchId: FIRST.batchId, status: "available", filename: "synthetic-household.xlsx" });
    expect(summarizeImportState(snap!.payload as ImportSnapshotPayload)).toEqual(PRE_REPLACES);
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
    expect(rows.map((r) => r.occurredOn).sort()).toEqual(FILE_DAYS);
    // The batch keeps its counts, what it replaced, and the state it left.
    const [batch] = await db.select().from(importBatchesTable).where(eq(importBatchesTable.id, FIRST.batchId));
    expect(batch!.summary).toMatchObject({ v: 1, counts: result.json!.counts, replaced: PRE_REPLACES, after: { v: 1 } });
    AFTER_IMPORT = await userState();
  });

  it("history lists it: time, file name, counts, what it replaced, Restore available; another person sees none of it", async () => {
    const res = await api("GET", "/import/history");
    expect(res.status).toBe(200);
    expect(res.json!.items).toHaveLength(1);
    expect(res.json!.items[0]).toEqual({
      batchId: FIRST.batchId,
      fileName: "synthetic-household.xlsx",
      importedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      counts: expect.objectContaining({ transactions: 6, budget_categories: 3, debts: 2, mapping_rules: 2 }),
      replaced: PRE_REPLACES,
      snapshotId: FIRST.snapshotId,
      restoredAt: null,
      restore: "available",
    });
    expect((await api("GET", "/import/history", "member")).json).toEqual({ items: [] });
  });

  it("the restore check: puts back the data from before (bank rows named), removes this import's; ready", async () => {
    const res = await api("GET", `/import/snapshots/${FIRST.snapshotId}/restore-preview`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      snapshotId: FIRST.snapshotId,
      batchId: FIRST.batchId,
      status: "ready",
      blockedBy: null,
      reason: null,
      putsBack: PRE_REPLACES,
      removes: { transactions: 6, bankTransactions: 0, bankFrom: null, bankTo: null, categories: 3, debts: 2, rules: 3 },
      changes: { total: 0 },
    });
    expect(await userState()).toEqual(AFTER_IMPORT);
  });

  it("opening pages writes on its own (GET /debts: a balance row per debt and the original balance; GET /avalanche/extra: the managed category and line) — no change of the person's: still ready", async () => {
    expect((await api("GET", "/debts")).status).toBe(200);
    expect((await api("GET", "/avalanche/extra")).status).toBe(200);
    // They did write.
    const hist = await db.select().from(debtBalanceHistoryTable).where(eq(debtBalanceHistoryTable.userId, TEST_USER));
    expect(hist).toHaveLength(2);
    const debts = await db.select().from(debtsTable).where(eq(debtsTable.userId, TEST_USER));
    expect(debts.every((d) => d.originalBalance !== null)).toBe(true);
    const managed = await db.select().from(budgetCategoriesTable).where(and(eq(budgetCategoriesTable.userId, TEST_USER), eq(budgetCategoriesTable.name, "Avalanche payment")));
    expect(managed).toHaveLength(1);
    expect(await userState()).not.toEqual(AFTER_IMPORT);
    const check = await api("GET", `/import/snapshots/${FIRST.snapshotId}/restore-preview`);
    expect(check.json).toMatchObject({ status: "ready", changes: { total: 0 } });
    AFTER_IMPORT = await userState();
  });

  it("a real debt change (a balance typed since) still blocks: 1 debt change", async () => {
    const [d] = await db.select().from(debtsTable).where(and(eq(debtsTable.userId, TEST_USER), eq(debtsTable.name, "Synth Card A")));
    await db.update(debtsTable).set({ balance: "399.00" }).where(eq(debtsTable.id, d!.id));
    const check = await api("GET", `/import/snapshots/${FIRST.snapshotId}/restore-preview`);
    expect(check.json).toMatchObject({ status: "blocked", reason: "Blocked: 1 change since this import would be lost (1 debt change).", changes: { total: 1, debts: 1 } });
    await db.update(debtsTable).set({ balance: d!.balance }).where(eq(debtsTable.id, d!.id));
    expect(await userState()).toEqual(AFTER_IMPORT);
  });

  it("another person: 404 on the check and on the restore; nothing changes", async () => {
    const check = await api("GET", `/import/snapshots/${FIRST.snapshotId}/restore-preview`, "member");
    expect(check).toEqual({ status: 404, json: { error: "Import not found." } });
    const res = await api("POST", `/import/snapshots/${FIRST.snapshotId}/restore`, "member");
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: "Import not found.", code: "not_found" });
    expect((await api("POST", "/import/snapshots/not-a-uuid/restore")).status).toBe(404);
    expect(await userState()).toEqual(AFTER_IMPORT);
  });

  it("an edited row since the import blocks the restore with the reason and the count; put back exactly, the restore is allowed again", async () => {
    const [row] = await db.select().from(transactionsTable).where(and(eq(transactionsTable.userId, TEST_USER), eq(transactionsTable.description, "SYNTH DINER 11")));
    const [other] = await db.select().from(budgetCategoriesTable).where(and(eq(budgetCategoriesTable.userId, TEST_USER), eq(budgetCategoriesTable.name, "Synth Home")));
    await db.update(transactionsTable).set({ categoryId: other!.id, categoryLockedByUser: true }).where(eq(transactionsTable.id, row!.id));
    const edited = await userState();
    const reason = "Blocked: 1 change since this import would be lost (1 edited row).";
    const check = await api("GET", `/import/snapshots/${FIRST.snapshotId}/restore-preview`);
    expect(check.json).toMatchObject({ status: "blocked", blockedBy: "changed_since", reason, changes: { total: 1, transactionsEdited: 1 } });
    const res = await api("POST", `/import/snapshots/${FIRST.snapshotId}/restore`);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: reason, code: "changed_since", changes: { total: 1, transactionsEdited: 1 } });
    expect(await userState()).toEqual(edited);
    const [snap] = await db.select({ status: importSnapshotsTable.status }).from(importSnapshotsTable).where(eq(importSnapshotsTable.id, FIRST.snapshotId));
    expect(snap!.status).toBe("available");
    // The edit undone by hand: nothing differs from what the import left.
    await db.update(transactionsTable).set({ categoryId: row!.categoryId, categoryLockedByUser: row!.categoryLockedByUser }).where(eq(transactionsTable.id, row!.id));
    expect((await api("GET", `/import/snapshots/${FIRST.snapshotId}/restore-preview`)).json).toMatchObject({ status: "ready" });
  });

  it("a bank row synced since, a new rule and a filing decision block it too, each counted", async () => {
    const [synced] = await db
      .insert(transactionsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: TODAY, description: "SYNTH NEW BANK ROW", amount: "-4.00", source: "plaid:synthetic", plaidAccountId: CHECKING, plaidTransactionId: `w-new-${RUN}` })
      .returning();
    const [rule] = await db.insert(mappingRulesTable).values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, pattern: "SYNTH NEW", matchType: "contains", priority: 3 }).returning();
    const [imported] = await db.select().from(transactionsTable).where(and(eq(transactionsTable.userId, TEST_USER), eq(transactionsTable.description, "SYNTH MARKET 10")));
    const [decision] = await db
      .insert(categoryDecisionsTable)
      .values({ householdId: TEST_HOUSEHOLD_ID, transactionId: imported!.id, source: "rule", categoryId: imported!.categoryId, confidence: "0.950", band: "auto", explanation: "Rule.", inputHash: `w-d-${RUN}` })
      .returning();
    const res = await api("POST", `/import/snapshots/${FIRST.snapshotId}/restore`);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({
      code: "changed_since",
      error: "Blocked: 3 changes since this import would be lost (1 new bank row, 1 filing decision, 1 rule change).",
      changes: { total: 3, transactionsAdded: 1, bankRowsAdded: 1, rules: 1, decisions: 1 },
    });
    await db.delete(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, decision!.id));
    await db.delete(mappingRulesTable).where(eq(mappingRulesTable.id, rule!.id));
    await db.delete(transactionsTable).where(eq(transactionsTable.id, synced!.id));
    expect(await userState()).toEqual(AFTER_IMPORT);
  });

  it("a restore that fails at its last step (injected) changes nothing: 500 in plain words, the snapshot still available", async () => {
    const books = await bookkeeping();
    inject.restoreLastStep = true;
    try {
      const res = await api("POST", `/import/snapshots/${FIRST.snapshotId}/restore`);
      expect(res).toEqual({ status: 500, json: { error: "The restore could not be saved, so nothing was changed." } });
    } finally {
      inject.restoreLastStep = false;
    }
    expect(await userState()).toEqual(AFTER_IMPORT);
    expect(await bookkeeping()).toEqual(books);
    const [snap] = await db.select({ status: importSnapshotsTable.status }).from(importSnapshotsTable).where(eq(importSnapshotsTable.id, FIRST.snapshotId));
    expect(snap!.status).toBe("available");
  });

  it("two restores at once: one restores, the other is refused (409); the household is exactly as before the import", async () => {
    const [a, b] = await Promise.all([
      api("POST", `/import/snapshots/${FIRST.snapshotId}/restore`),
      api("POST", `/import/snapshots/${FIRST.snapshotId}/restore`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.json).toMatchObject({ error: "This import was already restored.", code: "already_restored" });
    const now = await userState();
    for (const key of Object.keys(PRE) as Array<keyof typeof PRE>) {
      expect({ [key]: now[key] }).toEqual({ [key]: PRE[key] });
    }
    expect(now).toEqual(PRE);
    expect(await totals()).toEqual(PRE_TOTALS);
    // Other preferences untouched.
    expect((await bookkeeping()).prefs).toEqual(PRE_BOOKS.prefs);
  });

  it("a repeated restore: 409 in plain words, nothing changes; history says Restored", async () => {
    const res = await api("POST", `/import/snapshots/${FIRST.snapshotId}/restore`);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "This import was already restored.", code: "already_restored" });
    expect(await userState()).toEqual(PRE);
    const check = await api("GET", `/import/snapshots/${FIRST.snapshotId}/restore-preview`);
    expect(check.json).toMatchObject({ status: "restored", blockedBy: "already_restored", reason: "This import was already restored.", restoredAt: expect.any(String) });
    const h = await api("GET", "/import/history");
    expect(h.json!.items[0]).toMatchObject({ batchId: FIRST.batchId, restore: "restored", restoredAt: expect.any(String) });
  });
});

describe("(W) two imports: restores go newest first", () => {
  let one = "";
  let two = "";
  it("the same file twice: the second preview replaces the first import's rows (no bank rows), each row once", async () => {
    const first = await previewThenImport(workbookFile(FILE), "first.xlsx");
    expect(first.result.status).toBe(200);
    one = String(first.result.json!.snapshotId);
    const second = await previewThenImport(workbookFile(FILE), "first.xlsx");
    expect(second.preview.json!.replaces).toMatchObject({ transactions: 6, bankTransactions: 0, bankFrom: null, bankTo: null, categories: 3, debts: 2 });
    expect(second.result.status).toBe(200);
    two = String(second.result.json!.snapshotId);
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
    expect(rows).toHaveLength(6);
  });

  it("history: the newer import can be restored; the older one waits for it", async () => {
    const items = (await api("GET", "/import/history")).json!.items as Array<{ snapshotId: string; restore: string }>;
    expect(items.slice(0, 3).map((i) => [i.snapshotId, i.restore])).toEqual([
      [two, "available"],
      [one, "later_import"],
      [FIRST.snapshotId, "restored"],
    ]);
  });

  it("the older one first: 409 'Restore that one first', nothing changes; newest first: back to the start", async () => {
    const before = await userState();
    const early = await api("POST", `/import/snapshots/${one}/restore`);
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({ code: "later_import", error: "A later import replaced this one. Restore that one first." });
    expect(await userState()).toEqual(before);
    expect((await api("POST", `/import/snapshots/${two}/restore`)).status).toBe(200);
    const items = (await api("GET", "/import/history")).json!.items as Array<{ snapshotId: string; restore: string }>;
    expect(items.slice(0, 2).map((i) => [i.snapshotId, i.restore])).toEqual([
      [two, "restored"],
      [one, "available"],
    ]);
    expect((await api("POST", `/import/snapshots/${one}/restore`)).status).toBe(200);
    expect(await userState()).toEqual(PRE);
    expect(await totals()).toEqual(PRE_TOTALS);
  });

  it("an import from before the change record (no state kept) is too old: history says so, the restore refuses (409), nothing changes", async () => {
    const [batch] = await db.insert(importBatchesTable).values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, filename: "legacy.xlsx" }).returning();
    const [snap] = await db
      .insert(importSnapshotsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, importBatchId: batch!.id, filename: "legacy.xlsx", payload: { transactions: [], budgetCategories: [], debts: [], budgetMonths: [], budgetLines: [], recurringItems: [], mappingRules: [], monthlySnapshots: [] }, status: "available" })
      .returning();
    const items = (await api("GET", "/import/history")).json!.items as Array<{ snapshotId: string; restore: string }>;
    expect(items[0]).toMatchObject({ snapshotId: snap!.id, restore: "too_old" });
    const res = await api("POST", `/import/snapshots/${snap!.id}/restore`);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "too_old", error: "Too old to restore safely: H2 cannot tell what changed since." });
    expect(await userState()).toEqual(PRE);
  });
});

describe("(W) two imports at once", () => {
  it("one imports; the other waits for it, finds the data changed since its preview and is refused (409); each row once, one batch", async () => {
    const before = await bookkeeping();
    const p = await previewOf(workbookFile(FILE), "twice.xlsx");
    const token = String(p.json!.confirmToken);
    const [a, b] = await Promise.all([
      importOf(workbookFile(FILE), "twice.xlsx", token),
      importOf(workbookFile(FILE), "twice.xlsx", token),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).json).toMatchObject({ code: "preview_stale" });
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
    expect(rows).toHaveLength(6);
    const after = await bookkeeping();
    expect({ batches: after.batches - before.batches, snapshots: after.snapshots - before.snapshots }).toEqual({ batches: 1, snapshots: 1 });
    // And it restores to where it started.
    const done = a.status === 200 ? a : b;
    expect((await api("POST", `/import/snapshots/${done.json!.snapshotId}/restore`)).status).toBe(200);
    expect(await userState()).toEqual(PRE);
  });
});
