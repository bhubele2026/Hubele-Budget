import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    next();
  },
}));

import { db, mappingRulesTable } from "@workspace/db";
import mappingRouter from "../routes/mapping";

const app = express();
app.use(express.json());
app.use(mappingRouter);

let server: Server;
let baseUrl: string;

async function deleteAll(): Promise<void> {
  await db
    .delete(mappingRulesTable)
    .where(eq(mappingRulesTable.userId, TEST_USER));
  await db
    .delete(mappingRulesTable)
    .where(eq(mappingRulesTable.userId, OTHER_USER));
}

beforeAll(async () => {
  await deleteAll();
  server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await deleteAll();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(async () => {
  await deleteAll();
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedRule(
  pattern: string,
  priority: number,
  matchType = "contains",
  userId = TEST_USER,
  categoryId: string | null = randomUUID(),
): Promise<string> {
  const [row] = await db
    .insert(mappingRulesTable)
    .values({
      userId,
      pattern,
      matchType,
      categoryId,
      priority,
    })
    .returning();
  return row!.id;
}

type RuleShape = {
  id: string;
  pattern: string;
  priority: number;
  matchType: string;
  categoryId: string | null;
};

describe("PUT /mapping-rules/reorder", () => {
  it("rewrites priorities so the supplied order wins on the next list", async () => {
    const aId = await seedRule("AAA", 50);
    const bId = await seedRule("BBB", 100);
    const cId = await seedRule("CCC", 25);

    const res = await api("PUT", "/mapping-rules/reorder", {
      orderedIds: [cId, aId, bId],
    });

    expect(res.status).toBe(200);
    const ordered = res.json as RuleShape[];
    expect(ordered.map((r) => r.id)).toEqual([cId, aId, bId]);
    expect(ordered[0]!.priority).toBeGreaterThan(ordered[1]!.priority);
    expect(ordered[1]!.priority).toBeGreaterThan(ordered[2]!.priority);

    // Subsequent GET reflects the same order (sorted by priority desc).
    const list = await api("GET", "/mapping-rules");
    const listRows = list.json as RuleShape[];
    expect(listRows.map((r) => r.id)).toEqual([cId, aId, bId]);
  });

  it("ignores ids belonging to a different user", async () => {
    const mineId = await seedRule("MINE", 50);
    const theirsId = await seedRule(
      "THEIRS",
      99,
      "contains",
      OTHER_USER,
    );

    const res = await api("PUT", "/mapping-rules/reorder", {
      orderedIds: [theirsId, mineId],
    });

    expect(res.status).toBe(200);
    const rows = res.json as RuleShape[];
    expect(rows.map((r) => r.id)).toEqual([mineId]);

    // The other user's rule was not touched.
    const [theirsAfter] = await db
      .select()
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.id, theirsId));
    expect(theirsAfter!.priority).toBe(99);
  });

  it("ranks rules in `orderedIds` above rules omitted from the list", async () => {
    const omittedId = await seedRule("OMITTED", 200);
    const aId = await seedRule("AAA", 10);
    const bId = await seedRule("BBB", 5);

    const res = await api("PUT", "/mapping-rules/reorder", {
      orderedIds: [bId, aId],
    });

    expect(res.status).toBe(200);
    const rows = res.json as RuleShape[];
    // Reordered rules sit on top of the omitted high-priority rule.
    expect(rows.map((r) => r.id)).toEqual([bId, aId, omittedId]);
  });

  it("400s on a bad payload", async () => {
    const res = await api("PUT", "/mapping-rules/reorder", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /mapping-rules/test", () => {
  it("returns matching rules in priority order with the winner flagged", async () => {
    const catA = randomUUID();
    const catB = randomUUID();
    // Specific (higher priority) wins over generic (lower priority).
    const specific = await seedRule("AMAZON FRESH", 100, "contains", TEST_USER, catA);
    const generic = await seedRule("AMAZON", 50, "contains", TEST_USER, catB);
    await seedRule("STARBUCKS", 50, "contains"); // shouldn't match

    const res = await api("POST", "/mapping-rules/test", {
      description: "AMAZON FRESH 4732 SEATTLE WA",
    });

    expect(res.status).toBe(200);
    const body = res.json as {
      matches: { rule: RuleShape; winner: boolean }[];
      winningCategoryId: string | null;
    };
    expect(body.matches.map((m) => m.rule.id)).toEqual([specific, generic]);
    expect(body.matches[0]!.winner).toBe(true);
    expect(body.matches[1]!.winner).toBe(false);
    expect(body.winningCategoryId).toBe(catA);
  });

  it("returns matches but a null winning category when matches have no category", async () => {
    await seedRule("AMAZON", 50, "contains", TEST_USER, null);

    const res = await api("POST", "/mapping-rules/test", {
      description: "AMAZON.COM ORDER",
    });

    expect(res.status).toBe(200);
    const body = res.json as {
      matches: { rule: RuleShape; winner: boolean }[];
      winningCategoryId: string | null;
    };
    expect(body.matches.length).toBe(1);
    expect(body.winningCategoryId).toBeNull();
    expect(body.matches[0]!.winner).toBe(false);
  });

  it("returns an empty match list when no rules match", async () => {
    await seedRule("STARBUCKS", 50);

    const res = await api("POST", "/mapping-rules/test", {
      description: "PETSMART #1234",
    });

    expect(res.status).toBe(200);
    const body = res.json as {
      matches: unknown[];
      winningCategoryId: string | null;
    };
    expect(body.matches).toEqual([]);
    expect(body.winningCategoryId).toBeNull();
  });

  it("does not see other users' rules", async () => {
    await seedRule("AMAZON", 100, "contains", OTHER_USER);

    const res = await api("POST", "/mapping-rules/test", {
      description: "AMAZON.COM ORDER",
    });

    expect(res.status).toBe(200);
    const body = res.json as { matches: unknown[] };
    expect(body.matches).toEqual([]);
  });

  it("400s on a missing description", async () => {
    const res = await api("POST", "/mapping-rules/test", {});
    expect(res.status).toBe(400);
  });
});
