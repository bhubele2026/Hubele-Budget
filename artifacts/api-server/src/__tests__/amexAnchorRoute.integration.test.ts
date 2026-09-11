import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `amex-route-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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
  debtsTable,
  transactionsTable,
  settingsTable,
} from "@workspace/db";
import amexRouter from "../routes/amex";
import { createTestHousehold } from "./_helpers/testHousehold";
import { refreshAmexAnchor } from "../lib/amexAnchor";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(amexRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
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
});

beforeEach(cleanup);

describe("DELETE /amex/anchor", () => {
  it("removes a present anchor from settings.preferences", async () => {
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: {
        amexAnchor: { balance: 1234.56, asOf: "2026-04-01T00:00:00.000Z" },
      },
    });

    const res = await fetch(`${baseUrl}/amex/anchor`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const [row] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
    expect("amexAnchor" in prefs).toBe(false);
  });

  it("is a no-op when no anchor (and no settings row) exists", async () => {
    const res = await fetch(`${baseUrl}/amex/anchor`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // No settings row should have been created by the no-op.
    const rows = await db
      .select({ userId: settingsTable.userId })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(rows.length).toBe(0);
  });

  it("is a no-op when a settings row exists but has no amexAnchor key", async () => {
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: { someOtherKey: "keep-me" },
    });

    const res = await fetch(`${baseUrl}/amex/anchor`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const [row] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
    expect(prefs.someOtherKey).toBe("keep-me");
    expect("amexAnchor" in prefs).toBe(false);
  });

  it("preserves other preference keys when removing amexAnchor", async () => {
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: {
        amexAnchor: { balance: 50, asOf: "2026-04-01T00:00:00.000Z" },
        forecastFloor: 250,
        nested: { keepMe: true },
      },
    });

    const res = await fetch(`${baseUrl}/amex/anchor`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const [row] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
    expect("amexAnchor" in prefs).toBe(false);
    expect(prefs.forecastFloor).toBe(250);
    expect(prefs.nested).toEqual({ keepMe: true });
  });
});

describe("POST /amex/anchor", () => {
  it("persists a valid balance to settings.preferences.amexAnchor (no prior settings row)", async () => {
    const res = await fetch(`${baseUrl}/amex/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: 1234.56, asOf: "2026-04-01T12:34:56.000Z" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      amexEndingBalance: number;
      asOf: string;
      source: string;
    };
    expect(body.source).toBe("anchor");
    expect(body.amexEndingBalance).toBeCloseTo(1234.56, 2);
    expect(body.asOf).toBe("2026-04-01T12:34:56.000Z");

    const [row] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
    expect(prefs.amexAnchor).toEqual({
      balance: 1234.56,
      asOf: "2026-04-01T12:34:56.000Z",
    });
  });

  it("preserves other preference keys when upserting on an existing row", async () => {
    await db.insert(settingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: {
        forecastFloor: 250,
        nested: { keepMe: true },
        amexAnchor: { balance: 10, asOf: "2025-01-01T00:00:00.000Z" },
      },
    });

    const res = await fetch(`${baseUrl}/amex/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: 999.99, asOf: "2026-05-01T00:00:00.000Z" }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
    expect(prefs.forecastFloor).toBe(250);
    expect(prefs.nested).toEqual({ keepMe: true });
    expect(prefs.amexAnchor).toEqual({
      balance: 999.99,
      asOf: "2026-05-01T00:00:00.000Z",
    });
  });

  it("stores a bare YYYY-MM-DD asOf as noon UTC, so the anchor stays on that household day", async () => {
    // "2026-04-01" read as an instant is UTC midnight: 7pm on Mar 31 in Chicago,
    // which would count Apr 1's rows after the anchor a second time. Noon UTC is
    // Apr 1 in Chicago all year.
    const res = await fetch(`${baseUrl}/amex/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: 42, asOf: "2026-04-01" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asOf: string };
    expect(body.asOf).toBe("2026-04-01T12:00:00.000Z");

    const [row] = await db
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    const prefs = (row?.preferences ?? {}) as {
      amexAnchor?: { asOf?: string };
    };
    expect(prefs.amexAnchor?.asOf).toBe("2026-04-01T12:00:00.000Z");
  });

  it("returns 400 on a bare day that does not exist, including one V8 would roll over", async () => {
    // `new Date("2026-02-30T12:00:00.000Z")` is Mar 2, not an error. Without the
    // round-trip check that anchor would silently land on Mar 2.
    for (const asOf of ["2026-13-45", "2026-02-29", "2026-02-30", "2026-04-31"]) {
      const res = await fetch(`${baseUrl}/amex/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balance: 42, asOf }),
      });
      expect(res.status).toBe(400);
    }

    const rows = await db
      .select({ userId: settingsTable.userId })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(rows.length).toBe(0);
  });

  it("accepts a real leap day and stores it at noon UTC", async () => {
    // The round-trip check must not turn away Feb 29 in a leap year.
    const res = await fetch(`${baseUrl}/amex/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: 42, asOf: "2028-02-29" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asOf: string };
    expect(body.asOf).toBe("2028-02-29T12:00:00.000Z");
  });

  it("returns 400 on a non-finite balance", async () => {
    for (const balance of ["not-a-number", undefined]) {
      const res = await fetch(`${baseUrl}/amex/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balance, asOf: "2026-04-01T00:00:00.000Z" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/balance/i);
    }

    const rows = await db
      .select({ userId: settingsTable.userId })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(rows.length).toBe(0);
  });

  it("returns 400 on a bad asOf string", async () => {
    const res = await fetch(`${baseUrl}/amex/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: 100, asOf: "not-a-real-date" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/asOf/i);

    const rows = await db
      .select({ userId: settingsTable.userId })
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(rows.length).toBe(0);
  });
});

describe("GET /amex/anchor", () => {
  it("advances asOf via the settings anchor even when manual override keeps debt unchanged", async () => {
    // Seed: one Amex txn + a linked debt row whose updatedAt is OLD.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-04-01",
      description: "Amex charge",
      amount: "100.00",
      source: "amex",
    });
    const oldDate = new Date("2025-01-01T00:00:00.000Z");
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "American Express",
        balance: "100.00",
        apr: "0.2849",
        minPayment: "40",
        payment: "40",
        updatedAt: oldDate,
      })
      .returning({ id: debtsTable.id });

    // First anchor refresh adopts (no prior anchor).
    await refreshAmexAnchor(TEST_USER);
    // Force the debt's updatedAt back to the old timestamp so we can
    // observe the route picking the fresher settings anchor asOf.
    await db
      .update(debtsTable)
      .set({ updatedAt: oldDate })
      .where(eq(debtsTable.id, debt!.id));

    // User manually edits the debt balance via the UI (this DOES bump
    // updatedAt in the real PATCH route — simulate that by leaving it as
    // the OLD date so we can isolate the asOf-advance behavior).
    await db
      .update(debtsTable)
      .set({ balance: "777.77", updatedAt: oldDate })
      .where(eq(debtsTable.id, debt!.id));

    // A new Amex txn arrives and we re-refresh (manual override should win
    // for debt.balance, but the settings anchor advances).
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-04-05",
      description: "Amex charge 2",
      amount: "25.00",
      source: "amex",
    });
    await refreshAmexAnchor(TEST_USER, db, { adopt: false });

    const res = await fetch(`${baseUrl}/amex/anchor`);
    const body = (await res.json()) as {
      amexEndingBalance: number;
      asOf: string;
      source: string;
    };
    expect(body.source).toBe("debt");
    // Manual override balance still wins.
    expect(body.amexEndingBalance).toBeCloseTo(777.77, 2);
    // But asOf advanced past the stale debt.updatedAt because the
    // settings anchor was just refreshed.
    expect(new Date(body.asOf).getTime()).toBeGreaterThan(oldDate.getTime());
  });

  it("dates a computed balance by its latest transaction's day, as a bare YYYY-MM-DD", async () => {
    // No debt, no Plaid liability, no saved anchor → the running sum of the Amex
    // rows. That sum already holds every row through the latest day, so the day
    // must travel as a day: as UTC midnight it is 7pm the evening before in
    // Chicago, and the browser counted the latest day's rows a second time.
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-09-02",
        description: "Amex groceries",
        amount: "30.00",
        source: "amex",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-09-10",
        description: "Amex gas",
        amount: "50.00",
        source: "amex",
      },
    ]);

    const res = await fetch(`${baseUrl}/amex/anchor`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      amexEndingBalance: number;
      asOf: string;
      source: string;
    };
    expect(body.source).toBe("computed");
    expect(body.amexEndingBalance).toBeCloseTo(80, 2);
    expect(body.asOf).toBe("2026-09-10");
  });
});
