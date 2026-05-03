import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

const itemRemoveCalls: string[] = [];
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      itemRemove: async ({ access_token }: { access_token: string }) => {
        itemRemoveCalls.push(access_token);
        return { data: { request_id: "test" } };
      },
    }),
  };
});

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";

const app = express();
app.use(express.json());
// pino-http req.log shim used by route handlers
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
  for (const userId of [TEST_USER, OTHER_USER]) {
    await db.delete(debtsTable).where(eq(debtsTable.userId, userId));
    await db
      .delete(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, userId));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, userId));
  }
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
  itemRemoveCalls.length = 0;
});

async function insertItem(
  userId: string,
  accessToken: string,
  label: string,
): Promise<{ itemId: string; accountId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId,
      itemId: `item-${label}-${randomUUID()}`,
      accessToken,
      institutionName: label,
      institutionSlug: label,
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId,
      itemId: item!.id,
      accountId: `acct-${label}-${randomUUID()}`,
      name: label,
      type: "credit",
      subtype: "credit card",
    })
    .returning();
  return { itemId: item!.id, accountId: acct!.id };
}

async function insertDebt(
  plaidAccountId: string,
  name: string,
): Promise<string> {
  const [d] = await db
    .insert(debtsTable)
    .values({
      userId: TEST_USER,
      name,
      balance: "1000",
      apr: "0.20",
      minPayment: "50",
      payment: "50",
      plaidAccountId,
      balanceSource: "plaid",
      aprSource: "plaid",
      minPaymentSource: "plaid",
      plaidLastSyncedAt: new Date(),
    })
    .returning();
  return d!.id;
}

describe("POST /plaid/cleanup-non-prod", () => {
  it("removes only sandbox/development items and resets their linked debts to manual", async () => {
    const sandbox = await insertItem(
      TEST_USER,
      "access-sandbox-aaaaaaaa",
      "sbox",
    );
    const dev = await insertItem(
      TEST_USER,
      "access-development-bbbbbbbb",
      "devv",
    );
    const prod = await insertItem(
      TEST_USER,
      "access-production-cccccccc",
      "prod",
    );
    const malformed = await insertItem(
      TEST_USER,
      "synthetic-no-access",
      "synth",
    );

    const sandboxDebtId = await insertDebt(sandbox.accountId, "Sandbox Card");
    const devDebtId = await insertDebt(dev.accountId, "Dev Card");
    const prodDebtId = await insertDebt(prod.accountId, "Prod Card");

    const res = await fetch(`${baseUrl}/plaid/cleanup-non-prod`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: number };
    expect(body.removed).toBe(2);

    // itemRemove was called for the two non-prod tokens (best-effort)
    expect(itemRemoveCalls.sort()).toEqual([
      "access-development-bbbbbbbb",
      "access-sandbox-aaaaaaaa",
    ]);

    // Remaining items: only production + malformed (env=null is left alone)
    const remainingItems = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER));
    const remainingIds = remainingItems.map((i) => i.id).sort();
    expect(remainingIds).toEqual([prod.itemId, malformed.itemId].sort());

    // Their accounts survive
    const remainingAccts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    const remainingAcctIds = remainingAccts.map((a) => a.id).sort();
    expect(remainingAcctIds).toEqual(
      [prod.accountId, malformed.accountId].sort(),
    );

    // Debts: sandbox/dev debts have source flags reset and link cleared
    // (FK ON DELETE SET NULL); prod debt is untouched.
    const debts = await db
      .select()
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, TEST_USER),
          inArray(debtsTable.id, [sandboxDebtId, devDebtId, prodDebtId]),
        ),
      );
    const byId = new Map(debts.map((d) => [d.id, d]));

    const sandDebt = byId.get(sandboxDebtId)!;
    expect(sandDebt.balanceSource).toBe("manual");
    expect(sandDebt.aprSource).toBe("manual");
    expect(sandDebt.minPaymentSource).toBe("manual");
    expect(sandDebt.plaidLastSyncedAt).toBeNull();
    expect(sandDebt.plaidAccountId).toBeNull();

    const devDebt = byId.get(devDebtId)!;
    expect(devDebt.balanceSource).toBe("manual");
    expect(devDebt.aprSource).toBe("manual");
    expect(devDebt.minPaymentSource).toBe("manual");
    expect(devDebt.plaidLastSyncedAt).toBeNull();
    expect(devDebt.plaidAccountId).toBeNull();

    const prodDebt = byId.get(prodDebtId)!;
    expect(prodDebt.balanceSource).toBe("plaid");
    expect(prodDebt.aprSource).toBe("plaid");
    expect(prodDebt.minPaymentSource).toBe("plaid");
    expect(prodDebt.plaidLastSyncedAt).not.toBeNull();
    expect(prodDebt.plaidAccountId).toBe(prod.accountId);
  });

  it("is a no-op when the user only has production items", async () => {
    const prod = await insertItem(
      TEST_USER,
      "access-production-onlyprod",
      "prod",
    );
    const debtId = await insertDebt(prod.accountId, "Prod Only");

    const res = await fetch(`${baseUrl}/plaid/cleanup-non-prod`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 0 });
    expect(itemRemoveCalls).toEqual([]);

    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER));
    expect(items).toHaveLength(1);

    const [debt] = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.id, debtId));
    expect(debt!.balanceSource).toBe("plaid");
    expect(debt!.plaidAccountId).toBe(prod.accountId);
  });

  it("does not touch other users' non-prod items", async () => {
    const otherSandbox = await insertItem(
      OTHER_USER,
      "access-sandbox-otheruser",
      "other",
    );

    const res = await fetch(`${baseUrl}/plaid/cleanup-non-prod`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 0 });
    expect(itemRemoveCalls).toEqual([]);

    const stillThere = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, otherSandbox.itemId));
    expect(stillThere).toHaveLength(1);
  });
});
