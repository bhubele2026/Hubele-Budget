import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `webhook-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

// Per-call counters & mutable mocks so each test can assert "did the
// webhook actually trigger a sync?" / "did it call /item/get to refresh
// consent?" without rebuilding the whole Plaid mock object.
const transactionsSyncCalls: Array<{ access_token: string }> = [];
let transactionsSyncMock: (args: {
  access_token: string;
  cursor?: string;
  count?: number;
}) => Promise<unknown> = async () => ({
  data: {
    added: [],
    modified: [],
    removed: [],
    next_cursor: "",
    has_more: false,
  },
});

const itemGetCalls: Array<{ access_token: string }> = [];
let itemGetMock: (args: { access_token: string }) => Promise<unknown> = async () => ({
  data: { item: { item_id: "x", consent_expiration_time: null } },
});

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: (args: { access_token: string; cursor?: string; count?: number }) => {
        transactionsSyncCalls.push({ access_token: args.access_token });
        return transactionsSyncMock(args);
      },
      itemGet: (args: { access_token: string }) => {
        itemGetCalls.push({ access_token: args.access_token });
        return itemGetMock(args);
      },
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
    }),
  };
});

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";

// Disable webhook signature verification for this suite — the verifier path
// is exercised separately in plaidWebhookVerify.unit.test.ts.
process.env.PLAID_WEBHOOK_VERIFICATION_DISABLED = "true";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(plaidRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db
    .delete(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
}

async function seedItem(opts?: {
  externalItemId?: string;
  consentExpirationAt?: Date | null;
  lastSyncError?: string | null;
  lastSyncErrorCode?: string | null;
}): Promise<{ itemRowId: string; externalItemId: string; accessToken: string }> {
  const externalItemId = opts?.externalItemId ?? `item-${randomUUID()}`;
  const accessToken = `access-sandbox-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      itemId: externalItemId,
      accessToken,
      institutionName: "Chase",
      institutionSlug: "chase",
      consentExpirationAt: opts?.consentExpirationAt ?? null,
      lastSyncError: opts?.lastSyncError ?? null,
      lastSyncErrorCode: opts?.lastSyncErrorCode ?? null,
    })
    .returning();
  return { itemRowId: item!.id, externalItemId, accessToken };
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
  transactionsSyncCalls.length = 0;
  itemGetCalls.length = 0;
  transactionsSyncMock = async () => ({
    data: {
      added: [],
      modified: [],
      removed: [],
      next_cursor: "",
      has_more: false,
    },
  });
  itemGetMock = async () => ({
    data: { item: { item_id: "x", consent_expiration_time: null } },
  });
});

describe("POST /plaid/webhook — TRANSACTIONS events", () => {
  it("triggers syncPlaidItem on SYNC_UPDATES_AVAILABLE for the matching item", async () => {
    const { externalItemId, accessToken } = await seedItem();

    const res = await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: externalItemId,
      }),
    });
    expect(res.status).toBe(200);
    expect(transactionsSyncCalls).toEqual([{ access_token: accessToken }]);
  });

  it("ignores TRANSACTIONS webhook codes we do not handle (e.g. RECURRING_*)", async () => {
    const { externalItemId } = await seedItem();
    const res = await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhook_type: "TRANSACTIONS",
        webhook_code: "RECURRING_TRANSACTIONS_UPDATE",
        item_id: externalItemId,
      }),
    });
    expect(res.status).toBe(200);
    expect(transactionsSyncCalls).toEqual([]);
  });

  it("returns 200 (not 404) for unknown item_id so Plaid stops retrying", async () => {
    const res = await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "item-does-not-exist-xyz",
      }),
    });
    expect(res.status).toBe(200);
    expect(transactionsSyncCalls).toEqual([]);
  });

  it("returns 400 when item_id is missing from a verified webhook", async () => {
    const res = await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhook_type: "TRANSACTIONS" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /plaid/webhook — ITEM events surface to lastSyncError", () => {
  it("writes ITEM_LOGIN_REQUIRED into lastSyncError + lastSyncErrorCode (the Re-link button trigger)", async () => {
    const { itemRowId, externalItemId } = await seedItem();
    const res = await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: externalItemId,
        error: {
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message:
            "the login details of this item have changed (credentials, MFA, or username)",
          error_type: "ITEM_ERROR",
        },
      }),
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(row?.lastSyncError).toMatch(/login/i);
  });

  it("falls back to friendly copy when Plaid omits error_message on ITEM/ERROR", async () => {
    const { itemRowId, externalItemId } = await seedItem();
    await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: externalItemId,
        error: { error_code: "ITEM_LOGIN_REQUIRED" },
      }),
    });
    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(row?.lastSyncError).toMatch(/Reconnect/);
  });

  it("PENDING_EXPIRATION writes the reauth chip AND opportunistically refreshes consent_expiration_at", async () => {
    const { itemRowId, externalItemId, accessToken } = await seedItem();
    const fresh = "2026-09-15T12:00:00.000Z";
    itemGetMock = async () => ({
      data: { item: { item_id: "x", consent_expiration_time: fresh } },
    });

    const res = await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhook_type: "ITEM",
        webhook_code: "PENDING_EXPIRATION",
        item_id: externalItemId,
        consent_expiration_time: fresh,
      }),
    });
    expect(res.status).toBe(200);
    expect(itemGetCalls).toEqual([{ access_token: accessToken }]);

    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("PENDING_EXPIRATION");
    expect(row?.consentExpirationAt?.toISOString()).toBe(fresh);
  });

  it("LOGIN_REPAIRED clears the error chip and re-runs sync", async () => {
    const { itemRowId, externalItemId, accessToken } = await seedItem({
      lastSyncError: "Your saved login expired.",
      lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
    });

    const res = await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhook_type: "ITEM",
        webhook_code: "LOGIN_REPAIRED",
        item_id: externalItemId,
      }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncError).toBeNull();
    expect(row?.lastSyncErrorCode).toBeNull();
    expect(transactionsSyncCalls).toEqual([{ access_token: accessToken }]);
  });

  it("USER_PERMISSION_REVOKED writes a clear actionable error", async () => {
    const { itemRowId, externalItemId } = await seedItem();
    await fetch(`${baseUrl}/plaid/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhook_type: "ITEM",
        webhook_code: "USER_PERMISSION_REVOKED",
        item_id: externalItemId,
      }),
    });
    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("USER_PERMISSION_REVOKED");
    expect(row?.lastSyncError).toMatch(/revoked/i);
  });
});

describe("POST /plaid/webhook — signature verification", () => {
  it("rejects with 401 when Plaid-Verification header is missing and verification is enabled", async () => {
    const original = process.env.PLAID_WEBHOOK_VERIFICATION_DISABLED;
    process.env.PLAID_WEBHOOK_VERIFICATION_DISABLED = "false";
    try {
      const { externalItemId } = await seedItem();
      const res = await fetch(`${baseUrl}/plaid/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          webhook_type: "TRANSACTIONS",
          webhook_code: "SYNC_UPDATES_AVAILABLE",
          item_id: externalItemId,
        }),
      });
      expect(res.status).toBe(401);
      // And critically, no sync was triggered.
      expect(transactionsSyncCalls).toEqual([]);
    } finally {
      process.env.PLAID_WEBHOOK_VERIFICATION_DISABLED = original;
    }
  });
});

describe("verifyPlaidWebhook helper (signature math)", () => {
  it("accepts a JWT we sign with a JWK Plaid would have returned", async () => {
    const { generateKeyPairSync } = crypto;
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const jwk = publicKey.export({ format: "jwk" }) as {
      kty: string;
      crv: string;
      x: string;
      y: string;
    };

    // Stand up a fresh isolated module graph that mocks
    // plaid().webhookVerificationKeyGet to return the JWK we just minted.
    vi.resetModules();
    vi.doMock("../lib/plaid", () => ({
      plaid: () => ({
        webhookVerificationKeyGet: async (_args: { key_id: string }) => ({
          data: {
            key: {
              alg: "ES256",
              kty: jwk.kty,
              crv: jwk.crv,
              x: jwk.x,
              y: jwk.y,
              kid: "test-kid",
              use: "sig",
              created_at: 0,
              expired_at: null,
            },
          },
        }),
      }),
    }));
    const { verifyPlaidWebhook, _resetJwkCacheForTests } = await import(
      "../lib/plaidWebhookVerify"
    );
    _resetJwkCacheForTests();

    const body = Buffer.from(
      JSON.stringify({
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "abc",
      }),
      "utf8",
    );
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const headerSeg = Buffer.from(
      JSON.stringify({ alg: "ES256", kid: "test-kid", typ: "JWT" }),
      "utf8",
    )
      .toString("base64url");
    const payloadSeg = Buffer.from(
      JSON.stringify({
        iat: Math.floor(Date.now() / 1000),
        request_body_sha256: bodyHash,
      }),
      "utf8",
    ).toString("base64url");
    const signed = `${headerSeg}.${payloadSeg}`;
    const sig = crypto.sign("sha256", Buffer.from(signed, "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    const jwt = `${signed}.${sig.toString("base64url")}`;

    const ok = await verifyPlaidWebhook(body, jwt);
    expect(ok.ok).toBe(true);

    // Body tampering must fail the same key.
    const tampered = await verifyPlaidWebhook(
      Buffer.concat([body, Buffer.from(" ", "utf8")]),
      jwt,
    );
    expect(tampered.ok).toBe(false);

    // Stale iat (older than maxAge) must fail.
    const staleIatPayload = Buffer.from(
      JSON.stringify({
        iat: Math.floor(Date.now() / 1000) - 60 * 60,
        request_body_sha256: bodyHash,
      }),
      "utf8",
    ).toString("base64url");
    const staleSigned = `${headerSeg}.${staleIatPayload}`;
    const staleSig = crypto.sign("sha256", Buffer.from(staleSigned, "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    const staleJwt = `${staleSigned}.${staleSig.toString("base64url")}`;
    const stale = await verifyPlaidWebhook(body, staleJwt);
    expect(stale.ok).toBe(false);
  });
});
