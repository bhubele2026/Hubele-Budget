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
let TEST_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

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

import { db, mappingRulesTable, transactionsTable } from "@workspace/db";
import mappingRouter from "../routes/mapping";
import { createTestHousehold } from "./_helpers/testHousehold";

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
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, OTHER_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  const _ho = await createTestHousehold(OTHER_USER);
  OTHER_HOUSEHOLD_ID = _ho.householdId;
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
      householdId: userId === TEST_USER ? TEST_HOUSEHOLD_ID : OTHER_HOUSEHOLD_ID,
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

describe("POST /mapping-rules", () => {
  // Task #212 — POST /mapping-rules now mirrors the auto-learn flow's
  // `ruleAction` shape so the Mapping Rules page can reuse the
  // existing "apply to past charges?" prompt for hand-created rules.
  async function seedTransaction(opts: {
    description: string;
    occurredOn?: string;
    amount?: string;
    categoryId?: string | null;
    isTransfer?: boolean;
    userId?: string;
  }): Promise<string> {
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: opts.userId ?? TEST_USER,
        householdId:
          (opts.userId ?? TEST_USER) === TEST_USER
            ? TEST_HOUSEHOLD_ID
            : OTHER_HOUSEHOLD_ID,
        occurredOn: opts.occurredOn ?? "2026-04-15",
        description: opts.description,
        amount: opts.amount ?? "-12.34",
        categoryId: opts.categoryId ?? null,
        isTransfer: opts.isTransfer ?? false,
        source: "manual",
      })
      .returning();
    return row!.id;
  }

  type CreateResponse = RuleShape & {
    ruleAction: {
      kind: string;
      pattern: string | null;
      matchType: string | null;
      toCategoryId: string | null;
      candidateCount: number | null;
      ruleId: string | null;
    };
  };

  it("returns a `created` ruleAction with the count of older uncategorized matches", async () => {
    await seedTransaction({ description: "STARBUCKS #123 SEATTLE WA" });
    await seedTransaction({ description: "starbucks card reload" });
    // Already categorized — must be excluded so explicit user picks
    // are preserved.
    await seedTransaction({
      description: "STARBUCKS COFFEE",
      categoryId: randomUUID(),
    });
    // Transfer — must be excluded.
    await seedTransaction({
      description: "STARBUCKS REFUND",
      isTransfer: true,
    });
    // Doesn't match the pattern.
    await seedTransaction({ description: "PETSMART #4321" });

    const cat = randomUUID();
    const res = await api("POST", "/mapping-rules", {
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: cat,
      priority: 110,
    });

    expect(res.status).toBe(201);
    const body = res.json as CreateResponse;
    expect(body.pattern).toBe("STARBUCKS");
    expect(body.matchType).toBe("contains");
    expect(body.categoryId).toBe(cat);
    expect(body.ruleAction.kind).toBe("created");
    expect(body.ruleAction.pattern).toBe("STARBUCKS");
    expect(body.ruleAction.matchType).toBe("contains");
    expect(body.ruleAction.toCategoryId).toBe(cat);
    expect(body.ruleAction.candidateCount).toBe(2);
    expect(body.ruleAction.ruleId).toBe(body.id);
  });

  it("emits a `none` ruleAction when no uncategorized rows match", async () => {
    await seedTransaction({
      description: "STARBUCKS COFFEE",
      categoryId: randomUUID(),
    });
    await seedTransaction({ description: "PETSMART" });

    const cat = randomUUID();
    const res = await api("POST", "/mapping-rules", {
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: cat,
      priority: 110,
    });

    expect(res.status).toBe(201);
    const body = res.json as CreateResponse;
    expect(body.ruleAction.kind).toBe("none");
    expect(body.ruleAction.candidateCount).toBeNull();
    expect(body.ruleAction.toCategoryId).toBeNull();
  });

  it("emits a `none` ruleAction when the new rule has no category", async () => {
    await seedTransaction({ description: "STARBUCKS RESERVE" });

    const res = await api("POST", "/mapping-rules", {
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: null,
      priority: 110,
    });

    expect(res.status).toBe(201);
    const body = res.json as CreateResponse;
    expect(body.ruleAction.kind).toBe("none");
    expect(body.ruleAction.candidateCount).toBeNull();
  });

  it("does not count other users' uncategorized rows", async () => {
    await seedTransaction({
      description: "STARBUCKS DRIVE-THRU",
      userId: OTHER_USER,
    });

    const cat = randomUUID();
    const res = await api("POST", "/mapping-rules", {
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: cat,
      priority: 110,
    });

    expect(res.status).toBe(201);
    const body = res.json as CreateResponse;
    expect(body.ruleAction.kind).toBe("none");
  });

  it("respects matchType when counting (starts_with example)", async () => {
    // matchType=starts_with should only match descriptions that begin
    // with the pattern. The first row matches; the second does not.
    await seedTransaction({ description: "AMZN MKTP US*ABC" });
    await seedTransaction({ description: "STORE - AMZN MKTP" });

    const cat = randomUUID();
    const res = await api("POST", "/mapping-rules", {
      pattern: "AMZN",
      matchType: "starts_with",
      categoryId: cat,
      priority: 110,
    });

    expect(res.status).toBe(201);
    const body = res.json as CreateResponse;
    expect(body.ruleAction.kind).toBe("created");
    expect(body.ruleAction.matchType).toBe("starts_with");
    expect(body.ruleAction.candidateCount).toBe(1);
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
