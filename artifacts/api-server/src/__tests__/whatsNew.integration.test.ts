// ⭐ (WN) What's new — "I've read this", recorded per person on the server
// (owner, 2026-10-15). Three people, two households:
//   Household A — OWNER, MEMBER (joined before the first note), LATE (joined
//                 after it: the note is not theirs to read).
//   Household B — STRANGER (its owner).
// Clerk is mocked with first names; one case makes it throw.
// All ids are synthetic.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const OWNER = `wn-owner-${tag}`;
const MEMBER = `wn-member-${tag}`;
const LATE = `wn-late-${tag}`;
const STRANGER = `wn-stranger-${tag}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

const clerk = vi.hoisted(() => ({
  fail: false,
  names: {} as Record<string, string | null>,
  calls: 0,
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: async ({ userId }: { userId: string[] }) => {
        clerk.calls++;
        if (clerk.fail) throw new Error("clerk down");
        return { data: userId.map((id) => ({ id, firstName: clerk.names[id] ?? null, username: null })), totalCount: userId.length };
      },
    },
  },
}));

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
    const who = String(req.headers["x-test-user"] ?? OWNER);
    const hh = HH[who]!;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import { db, pool, householdMembersTable, householdsTable, whatsNewReadsTable } from "@workspace/db";
import { READ_CLICK_FROM, WHATS_NEW } from "@workspace/avalanche-core/whatsNew";
import whatsNewRouter from "../routes/whatsNew";
import { _resetWhatsNewNamesForTests } from "../lib/whatsNewReads";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use(whatsNewRouter);

let server: Server;
let baseUrl: string;

async function call(method: string, p: string, as: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { "x-test-user": as, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
const me = (as: string) => call("GET", "/whats-new/me", as);
const read = (as: string, body: unknown) => call("POST", "/whats-new/read", as, body);
const report = (as: string) => call("GET", "/whats-new/reads", as);

const rowsOf = (users: string[]) =>
  db
    .select({ userId: whatsNewReadsTable.userId, householdId: whatsNewReadsTable.householdId, updateId: whatsNewReadsTable.updateId, readAt: whatsNewReadsTable.readAt })
    .from(whatsNewReadsTable)
    .where(inArray(whatsNewReadsTable.userId, users));

async function setJoined(user: string, at: string): Promise<void> {
  await db.update(householdMembersTable).set({ joinedAt: new Date(at) }).where(eq(householdMembersTable.userId, user));
}
async function addMember(user: string, owner: string, joinedAt: string): Promise<void> {
  await db
    .insert(householdMembersTable)
    .values({ userId: user, householdId: HH[owner]!.householdId, role: "member", joinedAt: new Date(joinedAt) })
    .onConflictDoNothing();
  HH[user] = HH[owner]!;
}

const ALL = [OWNER, MEMBER, LATE, STRANGER];

beforeAll(async () => {
  HH[OWNER] = await createTestHousehold(OWNER);
  HH[STRANGER] = await createTestHousehold(STRANGER);
  // The owner (and the stranger) have had H2 since long before the first note.
  await setJoined(OWNER, "2026-08-01T15:00:00Z");
  await setJoined(STRANGER, "2026-08-01T15:00:00Z");
  await addMember(MEMBER, OWNER, "2026-09-01T15:00:00Z");
  await addMember(LATE, OWNER, "2026-10-20T15:00:00Z");
  clerk.names = { [MEMBER]: "Jen", [LATE]: "Alex", [OWNER]: "Sam", [STRANGER]: "Pat" };
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

beforeEach(async () => {
  await db.delete(whatsNewReadsTable).where(inArray(whatsNewReadsTable.userId, ALL));
  clerk.fail = false;
  _resetWhatsNewNamesForTests();
});

afterAll(async () => {
  await db.delete(whatsNewReadsTable).where(inArray(whatsNewReadsTable.userId, ALL));
  await db.delete(householdMembersTable).where(inArray(householdMembersTable.userId, ALL));
  for (const o of [OWNER, STRANGER]) await db.delete(householdsTable).where(eq(householdsTable.ownerUserId, o));
  await new Promise<void>((res) => server.close(() => res()));
});

describe("GET /whats-new/me — this person's reads and where their click starts", () => {
  it("someone who joined before the first note starts at it, with nothing read", async () => {
    const r = await me(MEMBER);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ read: [], from: READ_CLICK_FROM });
    expect((await me(OWNER)).json).toEqual({ read: [], from: READ_CLICK_FROM });
  });

  it("someone who joined later starts the day AFTER they joined, in household time", async () => {
    expect((await me(LATE)).json.from).toBe("2026-10-21");
    // 03:30 UTC on the 16th is the evening of the 15th in Chicago: they start on the 16th.
    await setJoined(LATE, "2026-10-16T03:30:00Z");
    expect((await me(LATE)).json.from).toBe("2026-10-16");
    await setJoined(LATE, "2026-10-20T15:00:00Z");
  });
});

describe("POST /whats-new/read — the press", () => {
  it("refuses a body that is not a list of note ids, and writes nothing", async () => {
    for (const body of [{}, { ids: [] }, { ids: ["not-a-day"] }, { ids: ["2026-10-15.10"] }, { ids: ["h2-1"] }, { ids: "2026-10-15" }]) {
      const r = await read(MEMBER, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const tooMany = Array.from({ length: 51 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")}`);
    expect((await read(MEMBER, { ids: tooMany })).status).toBe(400);
    expect(await rowsOf(ALL)).toEqual([]);
  });

  it("drops a well-formed id H2 does not ship and records the known one, in this household", async () => {
    const r = await read(MEMBER, { ids: [READ_CLICK_FROM, "2020-01-01", READ_CLICK_FROM] });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ids: [READ_CLICK_FROM] });
    const rows = await rowsOf(ALL);
    expect(rows.map((x) => [x.userId, x.updateId, x.householdId])).toEqual([[MEMBER, READ_CLICK_FROM, HH[OWNER]!.householdId]]);
    expect((await me(MEMBER)).json).toEqual({ read: [READ_CLICK_FROM], from: READ_CLICK_FROM });
  });

  it("only unknown ids: 200 with nothing recorded (an older bundle never fails)", async () => {
    const r = await read(MEMBER, { ids: ["2020-01-01"] });
    expect(r).toEqual({ status: 200, json: { ids: [] } });
    expect(await rowsOf(ALL)).toEqual([]);
  });

  it("a repeat keeps one row and the first read time", async () => {
    await read(MEMBER, { ids: [READ_CLICK_FROM] });
    const [first] = await rowsOf([MEMBER]);
    await new Promise((r) => setTimeout(r, 20));
    const again = await read(MEMBER, { ids: [READ_CLICK_FROM] });
    expect(again.json).toEqual({ ids: [READ_CLICK_FROM] });
    const rows = await rowsOf([MEMBER]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.readAt.getTime()).toBe(first!.readAt.getTime());
  });

  it("each person's reads are their own: never in anyone else's /me", async () => {
    await read(MEMBER, { ids: [READ_CLICK_FROM] });
    expect((await me(OWNER)).json.read).toEqual([]);
    expect((await me(STRANGER)).json.read).toEqual([]);
    await read(STRANGER, { ids: [READ_CLICK_FROM] });
    await read(OWNER, { ids: [READ_CLICK_FROM] });
    expect((await me(MEMBER)).json.read).toEqual([READ_CLICK_FROM]);
    const rows = await rowsOf(ALL);
    expect(rows.find((x) => x.userId === STRANGER)!.householdId).toBe(HH[STRANGER]!.householdId);
  });
});

describe("GET /whats-new/reads — the owner's report", () => {
  it("a member gets 403", async () => {
    const r = await report(MEMBER);
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "owner_only" });
  });

  it("lists the member under the note — not read yet, then read — and never the owner himself", async () => {
    const before = await report(OWNER);
    expect(before.status).toBe(200);
    expect(before.json.updates.map((u: { id: string }) => u.id)).toEqual(WHATS_NEW.filter((u) => u.id >= READ_CLICK_FROM).map((u) => u.id));
    const note = () => before.json.updates.find((u: { id: string }) => u.id === READ_CLICK_FROM);
    // LATE joined after the note: it is not theirs to read, so they are not listed.
    expect(note().readers).toEqual([{ userId: MEMBER, name: "Jen", readAt: null }]);

    await read(OWNER, { ids: [READ_CLICK_FROM] });
    const t0 = Date.now();
    await read(MEMBER, { ids: [READ_CLICK_FROM] });
    const after = await report(OWNER);
    const readers = after.json.updates.find((u: { id: string }) => u.id === READ_CLICK_FROM).readers;
    expect(readers).toHaveLength(1);
    expect(readers[0].userId).toBe(MEMBER);
    expect(readers[0].name).toBe("Jen");
    expect(Math.abs(Date.parse(readers[0].readAt) - t0)).toBeLessThan(10_000);
    expect(JSON.stringify(after.json)).not.toContain(OWNER);
  });

  it("a later member is listed under a note from on or after their start", async () => {
    // Joined the evening before the note: their start is the note's day, so it is theirs.
    await setJoined(LATE, "2026-10-14T18:00:00Z");
    const r = await report(OWNER);
    const readers = r.json.updates.find((u: { id: string }) => u.id === READ_CLICK_FROM).readers;
    expect(readers.map((x: { name: string }) => x.name)).toEqual(["Alex", "Jen"]);
    await setJoined(LATE, "2026-10-20T15:00:00Z");
  });

  it("Clerk failing: the name is \"Household member\", never an id or email", async () => {
    clerk.fail = true;
    const r = await report(OWNER);
    expect(r.status).toBe(200);
    expect(r.json.updates[0].readers).toEqual([{ userId: MEMBER, name: "Household member", readAt: null }]);
  });

  it("names are kept for a while: a second report does not ask Clerk again", async () => {
    const calls = clerk.calls;
    await report(OWNER);
    await report(OWNER);
    expect(clerk.calls - calls).toBe(1);
  });

  it("the stranger household's people and reads never appear; the stranger sees no one", async () => {
    await read(STRANGER, { ids: [READ_CLICK_FROM] });
    const r = await report(OWNER);
    expect(JSON.stringify(r.json)).not.toContain(STRANGER);
    expect(JSON.stringify(r.json)).not.toContain("Pat");
    const theirs = await report(STRANGER);
    expect(theirs.status).toBe(200);
    expect(theirs.json.updates.every((u: { readers: unknown[] }) => u.readers.length === 0)).toBe(true);
  });

  it("a removed member drops out of the report", async () => {
    await read(MEMBER, { ids: [READ_CLICK_FROM] });
    await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, MEMBER));
    try {
      const r = await report(OWNER);
      expect(JSON.stringify(r.json)).not.toContain(MEMBER);
    } finally {
      await addMember(MEMBER, OWNER, "2026-09-01T15:00:00Z");
    }
  });
});

describe("the table", () => {
  it("whats_new_reads has its named primary key and household index", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'whats_new_reads' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(["whats_new_reads_household_idx", "whats_new_reads_pkey"]);
  });

  it("deleting a household deletes its reads (cascade)", async () => {
    const tmpOwner = `wn-tmp-${tag}`;
    const hh = await createTestHousehold(tmpOwner);
    await db.insert(whatsNewReadsTable).values({ userId: tmpOwner, householdId: hh.householdId, updateId: READ_CLICK_FROM });
    await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, tmpOwner));
    await db.delete(householdsTable).where(eq(householdsTable.id, hh.householdId));
    expect(await db.select().from(whatsNewReadsTable).where(and(eq(whatsNewReadsTable.userId, tmpOwner)))).toEqual([]);
  });
});
