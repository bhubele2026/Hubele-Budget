import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  agentRunsTable,
  aiUsageTable,
  householdMembersTable,
  recapDeliveriesTable,
  recapsTable,
} from "@workspace/db";
import { pinEnv } from "./_helpers/aiEnv";
import { makeMembers, dropMembers, seedVerified, type TestMember } from "./_helpers/smsFixtures";
import { FOR_DATE, NOW, seedRecapHousehold, wipeRecapHousehold } from "./_helpers/recapFixtures";
import { queueFakeSteps, resetFake } from "../ai/fake";
import { invalidateTaskConfigCache } from "../ai/config";

// (AI-4a) POST /recap/preview, GET /recap/history, POST /recap/generate-now:
// shapes, what each stores, who may call it, and isolation between households
// and between members of one household.

pinEnv({
  AI_PROVIDER: "fake",
  AI_ENABLED: "true",
  AI_PAUSED: undefined,
  SMS_PROVIDER: "fake",
  SMS_DAILY_SEND_CAP: "10000",
  SMS_WEBHOOK_BASE_URL: undefined,
  APP_URL: "https://h2.example.test",
  NODE_ENV: "test",
});

interface Caller {
  userId: string;
  householdId: string;
  ownerId: string;
}
let current: Caller;
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = current.userId;
    req.actualUserId = current.userId;
    req.householdId = current.householdId;
    req.householdOwnerId = current.ownerId;
    next();
  },
}));

import recapRouter from "../routes/recap";

let server: Server;
let base = "";
let A: TestMember, B: TestMember;
let AMember: Caller;
const asOwner = (m: TestMember): Caller => ({ userId: m.userId, householdId: m.householdId, ownerId: m.userId });

async function call(as: Caller, method: string, path: string, body?: unknown) {
  current = as;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  [A, B] = await makeMembers(2);
  await seedRecapHousehold(A);
  const memberId = `sms-member-${process.pid}-${randomUUID().slice(0, 8)}`;
  await db.insert(householdMembersTable).values({ userId: memberId, householdId: A.householdId, role: "member" });
  AMember = { userId: memberId, householdId: A.householdId, ownerId: A.userId };
  const app = express();
  app.use(express.json());
  app.use(recapRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((r) => server.close(() => r()));
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, AMember.userId));
  await wipeRecapHousehold(A);
  await dropMembers([A, B]);
});
beforeEach(async () => {
  resetFake();
  invalidateTaskConfigCache();
  for (const m of [A, B]) {
    await db.delete(aiUsageTable).where(eq(aiUsageTable.householdId, m.householdId));
    await db.delete(agentRunsTable).where(eq(agentRunsTable.householdId, m.householdId));
    await db.delete(recapsTable).where(eq(recapsTable.householdId, m.householdId));
  }
});

const GOOD = { text: "Yesterday: $92 spent (Groceries $50). Electric $90 tomorrow.", factsUsed: ["spentYesterday"] };
const LINK = `https://h2.example.test/?d=${FOR_DATE}`;

// The action line is chosen by code and appended when a draft leaves it out.
const actionOf = (facts: unknown): string => {
  const a = (facts as { action?: { text: string } | null }).action?.text;
  return a ? ` ${a}` : "";
};

describe("POST /recap/preview", () => {
  it("returns the model draft, the template draft and the facts, and stores nothing", async () => {
    queueFakeSteps("recap", { kind: "ok", value: GOOD });
    const r = await call(asOwner(A), "POST", "/recap/preview", { forDate: FOR_DATE });
    expect(r.status).toBe(200);
    expect(r.json.model).toEqual({ text: `${GOOD.text}${actionOf(r.json.facts)} ${LINK}`, source: "model", demo: true });
    expect(r.json.template.text).toMatch(/^Yesterday: \$92 spent \(Groceries \$50, Unfiled \$30, Dining Out \$12\)\./);
    expect(r.json.template.text.endsWith(LINK)).toBe(true);
    expect(r.json.facts).toMatchObject({ forDate: FOR_DATE, yesterday: "2026-10-06", spentYesterday: { total: 92.4 } });
    expect(JSON.stringify(r.json)).not.toMatch(/CAFE|MARKET|GADGET/);
    expect(await db.select().from(recapsTable).where(eq(recapsTable.householdId, A.householdId))).toHaveLength(0);
    expect(await db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.householdId, A.householdId))).toHaveLength(0);
    expect(await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A.householdId))).toHaveLength(0);
  });

  it("with the demo provider and no body, the model draft is the labelled fixture for today", async () => {
    const r = await call(asOwner(A), "POST", "/recap/preview");
    expect(r.status).toBe(200);
    expect(r.json.facts.forDate).toBe(FOR_DATE);
    expect(r.json.model).toEqual({ text: `Demo recap. No model was called.${actionOf(r.json.facts)} ${LINK}`, source: "model", demo: true });
  });

  it("the model draft is null when AI is off", async () => {
    process.env.AI_ENABLED = "false";
    try {
      const r = await call(asOwner(A), "POST", "/recap/preview", {});
      expect(r.status).toBe(200);
      expect(r.json.model).toBeNull();
      expect(r.json.template.text).toContain("Yesterday:");
    } finally {
      process.env.AI_ENABLED = "true";
    }
  });

  it("refuses a date that is not a date or is far from today", async () => {
    for (const forDate of ["2026-13-45", "yesterday", "2026-10-7", "2027-01-01", "2026-01-01"]) {
      const r = await call(asOwner(A), "POST", "/recap/preview", { forDate });
      expect(r.status, forDate).toBe(400);
      expect(r.json.code).toBe("bad_date");
    }
  });

  it("each household sees only its own facts", async () => {
    const b = await call(asOwner(B), "POST", "/recap/preview", { forDate: FOR_DATE });
    expect(b.json.facts.spentYesterday).toEqual({ total: 0, count: 0, topCategories: [] });
    expect(b.json.facts.billsNext3Days).toEqual([]);
    const a = await call(asOwner(A), "POST", "/recap/preview", { forDate: FOR_DATE });
    expect(a.json.facts.spentYesterday.total).toBe(92.4);
  });
});

describe("POST /recap/generate-now", () => {
  it("is owner only", async () => {
    const r = await call(AMember, "POST", "/recap/generate-now", {});
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("owner_only");
    expect(await db.select().from(recapsTable).where(eq(recapsTable.householdId, A.householdId))).toHaveLength(0);
  });

  it("stores one recap (and a run) without sending it; asking again returns the same one", async () => {
    const first = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE });
    expect(first.status).toBe(200);
    expect(first.json.created).toBe(true);
    expect(first.json.recap).toMatchObject({ forDate: FOR_DATE, status: "drafted", source: "model", delivery: null });
    const second = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE });
    expect(second.json.created).toBe(false);
    expect(second.json.recap.id).toBe(first.json.recap.id);
    expect(await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A.householdId))).toHaveLength(1);
    expect(await db.select().from(recapDeliveriesTable).where(eq(recapDeliveriesTable.householdId, A.householdId))).toHaveLength(0);
  });

  it("replace regenerates a recap that has not been sent, and refuses one that has", async () => {
    const first = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE });
    const again = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE, replace: true });
    expect(again.json.created).toBe(true);
    expect(again.json.recap.id).not.toBe(first.json.recap.id);
    await db.update(recapsTable).set({ status: "sent" }).where(eq(recapsTable.id, again.json.recap.id));
    const blocked = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE, replace: true });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("already_sent");
  });

  it("can generate for another member of the household, but not for a stranger", async () => {
    const mine = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE, userId: AMember.userId });
    expect(mine.status).toBe(200);
    const [row] = await db.select().from(recapsTable).where(eq(recapsTable.id, mine.json.recap.id));
    expect(row!.userId).toBe(AMember.userId);
    expect(row!.householdId).toBe(A.householdId);
    const stranger = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE, userId: B.userId });
    expect(stranger.status).toBe(400);
    expect(stranger.json.code).toBe("not_a_member");
  });
});

describe("GET /recap/history", () => {
  it("lists the caller's recaps newest first with their delivery status", async () => {
    await call(asOwner(A), "POST", "/recap/generate-now", { forDate: "2026-10-06" });
    const today = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE });
    await seedVerified(A, "+15555550142");
    await db.insert(recapDeliveriesTable).values({
      householdId: A.householdId,
      userId: A.userId,
      recapId: today.json.recap.id,
      forDate: FOR_DATE,
      kind: "scheduled",
      toE164: "+15555550142",
      provider: "fake",
      status: "delivered",
      idempotencyKey: `recap:${A.userId}:${FOR_DATE}`,
    });
    const r = await call(asOwner(A), "GET", "/recap/history");
    expect(r.status).toBe(200);
    expect(r.json.map((x: { forDate: string }) => x.forDate)).toEqual([FOR_DATE, "2026-10-06"]);
    expect(Object.keys(r.json[0]).sort()).toEqual(["delivery", "forDate", "generatedAt", "id", "source", "status", "text"]);
    expect(r.json[0].delivery).toEqual({ status: "delivered", provider: "fake", createdAt: expect.any(String) });
    expect(r.json[1].delivery).toBeNull();
    expect(r.json[0].text.endsWith(LINK)).toBe(true);
    // The facts and the phone number never ride along.
    expect(JSON.stringify(r.json)).not.toMatch(/facts|5555550142|\+1/);
    await db.delete(recapDeliveriesTable).where(eq(recapDeliveriesTable.householdId, A.householdId));
  });

  it("a console delivery shows as previewed and the recap is never reported as sent", async () => {
    const day = await call(asOwner(A), "POST", "/recap/generate-now", { forDate: "2026-10-05" });
    await db.update(recapsTable).set({ status: "sent" }).where(eq(recapsTable.id, day.json.recap.id));
    await db.insert(recapDeliveriesTable).values({
      householdId: A.householdId,
      userId: A.userId,
      recapId: day.json.recap.id,
      forDate: "2026-10-05",
      kind: "scheduled",
      toE164: "+15555550142",
      provider: "console",
      status: "sent",
      idempotencyKey: `recap:${A.userId}:2026-10-05`,
    });
    const r = await call(asOwner(A), "GET", "/recap/history");
    const row = r.json.find((x: { forDate: string }) => x.forDate === "2026-10-05");
    expect(row.status).toBe("previewed");
    expect(row.delivery).toEqual({ status: "previewed", provider: "console", createdAt: expect.any(String) });
    await db.delete(recapDeliveriesTable).where(eq(recapDeliveriesTable.householdId, A.householdId));
    await db.delete(recapsTable).where(eq(recapsTable.id, day.json.recap.id));
  });

  it("limit is 1 to 30", async () => {
    await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE });
    await call(asOwner(A), "POST", "/recap/generate-now", { forDate: "2026-10-06" });
    expect((await call(asOwner(A), "GET", "/recap/history?limit=1")).json).toHaveLength(1);
    for (const bad of ["0", "31", "x"]) {
      expect((await call(asOwner(A), "GET", `/recap/history?limit=${bad}`)).status, bad).toBe(400);
    }
    expect((await call(asOwner(A), "GET", "/recap/history?limit=30")).status).toBe(200);
  });

  it("is scoped to the caller: another household sees none, and a member sees only their own", async () => {
    await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE });
    await call(asOwner(A), "POST", "/recap/generate-now", { forDate: FOR_DATE, userId: AMember.userId });
    expect((await call(asOwner(B), "GET", "/recap/history")).json).toEqual([]);
    const own = await call(AMember, "GET", "/recap/history");
    expect(own.json).toHaveLength(1);
    const [row] = await db.select().from(recapsTable).where(eq(recapsTable.id, own.json[0].id));
    expect(row!.userId).toBe(AMember.userId);
    const owner = await call(asOwner(A), "GET", "/recap/history");
    expect(owner.json).toHaveLength(1);
    expect(owner.json[0].id).not.toBe(own.json[0].id);
  });
});
