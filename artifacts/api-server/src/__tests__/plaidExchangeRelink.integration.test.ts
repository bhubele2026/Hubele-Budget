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

const TEST_USER = `relink-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

// (#367) The exchange route mints a fresh access_token via Plaid Link
// and then upserts the row keyed on the *external* item_id. We control
// what Plaid returns so the test can drive every branch we care about:
// brand-new item (relinked:false), re-link of a chip-flagged row
// (relinked:true → fields cleared), and the no-duplicate-on-relink
// guarantee (#361 cutoff + ±7-day merge survives a relink round-trip).
let nextExchangeAccessToken = "access-sandbox-fresh";
let nextExchangeItemId = "item-fresh";
type AddedTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
};
let nextAccounts: Array<{
  account_id: string;
  name: string;
  type: string;
  subtype: string;
  mask: string;
}> = [];
let nextSyncResponse: {
  added: AddedTxn[];
  modified: AddedTxn[];
  removed: { transaction_id: string }[];
} = { added: [], modified: [], removed: [] };

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
            institution_id: "ins_56",
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
          added: nextSyncResponse.added,
          modified: nextSyncResponse.modified,
          removed: nextSyncResponse.removed,
          next_cursor: "cursor-1",
          has_more: false,
        },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      liabilitiesGet: async () => ({ data: { liabilities: {}, accounts: [] } }),
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
});

beforeEach(async () => {
  await cleanup();
  nextAccounts = [];
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

describe("(#367) /plaid/exchange relink self-heal", () => {
  it("returns relinked:false on a brand-new link of an item this user has never seen", async () => {
    nextExchangeItemId = `item-${randomUUID()}`;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-x" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { relinked: boolean; itemId: string };
    expect(body.relinked).toBe(false);
    expect(body.itemId).toBe(nextExchangeItemId);
  });

  it("returns relinked:true and clears the chip when re-exchanging an existing flagged item", async () => {
    nextExchangeItemId = `item-${randomUUID()}`;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;

    // Seed a chip-flagged row keyed on the same external item_id the
    // mocked exchange will return — simulates the "Chase needs
    // reconnect" state the user is trying to clear.
    await db.insert(plaidItemsTable).values({
      userId: TEST_USER,
      itemId: nextExchangeItemId,
      accessToken: "stale-access-token-do-not-use",
      institutionId: "ins_56",
      institutionName: "Chase",
      institutionSlug: "chase",
      lastSyncError: "the login details of this item have changed",
      lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      stillPreparingSince: new Date(),
      consentExpirationLastRefreshError: "stale",
      consentExpirationLastRefreshErrorCode: "STALE",
    });

    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-y" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      relinked: boolean;
      lastSyncError: string | null;
      lastSyncErrorCode: string | null;
    };
    expect(body.relinked).toBe(true);
    expect(body.lastSyncError).toBeNull();
    expect(body.lastSyncErrorCode).toBeNull();

    // And the persisted row really did get scrubbed — not just the
    // response body. This is the bit that stops the previous reconnect
    // loop where the next /sync would re-read the stale chip.
    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.itemId, nextExchangeItemId));
    expect(row.lastSyncError).toBeNull();
    expect(row.lastSyncErrorCode).toBeNull();
    expect(row.stillPreparingSince).toBeNull();
    expect(row.consentExpirationLastRefreshError).toBeNull();
    expect(row.consentExpirationLastRefreshErrorCode).toBeNull();
    expect(row.accessToken).toBe(nextExchangeAccessToken);
  });

  // (#367 hard constraint) Re-linking an existing chip-flagged item
  // must NOT duplicate the user's pre-May manual history and must NOT
  // reset the import_cutoff_date that already gates the first sync.
  // This test seeds the exact shape from the bug report — manual April
  // rows, an Amex-style cutoff already on file — relinks the item,
  // runs a sync that returns overlapping April rows from Plaid, and
  // asserts: pre-cutoff manual rows are preserved verbatim, no
  // duplicates land, and the cutoff column is unchanged.
  it("preserves pre-May manual history and the import cutoff across a relink round-trip", async () => {
    const externalItemId = `item-${randomUUID()}`;
    const externalAcctId = `acct-${randomUUID()}`;
    nextExchangeItemId = externalItemId;
    nextExchangeAccessToken = `access-sandbox-${randomUUID()}`;
    nextAccounts = [
      {
        account_id: externalAcctId,
        name: "Chase Sapphire",
        type: "credit",
        subtype: "credit card",
        mask: "1234",
      },
    ];

    // Seed: chip-flagged Plaid item, one credit account with a cutoff
    // already on record, a linked debt, and three pre-May manual rows.
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: externalItemId,
        accessToken: "stale-token-do-not-use",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
        lastSyncError: "stale",
      })
      .returning();
    const PRE_EXISTING_CUTOFF = "2026-04-30";
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: externalAcctId,
        name: "Chase Sapphire",
        type: "credit",
        subtype: "credit card",
        mask: "1234",
        importCutoffDate: PRE_EXISTING_CUTOFF,
      })
      .returning();
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        name: "Chase Sapphire",
        balance: "1500",
        plaidAccountId: acct!.id,
      })
      .returning();
    const manualRows = [
      { occurredOn: "2026-04-12", amount: "-42.00", description: "manual apr 12" },
      { occurredOn: "2026-04-20", amount: "-15.50", description: "manual apr 20" },
      { occurredOn: "2026-04-28", amount: "-99.00", description: "manual apr 28" },
    ];
    for (const r of manualRows) {
      await db.insert(transactionsTable).values({
        userId: TEST_USER,
        occurredOn: r.occurredOn,
        description: r.description,
        amount: r.amount,
        source: "manual",
        debtId: debt!.id,
      });
    }

    // Plaid will return overlapping April rows on the first post-relink
    // sync (the same rows the user already has manually) plus one
    // genuinely new May row.
    nextSyncResponse = {
      added: [
        // Overlap with manual apr 12 — must be skipped by cutoff gate.
        {
          transaction_id: "plaid-apr-12",
          account_id: externalAcctId,
          date: "2026-04-12",
          amount: 42.0,
          name: "Plaid duplicate apr 12",
        },
        // Overlap with manual apr 28 — must be skipped by cutoff gate.
        {
          transaction_id: "plaid-apr-28",
          account_id: externalAcctId,
          date: "2026-04-28",
          amount: 99.0,
          name: "Plaid duplicate apr 28",
        },
        // New May row outside the ±7-day merge window — must be added
        // verbatim (post-cutoff, no manual overlap, simple insert path).
        {
          transaction_id: "plaid-may-15",
          account_id: externalAcctId,
          date: "2026-05-15",
          amount: 11.11,
          name: "Plaid genuine may 15",
        },
      ],
      modified: [],
      removed: [],
    };

    const r = await fetch(`${baseUrl}/plaid/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken: "public-sandbox-relink" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { relinked: boolean };
    expect(body.relinked).toBe(true);

    // 1. Cutoff preserved (NOT overwritten by autoDetectCutoffsForItem)
    const [acctAfter] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acct!.id));
    expect(acctAfter.importCutoffDate).toBe(PRE_EXISTING_CUTOFF);

    // 2. Pre-May manual rows untouched (count + same descriptions)
    const allRows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    const manualSurvivors = allRows.filter((r) => r.source === "manual");
    expect(manualSurvivors).toHaveLength(3);
    const manualDescs = manualSurvivors.map((r) => r.description).sort();
    expect(manualDescs).toEqual([
      "manual apr 12",
      "manual apr 20",
      "manual apr 28",
    ]);

    // 3. No *new* (insert-path) Plaid rows for April dates the manual
    //    history already covered. The ±7-day merge from #361 may have
    //    adopted plaid_transaction_id onto an existing manual row
    //    in-place — that's the desired behavior, not a duplicate. A
    //    duplicate would look like a brand-new row with source starting
    //    with "plaid" (e.g. "plaid:chase") whose date is on/before cutoff.
    const isPlaidSourced = (s: string | null) =>
      typeof s === "string" && s.startsWith("plaid");
    const aprilPlaidInserts = allRows.filter(
      (r) => isPlaidSourced(r.source) && r.occurredOn < "2026-05-01",
    );
    expect(aprilPlaidInserts).toHaveLength(0);

    // 4. The genuinely new post-cutoff May row DID land via the insert
    //    path (source starts with "plaid:", debtId left null because the
    //    sign convention treats purchases as unattached to the debt).
    const mayPlaidInserts = allRows.filter(
      (r) => isPlaidSourced(r.source) && r.occurredOn >= "2026-05-01",
    );
    expect(mayPlaidInserts).toHaveLength(1);
    expect(mayPlaidInserts[0].occurredOn).toBe("2026-05-15");
    expect(mayPlaidInserts[0].plaidTransactionId).toBe("plaid-may-15");
  });
});
