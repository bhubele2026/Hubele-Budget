// Posted rows are cash, whatever their forecast flag says (2026-09-10).
//
// Codex's review of the forecast found that a Chase row whose forecast flag was
// off still moved the balance but never reached Review, so nothing could match
// it to the bill it paid — and turning the flag off on a matched row deleted
// the match, which restarted the bill. Either way the same money was counted
// twice. These tests pin the one rule the curve, the Review bundle and the
// badge now share (`inForecast`): a row that has already happened is in the
// forecast; the flag only gates rows that haven't.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `past-rows-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

import {
  db,
  forecastSettingsTable,
  forecastResolutionsTable,
  transactionsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
} from "@workspace/db";
import forecastRouter from "../routes/forecast";
import transactionsRouter from "../routes/transactions";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(forecastRouter);
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

// Local noon, 2026-05-14. Only Date is mocked; the HTTP server's timers stay
// real. The snapshot below is taken 2026-05-01.
const PINNED_NOW = new Date(2026, 4, 14, 12, 0, 0);

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

beforeEach(async () => {
  vi.setSystemTime(PINNED_NOW);
  await cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Chase checking with a $1,000 snapshot taken 2026-05-01. */
async function seedChase(
  opts: { pointer?: "stored" | "missing" } = {},
): Promise<{ externalId: string }> {
  const externalId = `acct-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionSlug: "chase",
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalId,
      name: "Chase Checking",
      mask: "5526",
      type: "depository",
      subtype: "checking",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "1000",
    bankSnapshotAt: new Date(2026, 4, 1, 12, 0, 0),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: opts.pointer === "missing" ? null : acct!.id,
    bankSnapshotMask: "5526",
  });
  return { externalId };
}

async function addTxn(opts: {
  occurredOn: string;
  amount: string;
  forecastFlag: boolean;
  plaidAccountId?: string | null;
  source?: string;
}): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: opts.occurredOn,
      description: "row",
      amount: opts.amount,
      forecastFlag: opts.forecastFlag,
      plaidAccountId: opts.plaidAccountId ?? null,
      source: opts.source ?? "manual",
      createdAt: createdAtStartOfHouseholdDay(opts.occurredOn),
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

type Bundle = {
  transactions: { id: string }[];
  resolutions: { matchedTxnId: string | null; status: string }[];
  checkingAccountExternalId: string | null;
  cashSignal: {
    bankToday: string;
    endingBalance: string;
    daily: { date: string; balance: string }[];
  };
};

async function getBundle(): Promise<Bundle> {
  const r = await fetch(`${baseUrl}/forecast?days=30`);
  expect(r.status).toBe(200);
  return (await r.json()) as Bundle;
}

async function reviewCount(): Promise<number> {
  const r = await fetch(`${baseUrl}/forecast/review-count`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { count: number }).count;
}

async function send(method: string, path: string, body: unknown): Promise<number> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.status;
}

describe("posted rows are cash whatever their forecast flag says", () => {
  it("puts a posted Chase row with its flag off on the curve, in the Review bundle and in the badge", async () => {
    const chase = await seedChase();
    const withdrawal = await addTxn({
      occurredOn: "2026-05-05",
      amount: "-200",
      forecastFlag: false,
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    const deposit = await addTxn({
      occurredOn: "2026-05-10",
      amount: "50",
      forecastFlag: false,
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    // A future row with its flag off is NOT expected money yet.
    const futureUnflagged = await addTxn({
      occurredOn: "2026-05-20",
      amount: "-500",
      forecastFlag: false,
    });

    const bundle = await getBundle();
    const ids = bundle.transactions.map((t) => t.id);
    expect(ids).toContain(withdrawal);
    expect(ids).toContain(deposit);
    expect(ids).not.toContain(futureUnflagged);
    expect(bundle.checkingAccountExternalId).toBe(chase.externalId);

    expect(bundle.cashSignal.bankToday).toBe("850.00");
    expect(bundle.cashSignal.daily[0]!.balance).toBe("850.00");
    expect(bundle.cashSignal.endingBalance).toBe("850.00");

    expect(await reviewCount()).toBe(2);
  });

  it("Codex acceptance: $1,000 − $200 + $50 = $850, and reviewing, flag-off and tagging never move it", async () => {
    const chase = await seedChase();
    const withdrawal = await addTxn({
      occurredOn: "2026-05-05",
      amount: "-200",
      forecastFlag: true,
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    const deposit = await addTxn({
      occurredOn: "2026-05-10",
      amount: "50",
      forecastFlag: true,
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });

    const expectCash = async (): Promise<void> => {
      const b = await getBundle();
      expect(b.cashSignal.bankToday).toBe("850.00");
      expect(b.cashSignal.daily[0]!.balance).toBe("850.00");
      expect(b.cashSignal.endingBalance).toBe("850.00");
      // Reviewed/tagged rows are still unresolved plan-wise: Review keeps them.
      expect(await reviewCount()).toBe(2);
    };

    await expectCash();

    expect(await send("PATCH", `/transactions/${withdrawal}`, { reviewed: true })).toBe(200);
    expect(await send("PATCH", `/transactions/${deposit}`, { reviewed: true })).toBe(200);
    await expectCash();

    expect(await send("PATCH", `/transactions/${withdrawal}`, { forecastFlag: false })).toBe(200);
    await expectCash();

    expect(
      await send("POST", "/transactions/bulk-update", {
        ids: [withdrawal, deposit],
        patch: { unplannedAllowance: true, reviewed: false },
      }),
    ).toBe(200);
    await expectCash();
  });

  it("keeps the match when the flag goes off on a matched posted row — the bill stays paid", async () => {
    const chase = await seedChase();
    const [phone] = await db
      .insert(recurringItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Phone",
        kind: "expense",
        amount: "95",
        frequency: "monthly",
        dayOfMonth: 8,
        anchorDate: "2026-01-08",
        active: "true",
      })
      .returning();
    const payment = await addTxn({
      occurredOn: "2026-05-08",
      amount: "-95",
      forecastFlag: true,
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    expect(
      await send("POST", "/forecast/resolutions", {
        recurringItemId: phone!.id,
        occurrenceDate: "2026-05-08",
        status: "matched",
        matchedTxnId: payment,
      }),
    ).toBe(200);

    expect(await send("PATCH", `/transactions/${payment}`, { forecastFlag: false })).toBe(200);

    const stillMatched = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.matchedTxnId, payment));
    expect(stillMatched.map((r) => r.status)).toEqual(["matched"]);

    const b = await getBundle();
    expect(b.resolutions.map((r) => r.matchedTxnId)).toContain(payment);
    // $1,000 − $95 paid on 05-08. The 05-08 phone bill is paid, so it does not
    // drag onto tomorrow; only the 06-08 bill (inside the 30-day horizon)
    // remains: $905 − $95 = $810. Deleting the match would give $715.
    expect(b.cashSignal.bankToday).toBe("905.00");
    expect(b.cashSignal.endingBalance).toBe("810.00");
    expect(await reviewCount()).toBe(0);
  });

  it("still drops the resolution when the flag goes off on a FUTURE row", async () => {
    await seedChase();
    const expected = await addTxn({
      occurredOn: "2026-05-20",
      amount: "-30",
      forecastFlag: true,
    });
    expect(
      await send("POST", "/forecast/resolutions", {
        status: "ignored_unforecasted",
        matchedTxnId: expected,
      }),
    ).toBe(200);

    expect(await send("PATCH", `/transactions/${expected}`, { forecastFlag: false })).toBe(200);

    const left = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.matchedTxnId, expected));
    expect(left).toHaveLength(0);
  });

  it("finds the account from the snapshot mask for the Review bundle when the pointer is missing", async () => {
    const chase = await seedChase({ pointer: "missing" });
    const row = await addTxn({
      occurredOn: "2026-05-06",
      amount: "-40",
      forecastFlag: true,
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });

    const b = await getBundle();
    expect(b.checkingAccountExternalId).toBe(chase.externalId);
    expect(b.transactions.map((t) => t.id)).toContain(row);
    expect(b.cashSignal.bankToday).toBe("960.00");
    expect(await reviewCount()).toBe(1);
  });

  /** $95 phone bill on the 8th, paid from Chase on 05-08, matched. */
  async function seedMatchedPhonePayment(externalId: string): Promise<string> {
    const [phone] = await db
      .insert(recurringItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Phone",
        kind: "expense",
        amount: "95",
        frequency: "monthly",
        dayOfMonth: 8,
        anchorDate: "2026-01-08",
        active: "true",
      })
      .returning();
    const payment = await addTxn({
      occurredOn: "2026-05-08",
      amount: "-95",
      forecastFlag: true,
      plaidAccountId: externalId,
      source: "plaid:chase",
    });
    expect(
      await send("POST", "/forecast/resolutions", {
        recurringItemId: phone!.id,
        occurrenceDate: "2026-05-08",
        status: "matched",
        matchedTxnId: payment,
      }),
    ).toBe(200);
    return payment;
  }

  it("keeps the match when bulk-update turns the flag off on a posted row", async () => {
    const chase = await seedChase();
    const payment = await seedMatchedPhonePayment(chase.externalId);

    expect(
      await send("POST", "/transactions/bulk-update", {
        ids: [payment],
        patch: { forecastFlag: false },
      }),
    ).toBe(200);

    const left = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.matchedTxnId, payment));
    expect(left.map((r) => r.status)).toEqual(["matched"]);
    // Deleting the match would restart the 05-08 bill: $715 instead of $810.
    expect((await getBundle()).cashSignal.endingBalance).toBe("810.00");
  });

  it("keeps the match when bulk-set-forecast-flag turns the flag off on a posted row (the Chase page's bulk Remove)", async () => {
    const chase = await seedChase();
    const payment = await seedMatchedPhonePayment(chase.externalId);

    expect(
      await send("POST", "/transactions/bulk-set-forecast-flag", {
        ids: [payment],
        forecastFlag: false,
      }),
    ).toBe(200);

    const left = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.matchedTxnId, payment));
    expect(left.map((r) => r.status)).toEqual(["matched"]);
    expect((await getBundle()).cashSignal.endingBalance).toBe("810.00");
  });

  it("still drops the resolution when either bulk route turns the flag off on a FUTURE row", async () => {
    await seedChase();
    const viaBulkUpdate = await addTxn({
      occurredOn: "2026-05-20",
      amount: "-30",
      forecastFlag: true,
    });
    const viaBulkFlag = await addTxn({
      occurredOn: "2026-05-21",
      amount: "-40",
      forecastFlag: true,
    });
    for (const id of [viaBulkUpdate, viaBulkFlag]) {
      expect(
        await send("POST", "/forecast/resolutions", {
          status: "ignored_unforecasted",
          matchedTxnId: id,
        }),
      ).toBe(200);
    }

    expect(
      await send("POST", "/transactions/bulk-update", {
        ids: [viaBulkUpdate],
        patch: { forecastFlag: false },
      }),
    ).toBe(200);
    expect(
      await send("POST", "/transactions/bulk-set-forecast-flag", {
        ids: [viaBulkFlag],
        forecastFlag: false,
      }),
    ).toBe(200);

    const left = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.userId, TEST_USER));
    expect(left).toHaveLength(0);
  });
});
