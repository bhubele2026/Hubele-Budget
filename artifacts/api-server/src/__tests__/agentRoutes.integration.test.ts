// (AI-3) /agent/* — shapes, limits, owner gate and household isolation.
// Synthetic households; facts for POST /agent/monitor/run are injected.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const A_OWNER = `agent-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const A_MEMBER = `agent-am-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_OWNER = `agent-b-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      headers: Record<string, string | string[] | undefined>;
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? A_OWNER);
    const hh = HH[who]!;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));
vi.mock("../monitor/facts", () => ({ loadMonitorFacts: vi.fn() }));

import { db, agentActionsTable, agentFindingsTable, agentRunsTable } from "@workspace/db";
import agentRouter from "../routes/agent";
import { loadMonitorFacts } from "../monitor/facts";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { calmFacts, calmPosition } from "./_helpers/monitorFacts";

const { app, baseUrl } = createTestApp(agentRouter);
void app;

async function call(method: string, path: string, who = A_OWNER, body?: unknown) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": who },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

let A: string;
let B: string;
const FINDING_KEYS = ["id", "kind", "severity", "confidence", "payload", "firstSeen", "lastSeen", "resolvedAt", "dismissedAt"];

beforeAll(async () => {
  A = (await createTestHousehold(A_OWNER)).householdId;
  B = (await createTestHousehold(B_OWNER)).householdId;
  HH[A_OWNER] = { householdId: A, ownerUserId: A_OWNER };
  HH[A_MEMBER] = { householdId: A, ownerUserId: A_OWNER };
  HH[B_OWNER] = { householdId: B, ownerUserId: B_OWNER };
  for (const h of [A, B]) {
    await db.delete(agentRunsTable).where(eq(agentRunsTable.householdId, h));
    await db.delete(agentFindingsTable).where(eq(agentFindingsTable.householdId, h));
  }
});

describe("GET /agent/findings", () => {
  it("lists open findings newest first, in the documented shape, scoped to the household", async () => {
    const t = Date.parse("2026-10-01T00:00:00Z");
    const rows = [0, 1, 2, 3].map((i) => ({
      householdId: A,
      kind: "limit_near",
      dedupeKey: `limit_near:household:w${i}`,
      severity: "info",
      confidence: "confirmed",
      payload: { weekCap: 200, remainingWeek: 10 + i },
      lastSeen: new Date(t + i * 3600_000),
    }));
    await db.insert(agentFindingsTable).values(rows);
    await db.update(agentFindingsTable).set({ resolvedAt: new Date() }).where(eq(agentFindingsTable.dedupeKey, "limit_near:household:w0"));
    await db.update(agentFindingsTable).set({ dismissedAt: new Date() }).where(eq(agentFindingsTable.dedupeKey, "limit_near:household:w1"));
    await db.insert(agentFindingsTable).values({
      householdId: B, kind: "bank_stale", dedupeKey: "bank_stale:household:wB", severity: "watch", confidence: "confirmed", payload: {},
    });

    const open = await call("GET", "/agent/findings");
    expect(open.status).toBe(200);
    expect(open.json.findings.map((f: any) => f.payload.remainingWeek)).toEqual([13, 12]);
    expect(Object.keys(open.json.findings[0]).sort()).toEqual([...FINDING_KEYS].sort());
    expect(typeof open.json.findings[0].payload.weekCap).toBe("number");

    const all = await call("GET", "/agent/findings?status=all");
    expect(all.json.findings).toHaveLength(4);
    expect(all.json.findings.every((f: any) => f.kind === "limit_near")).toBe(true);
    expect((await call("GET", "/agent/findings?status=all&limit=2")).json.findings).toHaveLength(2);
    expect((await call("GET", "/agent/findings", B_OWNER)).json.findings.map((f: any) => f.kind)).toEqual(["bank_stale"]);
  });

  it("rejects a limit over 50 and an unknown status", async () => {
    expect((await call("GET", "/agent/findings?limit=51")).status).toBe(400);
    expect((await call("GET", "/agent/findings?limit=0")).status).toBe(400);
    expect((await call("GET", "/agent/findings?status=bogus")).status).toBe(400);
  });
});

describe("dismiss and resolve", () => {
  it("each stamps its column and drops the finding from the open list", async () => {
    const open = (await call("GET", "/agent/findings")).json.findings as any[];
    const [first, second] = open;
    const d = await call("POST", `/agent/findings/${first.id}/dismiss`);
    expect(d.status).toBe(200);
    expect(d.json.dismissedAt).toEqual(expect.any(String));
    const r = await call("POST", `/agent/findings/${second.id}/resolve`);
    expect(r.status).toBe(200);
    expect(r.json.resolvedAt).toEqual(expect.any(String));
    expect((await call("GET", "/agent/findings")).json.findings).toEqual([]);
  });

  it("another household's finding is a 404 and is left alone; so is a non-uuid", async () => {
    const [b] = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.householdId, B));
    expect((await call("POST", `/agent/findings/${b!.id}/dismiss`, A_OWNER)).status).toBe(404);
    expect((await call("POST", `/agent/findings/${b!.id}/resolve`, A_OWNER)).status).toBe(404);
    expect((await call("POST", "/agent/findings/not-a-uuid/dismiss")).status).toBe(404);
    expect((await call("POST", `/agent/findings/${randomUUID()}/resolve`)).status).toBe(404);
    const [after] = await db.select().from(agentFindingsTable).where(eq(agentFindingsTable.id, b!.id));
    expect(after).toMatchObject({ dismissedAt: null, resolvedAt: null });
  });
});

describe("POST /agent/monitor/run, GET /agent/runs, GET /agent/actions", () => {
  it("only the owner runs it; the run and its actions then show up, scoped to the household", async () => {
    vi.mocked(loadMonitorFacts).mockResolvedValue(
      calmFacts({ position: calmPosition({ availableUntilPayday: "0.00", lowestUntilPayday: "50.00" }) }),
    );
    expect((await call("POST", "/agent/monitor/run", A_MEMBER)).status).toBe(403);

    const run = await call("POST", "/agent/monitor/run", A_OWNER);
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ status: "succeeded", detected: 1, created: 1, summary: "1 finding, 1 new" });
    expect(Object.keys(run.json).sort()).toEqual(["autoResolved", "created", "detected", "runId", "status", "summary"]);

    const runs = await call("GET", "/agent/runs");
    expect(runs.json.runs).toHaveLength(1);
    expect(runs.json.runs[0]).toMatchObject({ id: run.json.runId, kind: "monitor", trigger: "user", status: "succeeded", costUsd: null, inputTokens: 0, outputTokens: 0 });
    expect(Object.keys(runs.json.runs[0]).sort()).toEqual(
      ["costUsd", "finishedAt", "id", "inputTokens", "kind", "outputTokens", "startedAt", "status", "summary", "trigger"],
    );

    const actions = await call("GET", "/agent/actions");
    expect(actions.json.actions).toHaveLength(1);
    expect(actions.json.actions[0]).toMatchObject({ runId: run.json.runId, type: "finding", targetKind: "finding", outcome: "needs_attention", reversible: false, undoneAt: null });
    expect(Object.keys(actions.json.actions[0]).sort()).toEqual(
      ["createdAt", "id", "outcome", "reversible", "runId", "targetId", "targetKind", "type", "undoneAt"],
    );

    expect((await call("GET", "/agent/runs", B_OWNER)).json.runs).toEqual([]);
    expect((await call("GET", "/agent/actions", B_OWNER)).json.actions).toEqual([]);
    expect((await call("GET", "/agent/runs?limit=31")).status).toBe(400);
    expect((await call("GET", "/agent/actions?limit=51")).status).toBe(400);
  });
});

describe("POST /agent/actions/:id/undo", () => {
  it("404 for another household's action, 409 for a non-reversible or undone one, 501 for a reversible type that has not shipped", async () => {
    const [run] = await db.select().from(agentRunsTable).where(eq(agentRunsTable.householdId, A));
    const [plain] = await db.select().from(agentActionsTable).where(eq(agentActionsTable.householdId, A));
    expect((await call("POST", `/agent/actions/${plain!.id}/undo`, B_OWNER)).status).toBe(404);
    expect((await call("POST", `/agent/actions/${randomUUID()}/undo`)).status).toBe(404);
    expect((await call("POST", `/agent/actions/${plain!.id}/undo`)).status).toBe(409);

    const [rev] = await db.insert(agentActionsTable).values({
      householdId: A, runId: run!.id, type: "set_category", targetKind: "transaction", targetId: randomUUID(), outcome: "applied", reversible: true,
    }).returning();
    expect((await call("POST", `/agent/actions/${rev!.id}/undo`)).status).toBe(501);
    await db.update(agentActionsTable).set({ undoneAt: new Date() }).where(eq(agentActionsTable.id, rev!.id));
    expect((await call("POST", `/agent/actions/${rev!.id}/undo`)).status).toBe(409);
  });
});
