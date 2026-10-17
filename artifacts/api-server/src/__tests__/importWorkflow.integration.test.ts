// ⭐ (Task 7, V) THE WORKBOOK IMPORT, WALKED THROUGH THE REAL ROUTE.
//
// Synthetic files built in memory (`_helpers/workbookFiles.ts`) are uploaded
// as multipart to `POST /api/import/workbook` on the real router, against an
// isolated test database. Every step reads the database and the money
// endpoints back:
//
//   1. a malformed file, a bad amount, a bad APR, a missing sheet → 400 with a
//      plain reason and NOTHING written (not even the import batch row);
//   2. a good file → the rows persisted are the file's rows (count, amounts,
//      dates, signs incl. the Amex sign rule, categories and locks);
//   3. the totals the file affects move exactly as the file says (spine,
//      period breakdown, Amex summary — before vs after);
//   4. the same file twice → each row once (the rule: an import REPLACES the
//      user's workbook data, wipe then insert, in one transaction);
//   5. every container format the parser reads gives the same rows;
//   6. a constraint violation on row 510 of 520 (a numeric overflow, after a
//      first chunk of 500 is already inserted) → the transaction rolls back:
//      zero partial rows, a 500 that says nothing was changed;
//   7. restoring the first import's snapshot returns EVERY table the import
//      touched to the pre-import state (incl. the rows the wipe cascades away
//      and the Amex anchor it rewrites), and a second restore is refused.
//
// Synthetic data only. No Plaid, no model, no texts.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, count, eq, inArray } from "drizzle-orm";

const TEST_USER = `v-import-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `${TEST_USER}-other`;
const CLAIM_USER = `${TEST_USER}-claims`;
let TEST_HOUSEHOLD_ID = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string; headers?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    const h = req.headers?.["x-test-user"];
    const who = h === "other" ? OTHER_USER : h === "claims" ? CLAIM_USER : TEST_USER;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  categoryDecisionsTable,
  debtBalanceHistoryTable,
  debtLedgerEventsTable,
  debtMilestonesTable,
  debtProgressSnapshotsTable,
  debtStatementsTable,
  debtsTable,
  importBatchesTable,
  importSnapshotsTable,
  mappingRulesTable,
  monthlySnapshotsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionSplitsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, householdToday, weekBounds } from "@workspace/avalanche-core";
import fullRouter from "../routes";
import { createTestHousehold } from "./_helpers/testHousehold";
import { workbookFile, type WorkbookSpec, type BookType } from "./_helpers/workbookFiles";
import { fingerprintOf, readImportState } from "../lib/importSnapshot";

// ── The server: the real router under /api, as app.ts mounts it ─────────────
const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use("/api", fullRouter);
let server: Server;
let base = "";

async function post(path: string, file: Buffer, filename: string, as: "owner" | "other", confirm?: string | null) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(file)]), filename);
  if (confirm) fd.append("confirm", confirm);
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    body: fd,
    headers: as === "other" ? { "x-test-user": "other" } : {},
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}
// (W) An import runs only with the confirmation of a preview of the same file:
// preview, then import with it. A file the preview refuses goes to the import
// without one, so the import's own checks answer (they run before the
// confirmation is asked for).
async function upload(file: Buffer, filename: string, as: "owner" | "other" = "owner") {
  const preview = await post("/import/workbook/preview", file, filename, as);
  const confirm = preview.status === 200 ? String(preview.json!.confirmToken) : null;
  return post("/import/workbook", file, filename, as, confirm);
}
async function api(method: string, path: string, as: "owner" | "other" | "claims" = "owner") {
  const res = await fetch(`${base}/api${path}`, { method, headers: as === "owner" ? {} : { "x-test-user": as } });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

// ── Dates the household reads (America/Chicago) ──────────────────────────────
const TODAY = householdToday(new Date());
const WEEK = weekBounds(TODAY);
const OLD_DAY = "2026-08-12"; // a past month, never this week or this month
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

// ── The pre-import household (the state a restore must return) ──────────────
const RUN = randomUUID().slice(0, 8);
const CARD_ACCT = `v-import-card-${RUN}`;
const ids: Record<string, string> = {};

async function seedPriorHousehold(): Promise<void> {
  const hh = TEST_HOUSEHOLD_ID;
  const base = { userId: TEST_USER, householdId: hh };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...base, itemId: `item-${RUN}`, accessToken: `access-sandbox-${RUN}`, institutionName: "Synthetic Card Co", institutionSlug: "amex" })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: item!.id, accountId: CARD_ACCT, name: "Synth Blue Card", mask: "0101", type: "credit", subtype: "credit card" })
    .returning();
  const [debt] = await db
    .insert(debtsTable)
    .values({ ...base, name: "Synth Amex Card", balance: "321.00", apr: "0.2100", minPayment: "25.00", payment: "25.00", type: "credit_card", plaidAccountId: acct!.id })
    .returning();
  ids.debt = debt!.id;
  const [catA] = await db.insert(budgetCategoriesTable).values({ ...base, name: "Synth Groceries", kind: "expense", groupName: "Prior" }).returning();
  const [catB] = await db.insert(budgetCategoriesTable).values({ ...base, name: "Synth Card Payment", kind: "expense", groupName: "Prior", debtId: debt!.id }).returning();
  ids.catA = catA!.id;
  ids.catB = catB!.id;
  await db.insert(budgetMonthsTable).values({ ...base, monthStart: MONTH_START });
  await db.insert(budgetLinesTable).values({ ...base, monthStart: MONTH_START, categoryId: catA!.id, plannedAmount: "400.00", note: "prior plan" });
  await db.insert(recurringItemsTable).values({ ...base, name: "Synth Streaming", kind: "bill", amount: "9.99", frequency: "monthly", dayOfMonth: 3, active: "true", categoryId: catA!.id, debtId: debt!.id });
  await db.insert(mappingRulesTable).values({ ...base, pattern: "SYNTH CAFE", matchType: "contains", categoryId: catA!.id, priority: 5 });
  await db.insert(monthlySnapshotsTable).values({ ...base, monthStart: "2026-07-01", payload: { "Net worth": "100.00" } });
  const [t1] = await db
    .insert(transactionsTable)
    .values({ ...base, occurredOn: TODAY, description: "SYNTH CARD GROCER 11", amount: "-40.00", source: "plaid:amex", plaidAccountId: CARD_ACCT, plaidTransactionId: `v-import-t1-${RUN}`, categoryId: catA!.id, weeklyAllowance: true })
    .returning();
  const [t2] = await db
    .insert(transactionsTable)
    .values({ ...base, occurredOn: TODAY, description: "SYNTH CARD BOOKSHOP 12", amount: "-15.50", source: "plaid:amex", plaidAccountId: CARD_ACCT, plaidTransactionId: `v-import-t2-${RUN}` })
    .returning();
  const [t3] = await db
    .insert(transactionsTable)
    .values({ ...base, occurredOn: OLD_DAY, description: "SYNTH TYPED ROW", amount: "12.00", source: "amex", categoryId: catA!.id, categoryLockedByUser: true, occurredAt: "2026-08-12T15:30:00.000Z" })
    .returning();
  ids.t1 = t1!.id;
  ids.t2 = t2!.id;
  ids.t3 = t3!.id;
  // The rows the wipe cascades away with their parents.
  await db.insert(categoryDecisionsTable).values({ householdId: hh, transactionId: t1!.id, source: "user", categoryId: catA!.id, confidence: "1.000", band: "auto", explanation: "Filed by hand.", inputHash: `v-import-${RUN}` });
  await db.insert(transactionSplitsTable).values([
    { householdId: hh, transactionId: t1!.id, categoryId: catA!.id, amount: "-30.00", userId: TEST_USER },
    { householdId: hh, transactionId: t1!.id, categoryId: catB!.id, amount: "-10.00", userId: TEST_USER },
  ]);
  await db.insert(debtBalanceHistoryTable).values({ ...base, debtId: debt!.id, recordedOn: "2026-09-30", balance: "350.00" });
  await db.insert(debtStatementsTable).values({ householdId: hh, debtId: debt!.id, statementDate: "2026-09-25", statementBalance: "340.00", minPayment: "25.00", dueDate: "2026-10-20", source: "manual" });
  await db.insert(debtLedgerEventsTable).values({ householdId: hh, debtId: debt!.id, transactionId: t2!.id, kind: "charge", amount: "15.50", occurredOn: TODAY });
  await db.insert(debtProgressSnapshotsTable).values({ householdId: hh, debtId: debt!.id, asOf: "2026-09-30", balanceEffective: "350.00", delta: "10.00", paymentsConfirmed: "0", interest: "5.00", fees: "0", newCharges: "5.00", unexplained: "0" });
  await db.insert(debtMilestonesTable).values({ householdId: hh, debtId: debt!.id, key: `pct_25-${RUN}`, label: "A quarter paid", achievedOn: "2026-09-01" });
  await db
    .insert(settingsTable)
    .values({ userId: TEST_USER, householdId: hh, preferences: { amexAnchor: { balance: 321, asOf: "2026-10-01T12:00:00.000Z", lastAutoBalance: 321 }, keepMe: "unchanged" } })
    .onConflictDoUpdate({ target: settingsTable.userId, set: { preferences: { amexAnchor: { balance: 321, asOf: "2026-10-01T12:00:00.000Z", lastAutoBalance: 321 }, keepMe: "unchanged" } } });
}

// ── What the import may touch, read back in full ─────────────────────────────
const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

async function userState() {
  const u = TEST_USER;
  const txns = byId(await db.select().from(transactionsTable).where(eq(transactionsTable.userId, u)));
  const debts = byId(await db.select().from(debtsTable).where(eq(debtsTable.userId, u)));
  const txnIds = txns.map((t) => t.id);
  const debtIds = debts.map((d) => d.id);
  const inTxns = <C,>(col: C) => (txnIds.length ? inArray(col as never, txnIds) : undefined);
  const inDebts = <C,>(col: C) => (debtIds.length ? inArray(col as never, debtIds) : undefined);
  const [settings] = await db.select({ preferences: settingsTable.preferences }).from(settingsTable).where(eq(settingsTable.userId, u));
  return {
    budgetCategories: byId(await db.select().from(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, u))),
    debts,
    budgetMonths: byId(await db.select().from(budgetMonthsTable).where(eq(budgetMonthsTable.userId, u))),
    budgetLines: byId(await db.select().from(budgetLinesTable).where(eq(budgetLinesTable.userId, u))),
    recurringItems: byId(await db.select().from(recurringItemsTable).where(eq(recurringItemsTable.userId, u))),
    mappingRules: byId(await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.userId, u))),
    monthlySnapshots: byId(await db.select().from(monthlySnapshotsTable).where(eq(monthlySnapshotsTable.userId, u))),
    transactions: txns,
    categoryDecisions: txnIds.length ? byId(await db.select().from(categoryDecisionsTable).where(inTxns(categoryDecisionsTable.transactionId))) : [],
    transactionSplits: txnIds.length ? byId(await db.select().from(transactionSplitsTable).where(inTxns(transactionSplitsTable.transactionId))) : [],
    debtBalanceHistory: debtIds.length ? byId(await db.select().from(debtBalanceHistoryTable).where(inDebts(debtBalanceHistoryTable.debtId))) : [],
    debtStatements: debtIds.length ? byId(await db.select().from(debtStatementsTable).where(inDebts(debtStatementsTable.debtId))) : [],
    debtLedgerEvents: debtIds.length ? byId(await db.select().from(debtLedgerEventsTable).where(inDebts(debtLedgerEventsTable.debtId))) : [],
    debtProgressSnapshots: debtIds.length ? byId(await db.select().from(debtProgressSnapshotsTable).where(inDebts(debtProgressSnapshotsTable.debtId))) : [],
    debtMilestones: byId(await db.select().from(debtMilestonesTable).where(eq(debtMilestonesTable.householdId, TEST_HOUSEHOLD_ID))),
    amexAnchor: (settings?.preferences as Record<string, unknown> | null)?.amexAnchor ?? null,
    keepMe: (settings?.preferences as Record<string, unknown> | null)?.keepMe ?? null,
  };
}
async function bookkeeping() {
  const [b] = await db.select({ n: count() }).from(importBatchesTable).where(eq(importBatchesTable.userId, TEST_USER));
  const [s] = await db.select({ n: count() }).from(importSnapshotsTable).where(eq(importSnapshotsTable.userId, TEST_USER));
  return { batches: Number(b!.n), snapshots: Number(s!.n) };
}

// ── The money the import affects ─────────────────────────────────────────────
async function totals() {
  const spine = (await api("GET", "/spine")).json!;
  const week = (await api("GET", `/money/period-breakdown?period=week&start=${WEEK.start}`)).json!;
  const card = await api("GET", `/amex/summary?accountId=${CARD_ACCT}&from=${WEEK.start}&to=${TODAY}`);
  return {
    spentWeek: Number(spine.spentWeek),
    spentMonth: Number(spine.spentMonth),
    weekActual: Number(week.actual),
    weekRows: [...week.categories.flatMap((c: any) => c.rows), ...week.unresolved.rows, ...week.needsClassification.rows].length,
    cardStatus: card.status,
    cardPurchases: card.status === 200 ? Number(card.json!.purchases.amount) : null,
  };
}

// ── The file ─────────────────────────────────────────────────────────────────
// Payments on TODAY count this week and this month; OLD_DAY counts in neither.
const FILE: WorkbookSpec = {
  debts: [
    { name: "Synth Amex Card", type: "Card", apr: 0.2499, balance: 1200.5, min: 35 },
    { name: "Synth Store Card", type: "Card", apr: "21.99%", balance: "$640.25", min: "$25.00" },
    { name: "Synth Car Note", type: "Loan", apr: 6.5, balance: 9800, min: 312 },
  ],
  budget: [
    { name: "Synth Groceries", planned: 500, note: "weekly shop" },
    { name: "Synth Dining", planned: "$150.00" },
    { name: "Synth Home", planned: "—" },
  ],
  recurring: [
    { name: "Synth Phone", kind: "Expense", amount: 55, frequency: "Monthly", day: 12, anchor: new Date(2026, 9, 12) },
    { name: "Synth Payroll", kind: "Income", amount: "$2,000.00", frequency: "biweekly", day: null, anchor: "2026-10-09" },
    { name: "Synth Car Note", kind: "Debt payment", amount: 312, frequency: "monthly", day: 20, active: "No" },
  ],
  rules: [
    { pattern: "SYNTH MART", target: "Synth Groceries" },
    { pattern: "SYNTH BISTRO", target: "Synth Dining" },
  ],
  payments: [
    // Target named: filed by a person in the sheet → locked.
    { date: TODAY, description: "SYNTH HARDWARE 01", type: "Expense", target: "Synth Home", amount: 42.1, notes: "hinges" },
    // No Target: the Mapping rule files it → not locked.
    { date: TODAY, description: "SYNTH MART 0042", type: "Expense", amount: "$63.37" },
    // A refund (Credit) and a payment (Income) are stored negative.
    { date: TODAY, description: "SYNTH MART RETURN", type: "Credit", amount: 10 },
    { date: OLD_DAY, description: "SYNTH CARD PAYMENT THANK YOU", type: "Income", amount: 100 },
    // A charge typed negative in the sheet is still a charge (stored positive).
    { date: TODAY, description: "SYNTH BISTRO 7", type: "Expense", amount: -18.25 },
    // A date-time cell keeps its time; a date-only cell has none.
    { date: new Date(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 1, Number(TODAY.slice(8, 10)), 14, 30), description: "SYNTH KIOSK", type: "Expense", amount: 5 },
    // Older than this week and this month (an Excel serial date).
    { date: 46246, description: "SYNTH MART 0042", type: "Expense", amount: 63.37 },
    // A Target that names no budget category: the rules decide, none matches.
    { date: OLD_DAY, description: "SYNTH UNKNOWN SHOP", type: "Expense", target: "No Such Category", amount: 7.77 },
    // Real date cells (what Excel writes): date only, and a late-evening date-time.
    { date: new Date(2026, 7, 12), description: "SYNTH DATE CELL", type: "Expense", amount: 3.21 },
    { date: new Date(2026, 7, 12, 23, 30), description: "SYNTH LATE NIGHT", type: "Expense", amount: 2.5 },
  ],
  tracking: { months: ["Sep 2026", "Oct 2026"], metrics: [{ name: "Net worth", values: [1000, "$1,250.00"] }] },
  extraSheets: { Notes: [["Anything here is ignored"]] },
};
// What those rows must persist as: [date, description, signed amount, category name | null, locked].
const SERIAL_DAY = "2026-08-12"; // Excel serial 46246
const EXPECTED_ROWS: Array<[string, string, string, string | null, boolean]> = [
  [TODAY, "SYNTH HARDWARE 01", "42.10", "Synth Home", true],
  [TODAY, "SYNTH MART 0042", "63.37", "Synth Groceries", false],
  [TODAY, "SYNTH MART RETURN", "-10.00", "Synth Groceries", false],
  [OLD_DAY, "SYNTH CARD PAYMENT THANK YOU", "-100.00", null, false],
  [TODAY, "SYNTH BISTRO 7", "18.25", "Synth Dining", false],
  [TODAY, "SYNTH KIOSK", "5.00", null, false],
  [SERIAL_DAY, "SYNTH MART 0042", "63.37", "Synth Groceries", false],
  [OLD_DAY, "SYNTH UNKNOWN SHOP", "7.77", null, false],
  [OLD_DAY, "SYNTH DATE CELL", "3.21", null, false],
  [OLD_DAY, "SYNTH LATE NIGHT", "2.50", null, false],
];
const FILE_ROWS = EXPECTED_ROWS.length;

async function importedRows() {
  const cats = new Map(
    (await db.select().from(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER))).map((c) => [c.id, c.name] as const),
  );
  const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  return rows
    .map((t) => [t.occurredOn, t.description, t.amount, t.categoryId ? (cats.get(t.categoryId) ?? "?") : null, t.categoryLockedByUser] as [string, string, string, string | null, boolean])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const sorted = <T,>(rows: T[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

let PRE: Awaited<ReturnType<typeof userState>>;
let PRE_TOTALS: Awaited<ReturnType<typeof totals>>;
let FIRST_SNAPSHOT = "";
// (W) Every import's snapshot, oldest first: a restore goes newest first.
const SNAPSHOTS: string[] = [];

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await seedPriorHousehold();
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
  PRE = await userState();
  PRE_TOTALS = await totals();
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { householdsTable } = await import("@workspace/db");
  await db.delete(importSnapshotsTable).where(inArray(importSnapshotsTable.userId, [TEST_USER, CLAIM_USER]));
  await db.delete(importBatchesTable).where(inArray(importBatchesTable.userId, [TEST_USER, CLAIM_USER]));
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, [TEST_USER, CLAIM_USER]));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
  await db.delete(householdsTable).where(eq(householdsTable.id, TEST_HOUSEHOLD_ID)); // cascades the rest
});

describe("workbook import, through POST /api/import/workbook (synthetic files, isolated DB)", () => {
  it("the seeded household is what the restore must return to (sanity)", () => {
    expect(PRE.transactions).toHaveLength(3);
    expect(PRE.categoryDecisions).toHaveLength(1);
    expect(PRE.transactionSplits).toHaveLength(2);
    expect(PRE.debtBalanceHistory).toHaveLength(1);
    expect(PRE.debtStatements).toHaveLength(1);
    expect(PRE.debtLedgerEvents).toHaveLength(1);
    expect(PRE.debtProgressSnapshots).toHaveLength(1);
    expect(PRE.debtMilestones[0]!.debtId).toBe(ids.debt);
    expect(PRE.amexAnchor).toMatchObject({ balance: 321 });
    expect(PRE_TOTALS.cardStatus).toBe(200);
  });

  describe("validation: a 400 with a plain reason, and zero rows written", () => {
    const cases: Array<[string, Buffer, string, RegExp]> = [
      ["a file that is not a workbook", Buffer.from("PK\u0003\u0004 this is not a zip at all"), "broken.xlsx", /not a workbook/i],
      ["a CSV (one sheet, none of the required ones)", workbookFile(FILE, "csv"), "export.csv", /missing required sheet\(s\): Debt Tracker, Monthly Budget, Recurring Items, Mapping, Payments/],
      ["a workbook without its Payments sheet", workbookFile({ ...FILE, omit: ["Payments"] }), "no-payments.xlsx", /missing required sheet\(s\): Payments$/],
      [
        "a Payments amount that is not a number",
        workbookFile({ ...FILE, payments: [...FILE.payments!, { date: TODAY, description: "SYNTH BAD", amount: "twelve" }] }),
        "bad-amount.xlsx",
        /Payments row 16: the amount "twelve" is not a number/,
      ],
      [
        "a budget amount that is not a number",
        workbookFile({ ...FILE, budget: [...FILE.budget!, { name: "Synth Fun", planned: "lots" }] }),
        "bad-plan.xlsx",
        /Monthly Budget row 9: the amount "lots" is not a number/,
      ],
      [
        "an APR that normalizes to 100% or more",
        workbookFile({ ...FILE, debts: [...FILE.debts!, { name: "Synth Bad APR", apr: 140, balance: 10, min: 1 }] }),
        "bad-apr.xlsx",
        /APR 140 for debt "Synth Bad APR" normalizes to 1\.4/,
      ],
    ];
    for (const [what, file, name, reason] of cases) {
      it(`${what} → 400 "${reason.source.slice(0, 40)}…", nothing written`, async () => {
        const before = { state: await userState(), books: await bookkeeping() };
        const res = await upload(file, name);
        expect(res.status).toBe(400);
        expect(String(res.json?.error)).toMatch(reason);
        // No SQL, no stack, no internals in the reason.
        expect(String(res.json?.error)).not.toMatch(/insert into|select |stack|Failed query/i);
        expect(await userState()).toEqual(before.state);
        expect(await bookkeeping()).toEqual(before.books);
        expect(await userState()).toEqual(PRE);
      });
    }
    it("a request with no file → 400 'Missing 'file' field', nothing written", async () => {
      const before = await bookkeeping();
      const res = await fetch(`${base}/api/import/workbook`, { method: "POST", body: new FormData() });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Missing 'file' field");
      expect(await bookkeeping()).toEqual(before);
    });
  });

  describe("a good file (xlsx)", () => {
    let res: Awaited<ReturnType<typeof upload>>;
    beforeAll(async () => {
      res = await upload(workbookFile(FILE), "synthetic-household.xlsx");
      FIRST_SNAPSHOT = String(res.json?.snapshotId ?? "");
      SNAPSHOTS.push(FIRST_SNAPSHOT);
    });

    it("answers 200 with the batch, the counts and the pre-import snapshot id", async () => {
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        counts: {
          debts: 3,
          budget_categories: 3,
          budget_months: 1,
          budget_lines: 3,
          recurring_items: 3,
          mapping_rules: 2,
          // The prior hand rule (priority 5) survives the import.
          mapping_rules_preserved: 1,
          transactions: FILE_ROWS,
          transactions_preserved: 0,
          monthly_snapshots: 2,
          amex_anchor_updated: 1,
        },
      });
      expect(res.json!.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
      const [batch] = await db.select().from(importBatchesTable).where(eq(importBatchesTable.id, res.json!.batchId));
      expect(batch).toMatchObject({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, filename: "synthetic-household.xlsx" });
      // Rule attribution: the rows the Mapping rules filed (not the Target-named one).
      const attr = Object.fromEntries((res.json!.ruleAttributions as Array<{ pattern: string; count: number }>).map((a) => [a.pattern, a.count]));
      expect(attr).toEqual({ "SYNTH MART": 3, "SYNTH BISTRO": 1 });
    });

    it("persisted rows = the file's rows: count, dates, amounts, Amex signs, categories, locks", async () => {
      expect(await importedRows()).toEqual(sorted(EXPECTED_ROWS));
      const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
      expect(rows.every((r) => r.source === "amex" && r.importBatchId === res.json!.batchId && r.householdId === TEST_HOUSEHOLD_ID)).toBe(true);
      expect(rows.find((r) => r.description === "SYNTH HARDWARE 01")!.notes).toBe("hinges");
      // A date-time cell keeps its time of day; a date-only cell has none (in any server time zone).
      // (SheetJS reads a cell's time in the server's zone, so it is read back locally.)
      const timeOf = (d: string) => {
        const at = rows.find((r) => r.description === d)!.occurredAt;
        return at === null ? null : [new Date(at).getHours(), new Date(at).getMinutes()];
      };
      expect(timeOf("SYNTH KIOSK")).toEqual([14, 30]);
      expect(timeOf("SYNTH LATE NIGHT")).toEqual([23, 30]);
      expect(timeOf("SYNTH DATE CELL")).toBeNull();
      expect(rows.filter((r) => !["SYNTH KIOSK", "SYNTH LATE NIGHT"].includes(r.description)).every((r) => r.occurredAt === null)).toBe(true);
    });

    it("the other sheets map to debts, the budget, recurring items, rules and snapshots", async () => {
      const debts = await db.select().from(debtsTable).where(eq(debtsTable.userId, TEST_USER));
      expect(sorted(debts.map((d) => [d.name, d.type, d.apr, d.balance, d.minPayment]))).toEqual(
        sorted([
          // The Amex debt (matched by name) takes the anchor the import computes: Σ the imported card rows.
          ["Synth Amex Card", "Card", "0.2499", "95.57", "35.00"],
          ["Synth Store Card", "Card", "0.2199", "640.25", "25.00"],
          ["Synth Car Note", "Loan", "0.0650", "9800.00", "312.00"],
        ]),
      );
      const cats = await db.select().from(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
      expect(cats.map((c) => c.name).sort()).toEqual(["Synth Dining", "Synth Groceries", "Synth Home"]);
      const catName = new Map(cats.map((c) => [c.id, c.name] as const));
      const lines = await db.select().from(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
      expect(sorted(lines.map((l) => [catName.get(l.categoryId), l.plannedAmount, l.monthStart, l.note]))).toEqual(
        sorted([
          ["Synth Groceries", "500.00", MONTH_START, "weekly shop"],
          ["Synth Dining", "150.00", MONTH_START, null],
          // "—" in the sheet is a plan of nothing typed: stored $0 as before.
          ["Synth Home", "0.00", MONTH_START, null],
        ]),
      );
      const rec = await db.select().from(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
      expect(sorted(rec.map((r) => [r.name, r.kind, r.amount, r.frequency, r.dayOfMonth, r.anchorDate, r.active]))).toEqual(
        sorted([
          ["Synth Phone", "bill", "55.00", "monthly", 12, "2026-10-12", "true"],
          ["Synth Payroll", "income", "2000.00", "biweekly", null, "2026-10-09", "true"],
          ["Synth Car Note", "debt", "312.00", "monthly", 20, null, "false"],
        ]),
      );
      const rules = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
      expect(sorted(rules.map((r) => [r.pattern, r.priority, r.categoryId ? catName.get(r.categoryId) : null]))).toEqual(
        sorted([
          ["SYNTH MART", 0, "Synth Groceries"],
          ["SYNTH BISTRO", 0, "Synth Dining"],
          // The prior hand rule is kept, re-pointed by category name.
          ["SYNTH CAFE", 5, "Synth Groceries"],
        ]),
      );
      const snaps = await db.select().from(monthlySnapshotsTable).where(eq(monthlySnapshotsTable.userId, TEST_USER));
      expect(sorted(snaps.map((s) => [s.monthStart, s.payload]))).toEqual(
        sorted([
          ["2026-09-01", { "Net worth": "1000.00" }],
          ["2026-10-01", { "Net worth": "1250.00" }],
        ]),
      );
    });

    it("the totals it affects move exactly as the file says (spine, week breakdown, Amex card)", async () => {
      const after = await totals();
      // The file's household spending on TODAY: charges 42.10 + 63.37 + 18.25 + 5.00, less the 10.00 return.
      const fileWeek = 42.1 + 63.37 + 18.25 + 5 - 10;
      // Before: the prior card rows today (40.00 + 15.50) were the week; the import REPLACES them.
      expect(PRE_TOTALS.spentWeek).toBeCloseTo(55.5, 2);
      expect(after.spentWeek).toBeCloseTo(fileWeek, 2);
      expect(after.spentMonth).toBeCloseTo(fileWeek, 2);
      expect(after.weekActual).toBeCloseTo(fileWeek, 2);
      expect(after.weekRows).toBe(5);
      // The workbook's rows belong to no card account, so the card's own summary
      // loses the two Plaid rows the import replaced and gains nothing.
      expect(PRE_TOTALS.cardPurchases).toBeCloseTo(55.5, 2);
      expect(after.cardStatus).toBe(200);
      expect(after.cardPurchases).toBe(0);
      // The Amex anchor now follows the imported rows (Σ amex rows, on one sign).
      const [s] = await db.select({ p: settingsTable.preferences }).from(settingsTable).where(eq(settingsTable.userId, TEST_USER));
      const anchor = (s!.p as Record<string, any>).amexAnchor;
      expect(anchor.balance).toBeCloseTo(42.1 + 63.37 - 10 - 100 + 18.25 + 5 + 63.37 + 7.77 + 3.21 + 2.5, 2);
      expect(anchor.balance).toBeCloseTo(95.57, 2);
      expect((s!.p as Record<string, any>).keepMe).toBe("unchanged");
    });
  });

  it("duplicates: the same file twice → each row once (an import replaces the user's workbook data: wipe, then insert, in one transaction)", async () => {
    const first = await importedRows();
    const res = await upload(workbookFile(FILE), "synthetic-household.xlsx");
    expect(res.status).toBe(200);
    SNAPSHOTS.push(String(res.json!.snapshotId));
    expect(res.json!.counts.transactions).toBe(FILE_ROWS);
    expect(await importedRows()).toEqual(first);
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
    expect(rows).toHaveLength(FILE_ROWS);
    // The two identical-looking SYNTH MART 0042 rows are two charges on two days, both kept.
    expect(rows.filter((r) => r.description === "SYNTH MART 0042").map((r) => r.occurredOn).sort()).toEqual([SERIAL_DAY, TODAY].sort());
    const cats = await db.select().from(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
    expect(cats).toHaveLength(3);
    const debts = await db.select().from(debtsTable).where(eq(debtsTable.userId, TEST_USER));
    expect(debts).toHaveLength(3);
    // The second import's snapshot holds the first import's rows, not the seed.
    const [snap] = await db.select().from(importSnapshotsTable).where(eq(importSnapshotsTable.id, res.json!.snapshotId));
    expect((snap!.payload as Record<string, unknown[]>).transactions).toHaveLength(FILE_ROWS);
  });

  it.each<BookType>(["xlsm", "xls", "ods"])("the %s container the parser also reads → the same rows as the xlsx", async (bookType) => {
    const res = await upload(workbookFile(FILE, bookType), `synthetic-household.${bookType}`);
    expect(res.status).toBe(200);
    SNAPSHOTS.push(String(res.json!.snapshotId));
    expect(res.json!.counts.transactions).toBe(FILE_ROWS);
    expect(await importedRows()).toEqual(sorted(EXPECTED_ROWS));
  });

  it("a constraint violation on row 510 of 520 (numeric overflow, after a chunk of 500 is in) → rolled back, zero partial rows, 500 'nothing was changed'", async () => {
    const big: WorkbookSpec = {
      ...FILE,
      payments: Array.from({ length: 520 }, (_, i) => ({
        date: OLD_DAY,
        description: `SYNTH BULK ${String(i + 1).padStart(3, "0")}`,
        type: "Expense",
        amount: i === 509 ? 1e12 : 1 + i / 100,
      })),
    };
    const before = { state: await userState(), books: await bookkeeping() };
    const res = await upload(workbookFile(big), "too-big.xlsx");
    expect(res.status).toBe(500);
    expect(res.json!.error).toBe("The import could not be saved, so nothing was changed.");
    expect(await userState()).toEqual(before.state);
    expect(await bookkeeping()).toEqual(before.books);
    const bulk = await db.select({ n: count() }).from(transactionsTable).where(and(eq(transactionsTable.userId, TEST_USER), eq(transactionsTable.occurredOn, OLD_DAY)));
    // Only the OLD_DAY rows of the last good import; none of the 520.
    expect(Number(bulk[0]!.n)).toBe(EXPECTED_ROWS.filter((r) => r[0] === OLD_DAY).length);
  });

  describe("restore: POST /api/import/snapshots/:id/restore", () => {
    it("another user cannot restore it (404, nothing changes)", async () => {
      const before = await userState();
      const res = await api("POST", `/import/snapshots/${FIRST_SNAPSHOT}/restore`, "other");
      expect(res.status).toBe(404);
      expect(await userState()).toEqual(before);
    });

    it("(W) the first import cannot be restored while a later import is in place (409, nothing changes)", async () => {
      const before = await userState();
      const res = await api("POST", `/import/snapshots/${FIRST_SNAPSHOT}/restore`);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ code: "later_import", error: "A later import replaced this one. Restore that one first." });
      expect(await userState()).toEqual(before);
    });

    it("the imports restored newest first return every table the first import touched to the pre-import state", async () => {
      expect(SNAPSHOTS).toHaveLength(5);
      for (const id of [...SNAPSHOTS].reverse()) {
        const res = await api("POST", `/import/snapshots/${id}/restore`);
        expect({ id, status: res.status, error: res.json?.error }).toEqual({ id, status: 200, error: undefined });
        expect(res.json).toMatchObject({ ok: true, snapshotId: id });
      }
      const now = await userState();
      // Table by table first (a readable failure), then the whole state.
      for (const key of Object.keys(PRE) as Array<keyof typeof PRE>) {
        expect({ [key]: now[key] }).toEqual({ [key]: PRE[key] });
      }
      expect(now).toEqual(PRE);
      expect(await totals()).toEqual(PRE_TOTALS);
    });

    it("a second restore of the same snapshot is refused (409) and changes nothing", async () => {
      const before = await userState();
      const res = await api("POST", `/import/snapshots/${FIRST_SNAPSHOT}/restore`);
      expect(res.status).toBe(409);
      expect(res.json!.error).toBe("This import was already restored.");
      expect(await userState()).toEqual(before);
    });
  });
});

// Runs last: its rows share the household, so it must not run before the totals checks above.
describe("restore, a payment claim whose bank row sits two chunks later", () => {
  it("puts back a confirmed claim listed BEFORE the bank row that confirms it (500-row chunks)", async () => {
    const own = { userId: CLAIM_USER, householdId: TEST_HOUSEHOLD_ID };
    const bank = await db
      .insert(transactionsTable)
      .values(
        Array.from({ length: 520 }, (_, i) => ({
          ...own,
          occurredOn: OLD_DAY,
          description: `SYNTH BANK ROW ${i}`,
          amount: "-1.00",
          source: "plaid:chase",
          plaidTransactionId: `v-claim-${RUN}-${i}`,
        })),
      )
      .returning({ id: transactionsTable.id });
    const target = bank[519]!.id;
    const [claim] = await db
      .insert(transactionsTable)
      .values({ ...own, occurredOn: OLD_DAY, description: "SYNTH LOGGED PAYMENT", amount: "-1.00", source: "manual", paymentState: "confirmed", confirmedByTxnId: target })
      .returning();
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.userId, CLAIM_USER));
    // The claim first, its bank row last (index 520: the second chunk).
    const ordered = [rows.find((r) => r.id === claim!.id)!, ...rows.filter((r) => r.id !== claim!.id && r.id !== target), rows.find((r) => r.id === target)!];
    const empty = { budgetCategories: [], debts: [], budgetMonths: [], budgetLines: [], recurringItems: [], mappingRules: [], monthlySnapshots: [] };
    // (W) A restore needs the state its import left, to see that nothing
    // changed since: here that state is the rows as they stand.
    const [batch] = await db
      .insert(importBatchesTable)
      .values({ userId: CLAIM_USER, householdId: TEST_HOUSEHOLD_ID, filename: "claims.xlsx", summary: { v: 1, after: fingerprintOf(await readImportState(db, CLAIM_USER)) } })
      .returning();
    const [snap] = await db
      .insert(importSnapshotsTable)
      .values({ userId: CLAIM_USER, householdId: TEST_HOUSEHOLD_ID, importBatchId: batch!.id, payload: { ...empty, transactions: JSON.parse(JSON.stringify(ordered)) }, status: "available" })
      .returning();
    const res = await api("POST", `/import/snapshots/${snap!.id}/restore`, "claims");
    expect(res.status).toBe(200);
    expect(res.json!.counts.transactions).toBe(521);
    const back = byId(await db.select().from(transactionsTable).where(eq(transactionsTable.userId, CLAIM_USER)));
    expect(back).toEqual(byId(rows));
    expect(back.find((r) => r.id === claim!.id)!.confirmedByTxnId).toBe(target);
  });
});

void addDaysISO;
