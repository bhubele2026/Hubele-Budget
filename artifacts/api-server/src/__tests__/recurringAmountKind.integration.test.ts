// (PR-B1) recurring_items.amount_kind through the existing CRUD: a new plan is
// "fixed" unless it says otherwise, "estimate" round-trips through POST, PATCH
// and GET, and anything else is refused before it reaches the database.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `amount-kind-${process.pid}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

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

import { db, recurringItemsTable } from "@workspace/db";
import recurringRouter from "../routes/recurring";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use(recurringRouter);
let server: Server;
let baseUrl: string;

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await new Promise<void>((res) => server.close(() => res()));
});

describe("recurring_items.amount_kind through the CRUD", () => {
  it("defaults to fixed, and estimate round-trips through POST, PATCH and GET", async () => {
    const plain = await call("POST", "/recurring-items", { name: "Rent", kind: "bill", amount: "1200", frequency: "monthly", dayOfMonth: 1 });
    expect(plain.status).toBe(201);
    expect(plain.body.amountKind).toBe("fixed");

    const est = await call("POST", "/recurring-items", {
      name: "Electric",
      kind: "bill",
      amount: "140",
      frequency: "monthly",
      dayOfMonth: 13,
      amountKind: "estimate",
    });
    expect(est.status).toBe(201);
    expect(est.body.amountKind).toBe("estimate");

    const patched = await call("PATCH", `/recurring-items/${plain.body.id}`, { name: "Rent", amountKind: "estimate" });
    expect(patched.status).toBe(200);
    expect(patched.body.amountKind).toBe("estimate");
    const back = await call("PATCH", `/recurring-items/${plain.body.id}`, { name: "Rent", amountKind: "fixed" });
    expect(back.body.amountKind).toBe("fixed");

    const list = await call("GET", "/recurring-items");
    const byName = new Map((list.body as Array<{ name: string; amountKind: string }>).map((r) => [r.name, r.amountKind]));
    expect(byName.get("Rent")).toBe("fixed");
    expect(byName.get("Electric")).toBe("estimate");
  });

  it("refuses any other value", async () => {
    const r = await call("POST", "/recurring-items", { name: "Water", amount: "60", amountKind: "roughly" });
    expect(r.status).toBe(400);
    const rows = await db.select().from(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
    expect(rows.map((x) => x.name)).not.toContain("Water");
  });
});
