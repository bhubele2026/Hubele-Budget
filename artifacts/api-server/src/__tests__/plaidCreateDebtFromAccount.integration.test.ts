import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";
import { isUniqueViolation, PG_UNIQUE_VIOLATION } from "../routes/plaid";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

const fetchLiabilitiesCalls: Array<{ userId: string; itemId: string }> = [];
vi.mock("../lib/plaidLiabilities", () => ({
  fetchLiabilitiesForItem: async (userId: string, itemId: string) => {
    fetchLiabilitiesCalls.push({ userId, itemId });
    return { updated: 0 };
  },
}));

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
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
  fetchLiabilitiesCalls.length = 0;
});

async function insertCreditAccount(opts: {
  userId?: string;
  institutionName?: string;
  name?: string;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  liabilityKind?: string | null;
  balance?: string | null;
  apr?: string | null;
  minPayment?: string | null;
} = {}): Promise<{ itemId: string; plaidAccountId: string }> {
  const userId = opts.userId ?? TEST_USER;
  const label = opts.institutionName ?? "Chase";
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId,
      itemId: `item-${label}-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: label,
      institutionSlug: label.toLowerCase(),
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId,
      itemId: item!.id,
      accountId: `acct-${label}-${randomUUID()}`,
      name: opts.name ?? "Sapphire Preferred",
      mask: opts.mask ?? "1234",
      type: opts.type === undefined ? "credit" : opts.type,
      subtype: opts.subtype === undefined ? "credit card" : opts.subtype,
      liabilityKind:
        opts.liabilityKind === undefined ? "credit" : opts.liabilityKind,
      liabilityBalance: opts.balance ?? "1234.56",
      liabilityApr: opts.apr ?? "0.2199",
      liabilityMinPayment: opts.minPayment ?? "35.00",
      liabilityLastFetchedAt: new Date(),
    })
    .returning();
  return { itemId: item!.id, plaidAccountId: acct!.id };
}

describe("isUniqueViolation", () => {
  it("recognizes 23505 on err.code", () => {
    expect(isUniqueViolation({ code: PG_UNIQUE_VIOLATION })).toBe(true);
  });
  it("recognizes 23505 on err.cause.code (drizzle/pg wrapped error)", () => {
    expect(
      isUniqueViolation({
        message: "wrapped",
        cause: { code: PG_UNIQUE_VIOLATION },
      }),
    ).toBe(true);
  });
  it("returns false for other PG codes and non-errors", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("POST /plaid/liability-accounts/:plaidAccountId/create-debt", () => {
  it("creates a brand-new debt with plaid sources and stamps lastSyncedAt", async () => {
    const { plaidAccountId } = await insertCreditAccount({
      institutionName: "Chase",
      name: "Sapphire Preferred",
      mask: "9012",
      balance: "2500.50",
      apr: "0.1899",
      minPayment: "75.00",
    });

    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      action: string;
      debt: {
        id: string;
        name: string;
        balance: string;
        apr: string;
        minPayment: string;
        type: string;
        balanceSource: string;
        aprSource: string;
        minPaymentSource: string;
        plaidAccountId: string;
        plaidLastSyncedAt: string | null;
      };
    };
    expect(body.action).toBe("created");
    expect(body.debt.name).toBe("Chase ••9012");
    expect(body.debt.type).toBe("credit_card");
    expect(Number(body.debt.balance)).toBeCloseTo(2500.5);
    expect(Number(body.debt.apr)).toBeCloseTo(0.1899);
    expect(Number(body.debt.minPayment)).toBeCloseTo(75);
    expect(body.debt.balanceSource).toBe("plaid");
    expect(body.debt.aprSource).toBe("plaid");
    expect(body.debt.minPaymentSource).toBe("plaid");
    expect(body.debt.plaidAccountId).toBe(plaidAccountId);
    expect(body.debt.plaidLastSyncedAt).not.toBeNull();

    expect(fetchLiabilitiesCalls).toHaveLength(1);
    expect(fetchLiabilitiesCalls[0]!.userId).toBe(TEST_USER);

    const [persisted] = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.id, body.debt.id));
    expect(persisted!.originalBalance).toBe("2500.50");
    expect(persisted!.plaidAccountId).toBe(plaidAccountId);
  });

  it("dedupes by name: links an existing same-name debt instead of creating a duplicate", async () => {
    const { plaidAccountId } = await insertCreditAccount({
      institutionName: "Amex",
      mask: "5678",
    });
    const [existing] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        name: "Amex ••5678",
        balance: "100",
        apr: "0",
        minPayment: "10",
        payment: "10",
        type: "credit_card",
      })
      .returning();

    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      action: string;
      debt: { id: string; plaidAccountId: string };
    };
    expect(body.action).toBe("linked-existing");
    expect(body.debt.id).toBe(existing!.id);
    expect(body.debt.plaidAccountId).toBe(plaidAccountId);

    const all = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.userId, TEST_USER));
    expect(all).toHaveLength(1);
  });

  it("returns 409 when the plaid account is already linked to a debt", async () => {
    const { plaidAccountId } = await insertCreditAccount();
    const [existing] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        name: "Already Linked",
        balance: "0",
        apr: "0",
        minPayment: "0",
        payment: "0",
        type: "credit_card",
        plaidAccountId,
        balanceSource: "plaid",
      })
      .returning();

    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { debtId: string; debtName: string };
    expect(body.debtId).toBe(existing!.id);
    expect(body.debtName).toBe("Already Linked");

    const all = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.userId, TEST_USER));
    expect(all).toHaveLength(1);
  });

  it("returns 404 for an unknown plaid account id", async () => {
    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${randomUUID()}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for another user's plaid account", async () => {
    const { plaidAccountId } = await insertCreditAccount({ userId: OTHER_USER });
    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("maps construction loan subtype to type=loan (not credit_card)", async () => {
    const { plaidAccountId } = await insertCreditAccount({
      institutionName: "BuildBank",
      mask: "0001",
      type: "loan",
      subtype: "construction",
      liabilityKind: null,
    });
    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { debt: { type: string } };
    expect(body.debt.type).toBe("loan");
  });

  it("partial unique index blocks a second debt linked to the same plaid account", async () => {
    const { plaidAccountId } = await insertCreditAccount();
    // First debt: link succeeds via the endpoint.
    const first = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(first.status).toBe(201);
    // Second attempt: should be rejected (409) by the prelink check OR
    // the partial unique index. Either way the user must not end up with
    // two debts on the same Plaid account.
    const second = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(second.status).toBe(409);

    // And a direct DB insert mirroring a concurrent racer must also fail.
    let caught: unknown = null;
    try {
      await db.insert(debtsTable).values({
        userId: TEST_USER,
        name: "Racer",
        balance: "0",
        apr: "0",
        minPayment: "0",
        payment: "0",
        type: "credit_card",
        plaidAccountId,
      });
    } catch (e) {
      caught = e;
    }
    // The drizzle/pg error wrapper can put the SQLSTATE on .code or
    // surface it through .cause — accept either path.
    const code =
      caught &&
      typeof caught === "object" &&
      ((caught as { code?: string }).code ??
        (caught as { cause?: { code?: string } }).cause?.code);
    expect(code).toBe("23505");

    const all = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.userId, TEST_USER));
    const linked = all.filter((d) => d.plaidAccountId === plaidAccountId);
    expect(linked).toHaveLength(1);
  });

  it("rejects accounts that don't look like debts with 400", async () => {
    const { plaidAccountId } = await insertCreditAccount({
      type: "depository",
      subtype: "checking",
      liabilityKind: null,
    });
    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(400);
  });
});
