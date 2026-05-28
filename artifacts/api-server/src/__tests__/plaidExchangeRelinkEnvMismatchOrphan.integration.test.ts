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
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

import { createTestHousehold } from "./_helpers/testHousehold";

// (#659) Reproduce the exact production state behind this task: a
// `PLAID_ENV=production` server, a stale Chase row whose token starts
// with `access-sandbox-…` (the env-mismatch ghost from the pre-#654
// era), and a fresh re-link that mints a brand-new Plaid `item_id`
// because the user went through Link from scratch instead of update
// mode. The default test setup forces PLAID_ENV=sandbox so most of
// the suite can use sandbox-prefixed tokens; flip to production here
// (the same pattern plaidEnvMismatchToken.integration.test.ts uses)
// so the env-mismatch widening in cleanupMalformedTokenSiblings sees
// the same world the live server sees.
const PRIOR_PLAID_ENV = process.env.PLAID_ENV;
process.env.PLAID_ENV = "production";

const TEST_USER = `relink-envmismatch-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

let nextExchangeAccessToken = "access-production-fresh";
let nextExchangeItemId = "item-fresh";
let nextAccounts: Array<{
  account_id: string;
  name: string;
  type: string;
  subtype: string;
  mask: string;
}> = [];

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      itemPublicTokenExchange: async () => ({
        data: {
          access_token: nextExchangeAccessToken,
          item_id: nextExchangeItemId,
        },
      }),
      itemGet: async () => ({
        data: {
          item: {
            item_id: nextExchangeItemId,
            institution_id: "ins_chase",
            consent_expiration_time: null,
          },
        },
      }),
      institutionsGetById: async () => ({
        data: { institution: { name: "Chase" } },
      }),
      accountsGet: async () => ({ data: { accounts: nextAccounts } }),
      transactionsSync: async () => ({
        data: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "cursor-1",
          has_more: false,
        },
      }),
      transactionsGet: async () => ({
        data: { transactions: [], total_transactions: 0 },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      liabilitiesGet: async () => ({
        data: { liabilities: {}, accounts: [] },
      }),
    }),
  };
});

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  next();
});
app.use(plaidRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
  if (PRIOR_PLAID_ENV === undefined) delete process.env.PLAID_ENV;
  else process.env.PLAID_ENV = PRIOR_PLAID_ENV;
});

beforeEach(async () => {
  await cleanup();
  nextAccounts = [];
});

describe("(#659) /plaid/exchange auto-archives env-mismatched orphan rows on relink", () => {
  it("removes the sandbox-prefixed Chase ghost when the user re-links Chase against a production server", async () => {
    // Pre-seed: a single env-mismatched orphan Chase row exactly like
    // the one observed in production (`98525ee7-…`, mask 0000,
    // `access-sandbox-…` token). No healthy sibling yet — we're
    // simulating the moment BEFORE the user clicks Reconnect.
    const orphanItemId = `chase-orphan-${randomUUID().slice(0, 8)}`;
    const [orphan] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: orphanItemId,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_chase",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    expect(orphan).toBeDefined();

    // The user re-links Chase from scratch. Plaid mints a brand-new
    // `item_id`, so the upsert in /plaid/exchange (keyed on item_id)
    // does NOT collide with the orphan — without this task, the
    // orphan would survive the request as a permanent ghost.
    nextExchangeItemId = `chase-item-fresh-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-production-${randomUUID()}`;
    nextAccounts = [
      {
        account_id: `chase-5526-fresh-${randomUUID().slice(0, 8)}`,
        name: "Chase ··5526",
        type: "depository",
        subtype: "checking",
        mask: "5526",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicToken: "public-production-relink",
        institutionId: "ins_chase",
        institutionName: "Chase",
      }),
    });
    expect(r.status).toBe(200);

    // Critical assertion for #659: by the time /plaid/exchange
    // returns, the env-mismatched orphan row is gone. The user-
    // visible Settings → Linked banks list contains exactly one
    // Chase row (the fresh one). The orphan can never re-fail a
    // backend cron sync because it no longer exists.
    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER));
    expect(items).toHaveLength(1);
    expect(items[0]!.itemId).toBe(nextExchangeItemId);
    expect(items[0]!.accessToken).toMatch(/^access-production-/);
    // The orphan id is gone — assert by id explicitly so a future
    // refactor that leaves the row but flags it would still fail.
    expect(items.find((it) => it.id === orphan!.id)).toBeUndefined();

    // (#659, code-review feedback) Walk the user-visible API path,
    // not just the raw table — the Settings → Linked banks list is
    // what the user actually sees and is the ultimate contract for
    // this task. /plaid/items filters by householdId and hides
    // synthetic rows, so a regression that left the orphan in the
    // DB but somehow filtered it out here would still be a bug.
    const itemsResp = await fetch(`${baseUrl}/plaid/items`);
    expect(itemsResp.status).toBe(200);
    const itemsBody = (await itemsResp.json()) as Array<{
      itemId: string;
      institutionName: string | null;
    }>;
    expect(itemsBody).toHaveLength(1);
    expect(itemsBody[0]!.itemId).toBe(nextExchangeItemId);
    expect(itemsBody[0]!.institutionName).toBe("Chase");
  });

  // (#790) Regression: when the env-mismatched / malformed-token
  // sibling still has live data attached (transactions or linked
  // debts), the cleanup MUST preserve the row instead of silently
  // deleting it. The user heals it via the Reconnect button; data is
  // never lost behind their back.
  it("(#790) preserves a stale sibling that still has live transactions", async () => {
    const orphanItemId = `chase-stale-${randomUUID().slice(0, 8)}`;
    const [orphan] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: orphanItemId,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_chase",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    // Seed a plaid_accounts row + a transaction whose
    // plaid_account_id (text) matches the external account_id. This
    // is exactly the shape of the production Chase checking row that
    // task #790 documented.
    const staleExternalAcctId = `chase-5526-stale-${randomUUID().slice(0, 8)}`;
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: orphan!.id,
      accountId: staleExternalAcctId,
      name: "TOTAL CHECKING",
      mask: "5526",
      type: "depository",
      subtype: "checking",
    });
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-15",
      description: "Pre-existing Chase checking txn",
      amount: "-42.00",
      account: "Chase",
      source: "plaid:chase",
      plaidAccountId: staleExternalAcctId,
    });

    nextExchangeItemId = `chase-item-fresh3-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-production-${randomUUID()}`;
    nextAccounts = [
      {
        account_id: `chase-7844-fresh-${randomUUID().slice(0, 8)}`,
        name: "Prime Visa",
        type: "credit",
        subtype: "credit card",
        mask: "7844",
      },
    ];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicToken: "public-production-debt-relink",
        institutionId: "ins_chase",
        institutionName: "Chase",
      }),
    });
    expect(r.status).toBe(200);

    // Stale sibling must STILL exist — and its checking transaction
    // must still be present. The new credit-card item is added
    // alongside, not in place of, the prior checking item.
    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER));
    expect(items.find((it) => it.id === orphan!.id)).toBeDefined();
    expect(items.find((it) => it.itemId === nextExchangeItemId)).toBeDefined();
    const survivingTxns = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(survivingTxns).toHaveLength(1);
    expect(survivingTxns[0]!.plaidAccountId).toBe(staleExternalAcctId);
  });

  it("leaves a healthy sibling alone when only the orphan should be cleaned", async () => {
    // A user with the production scenario after relink: one healthy
    // production-token row already exists, AND the sandbox-prefixed
    // ghost is still hanging around. A second relink (or any
    // subsequent successful exchange for the same institution)
    // should sweep the ghost without touching the healthy row.
    const healthyItemId = `chase-healthy-${randomUUID().slice(0, 8)}`;
    const [healthy] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: healthyItemId,
        accessToken: `access-production-${randomUUID()}`,
        institutionId: "ins_chase",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const orphanItemId = `chase-orphan-${randomUUID().slice(0, 8)}`;
    await db.insert(plaidItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: orphanItemId,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_chase",
      institutionName: "Chase",
      institutionSlug: "chase",
    });

    nextExchangeItemId = `chase-item-fresh2-${randomUUID().slice(0, 8)}`;
    nextExchangeAccessToken = `access-production-${randomUUID()}`;
    nextAccounts = [];

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicToken: "public-production-relink",
        institutionId: "ins_chase",
        institutionName: "Chase",
      }),
    });
    expect(r.status).toBe(200);

    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER));
    // The original healthy row survives, the env-mismatch orphan is
    // gone, and the brand-new survivor row was inserted. Neither of
    // the two production-token rows is touched by the cleanup.
    const productionRows = items.filter((it) =>
      (it.accessToken ?? "").startsWith("access-production-"),
    );
    const sandboxRows = items.filter((it) =>
      (it.accessToken ?? "").startsWith("access-sandbox-"),
    );
    expect(sandboxRows).toHaveLength(0);
    expect(productionRows.length).toBeGreaterThanOrEqual(1);
    expect(items.find((it) => it.id === healthy!.id)).toBeDefined();
  });
});
