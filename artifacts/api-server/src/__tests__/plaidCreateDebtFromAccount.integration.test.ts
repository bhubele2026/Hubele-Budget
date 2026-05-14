import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";
import { isUniqueViolation, PG_UNIQUE_VIOLATION } from "../routes/plaid";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
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
  transactionsTable,
  settingsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import amexRouter from "../routes/amex";
import { createTestHousehold } from "./_helpers/testHousehold";

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
app.use(amexRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  for (const userId of [TEST_USER, OTHER_USER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, userId));
    await db.delete(debtsTable).where(eq(debtsTable.userId, userId));
    await db
      .delete(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, userId));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, userId));
    await db.delete(settingsTable).where(eq(settingsTable.userId, userId));
  }
}

beforeAll(async () => {
  const _h1 = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h1.householdId;
  const _h2 = await createTestHousehold(OTHER_USER);
  OTHER_HOUSEHOLD_ID = _h2.householdId;
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
  dueDay?: number | null;
  statementDay?: number | null;
} = {}): Promise<{
  itemId: string;
  plaidAccountId: string;
  accountId: string;
}> {
  const userId = opts.userId ?? TEST_USER;
  const householdId = userId === TEST_USER ? TEST_HOUSEHOLD_ID : OTHER_HOUSEHOLD_ID;
  const label = opts.institutionName ?? "Chase";
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId,
      householdId,
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
      householdId,
      itemId: item!.id,
      accountId: `acct-${label}-${randomUUID()}`,
      name: opts.name ?? "Sapphire Preferred",
      mask: opts.mask ?? "1234",
      type: opts.type === undefined ? "credit" : opts.type,
      subtype: opts.subtype === undefined ? "credit card" : opts.subtype,
      liabilityKind:
        opts.liabilityKind === undefined ? "credit" : opts.liabilityKind,
      liabilityBalance: "balance" in opts ? opts.balance : "1234.56",
      liabilityApr: "apr" in opts ? opts.apr : "0.2199",
      liabilityMinPayment: "minPayment" in opts ? opts.minPayment : "35.00",
      liabilityDueDay: opts.dueDay ?? null,
      liabilityStatementDay: opts.statementDay ?? null,
      liabilityLastFetchedAt: new Date(),
    })
    .returning();
  return {
    itemId: item!.id,
    plaidAccountId: acct!.id,
    accountId: acct!.accountId,
  };
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
      householdId: TEST_HOUSEHOLD_ID,
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

  it("marks all *_source columns as plaid even when suggested apr/minPayment are null (so future refresh adopts values)", async () => {
    // Plaid sometimes returns the account with no liabilities payload on
    // the first sync — APR / min payment land null in our cache. The
    // resulting debt must still be marked source=plaid so the next
    // refresh that *does* carry values can update the row instead of
    // being ignored as "user-entered manual".
    const { plaidAccountId } = await insertCreditAccount({
      apr: null,
      minPayment: null,
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
        apr: string | null;
        minPayment: string | null;
        balanceSource: string;
        aprSource: string;
        minPaymentSource: string;
      };
    };
    expect(body.action).toBe("created");
    // Schema NOT NULL defaults kick in (apr default "0", minPayment "0")
    // — what matters is the source columns are still flipped to "plaid".
    expect(body.debt.apr).toBe("0.0000");
    expect(body.debt.minPayment).toBe("0.00");
    expect(body.debt.balanceSource).toBe("plaid");
    expect(body.debt.aprSource).toBe("plaid");
    expect(body.debt.minPaymentSource).toBe("plaid");
  });

  it("flips a linked-existing debt's *_source columns to plaid even when suggested values are null", async () => {
    const { plaidAccountId } = await insertCreditAccount({
      institutionName: "Discover",
      mask: "9999",
      apr: null,
      minPayment: null,
    });
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Discover ••9999",
      balance: "500",
      apr: "0.15",
      minPayment: "25",
      payment: "25",
      type: "credit_card",
      balanceSource: "manual",
      aprSource: "manual",
      minPaymentSource: "manual",
    });

    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      action: string;
      debt: {
        apr: string | null;
        minPayment: string | null;
        balanceSource: string;
        aprSource: string;
        minPaymentSource: string;
      };
    };
    expect(body.action).toBe("linked-existing");
    // Pre-existing manual values are preserved (we don't overwrite with null)
    expect(body.debt.apr).toBe("0.1500");
    expect(body.debt.minPayment).toBe("25.00");
    // ...but sources are flipped so the next Plaid refresh wins.
    expect(body.debt.balanceSource).toBe("plaid");
    expect(body.debt.aprSource).toBe("plaid");
    expect(body.debt.minPaymentSource).toBe("plaid");
  });

  it("returns 409 when the plaid account is already linked to a debt", async () => {
    const { plaidAccountId } = await insertCreditAccount();
    const [existing] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
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
      householdId: TEST_HOUSEHOLD_ID,
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

  it("propagates dueDay/statementDay from cached liability data into the new debt", async () => {
    const { plaidAccountId } = await insertCreditAccount({
      institutionName: "Citi",
      mask: "4242",
      dueDay: 21,
      statementDay: 27,
    });
    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      debt: { id: string; dueDay: number | null; statementDay: number | null };
    };
    expect(body.debt.dueDay).toBe(21);
    expect(body.debt.statementDay).toBe(27);

    const [persisted] = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.id, body.debt.id));
    expect(persisted!.dueDay).toBe(21);
    expect(persisted!.statementDay).toBe(27);
  });
});

describe("GET /plaid/liability-accounts (suggestedDebt payload)", () => {
  it("includes dueDay and statementDay when Plaid cached them on the account", async () => {
    await insertCreditAccount({
      institutionName: "Discover",
      mask: "9000",
      dueDay: 14,
      statementDay: 20,
    });
    const res = await fetch(`${baseUrl}/plaid/liability-accounts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      mask: string | null;
      suggestedDebt: {
        name: string;
        type: string;
        balance: string | null;
        apr: string | null;
        minPayment: string | null;
        dueDay: number | null;
        statementDay: number | null;
      } | null;
    }>;
    const row = body.find((a) => a.mask === "9000");
    expect(row?.suggestedDebt).toBeTruthy();
    expect(row!.suggestedDebt!.dueDay).toBe(14);
    expect(row!.suggestedDebt!.statementDay).toBe(20);
    expect(row!.suggestedDebt!.name).toBe("Discover ••9000");
    expect(row!.suggestedDebt!.type).toBe("credit_card");
  });
});

describe("POST /plaid/liability-accounts/create-debts (bulk)", () => {
  it("creates, links-existing, skips already-linked, and skips not-debt-like in one call", async () => {
    // Fresh debt-like account → should be created
    const a = await insertCreditAccount({
      institutionName: "Chase",
      mask: "1111",
    });
    // Same-name debt exists → should be linked-existing (dedupe by name)
    const b = await insertCreditAccount({
      institutionName: "Amex",
      mask: "2222",
    });
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Amex ••2222",
      balance: "0",
      apr: "0",
      minPayment: "0",
      payment: "0",
      type: "credit_card",
    });
    // Already linked to a different debt → already-linked
    const c = await insertCreditAccount({
      institutionName: "Citi",
      mask: "3333",
    });
    const [taken] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
        name: "Pre-existing",
        balance: "0",
        apr: "0",
        minPayment: "0",
        payment: "0",
        type: "credit_card",
        plaidAccountId: c.plaidAccountId,
        balanceSource: "plaid",
      })
      .returning();
    // Not a debt account at all
    const d = await insertCreditAccount({
      institutionName: "Wells",
      mask: "4444",
      type: "depository",
      subtype: "checking",
      liabilityKind: null,
    });
    // Unknown plaid account id
    const unknownId = randomUUID();

    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/create-debts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accounts: [
            { plaidAccountId: a.plaidAccountId, name: "Chase Sapphire" },
            { plaidAccountId: b.plaidAccountId },
            { plaidAccountId: c.plaidAccountId },
            { plaidAccountId: d.plaidAccountId },
            { plaidAccountId: unknownId },
          ],
        }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      results: Array<{
        plaidAccountId: string;
        status: string;
        debtId?: string;
        debtName?: string;
      }>;
    };
    const byId = Object.fromEntries(body.results.map((r) => [r.plaidAccountId, r]));
    expect(byId[a.plaidAccountId]!.status).toBe("created");
    expect(byId[a.plaidAccountId]!.debtName).toBe("Chase Sapphire"); // name override applied
    expect(byId[b.plaidAccountId]!.status).toBe("linked-existing");
    expect(byId[c.plaidAccountId]!.status).toBe("already-linked");
    expect(byId[c.plaidAccountId]!.debtId).toBe(taken!.id);
    expect(byId[d.plaidAccountId]!.status).toBe("not-debt-like");
    expect(byId[unknownId]!.status).toBe("not-found");

    // Verify final state: no duplicate Amex row, no debt for non-debt acct.
    const all = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.userId, TEST_USER));
    const linkedToA = all.filter((x) => x.plaidAccountId === a.plaidAccountId);
    const linkedToB = all.filter((x) => x.plaidAccountId === b.plaidAccountId);
    const linkedToD = all.filter((x) => x.plaidAccountId === d.plaidAccountId);
    expect(linkedToA).toHaveLength(1);
    expect(linkedToB).toHaveLength(1);
    expect(linkedToD).toHaveLength(0);
  });

  it("rejects an empty accounts array with 400", async () => {
    const res = await fetch(
      `${baseUrl}/plaid/liability-accounts/create-debts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accounts: [] }),
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("Amex anchor regression after auto-create-debt", () => {
  it("flips GET /amex/anchor source from missing to debt after auto-creating a debt for an Amex Plaid account", async () => {
    const { plaidAccountId } = await insertCreditAccount({
      institutionName: "American Express",
      mask: "1009",
      balance: "750.25",
      apr: "0.2799",
      minPayment: "40.00",
    });
    // Pre-condition: no debt, no anchor, no txns. With the live-Plaid
    // fallback (#483), /amex/anchor surfaces the linked account's
    // liabilityBalance as source="plaid" so the tile is never stuck on
    // "Loading..." / "Not set" while a balance is sitting on the
    // plaid_accounts row.
    const before = await fetch(`${baseUrl}/amex/anchor`);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      source: string;
      amexEndingBalance: number | null;
    };
    expect(beforeBody.source).toBe("plaid");
    expect(beforeBody.amexEndingBalance).toBeCloseTo(750.25);

    const create = await fetch(
      `${baseUrl}/plaid/liability-accounts/${plaidAccountId}/create-debt`,
      { method: "POST" },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      debt: { name: string };
    };
    // Auto-name must match the byName regex in /amex/anchor so the resolver
    // can find the debt without manual user editing.
    expect(created.debt.name).toMatch(/amex|american\s*express/i);

    const after = await fetch(`${baseUrl}/amex/anchor`);
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as {
      source: string;
      amexEndingBalance: number | null;
    };
    // (#651) Plaid liability balance now wins over the auto-created
    // debt row's cached `balance` column — the debt row is just a
    // convenience cache, the live Plaid figure is the source of truth.
    expect(afterBody.source).toBe("plaid");
    expect(afterBody.source).not.toBe("missing");
    expect(afterBody.amexEndingBalance).toBeCloseTo(750.25);
  });
});
