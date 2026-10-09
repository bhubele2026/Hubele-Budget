// (WP7) GET /transactions?plaidAccountId=<external account_id>: one Plaid
// account's rows. A card's own ledger (the Amex page embedded for a card) asks
// with it instead of the source list, which named every card at once and so
// showed a Chase Freedom's account page the Amex rows, or nothing.
//
// The contract pinned here:
//   - exact match on the stored external id (not a prefix, not case-folded);
//   - a row with no Plaid account (null, or the empty string the sync treats as
//     none: a manual entry, an imported workbook row) never matches, and an
//     empty value matches nothing rather than every row;
//   - always inside the caller's household: another household's row on the same
//     id string never leaks;
//   - it composes (AND) with the other filters, and a NUL byte or an over-long
//     value is a 400 that reads nothing.
// Synthetic data only.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const RUN = `${process.pid}-${randomUUID().slice(0, 8)}`;
const OWNER = `wp7-acct-filter-${RUN}`;
const OTHER = `wp7-acct-filter-other-${RUN}`;
const householdOf = new Map<string, string>();
let actingUser = OWNER;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = actingUser;
    req.actualUserId = actingUser;
    req.householdId = householdOf.get(actingUser);
    req.householdOwnerId = actingUser;
    next();
  },
}));

import { db, transactionsTable } from "@workspace/db";
import { ListTransactionsResponse } from "@workspace/api-zod";
import transactionsRouter from "../routes/transactions";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const { request } = createTestApp(transactionsRouter);

/** External Plaid account ids, as the sync stores them on `transactions.plaid_account_id`. */
const BLUE = `ext-blue-${RUN}`;
const FREEDOM = `ext-freedom-${RUN}`;

type Spec = {
  key: string;
  user: string;
  plaidAccountId: string | null;
  source: string;
  day: string;
  amount: string;
};

const ROWS: Spec[] = [
  // The Amex Blue card's own rows.
  { key: "blue1", user: OWNER, plaidAccountId: BLUE, source: "plaid:amex", day: "2026-09-03", amount: "-41.00" },
  { key: "blue2", user: OWNER, plaidAccountId: BLUE, source: "plaid:amex", day: "2026-09-20", amount: "-12.50" },
  { key: "blueRefund", user: OWNER, plaidAccountId: BLUE, source: "plaid:amex", day: "2026-09-21", amount: "12.50" },
  // Another card at a different bank.
  { key: "freedom1", user: OWNER, plaidAccountId: FREEDOM, source: "plaid:chase", day: "2026-09-10", amount: "-75.00" },
  // Plaid-less rows: never on any one account.
  { key: "manual", user: OWNER, plaidAccountId: null, source: "manual", day: "2026-09-11", amount: "-9.00" },
  { key: "workbook", user: OWNER, plaidAccountId: null, source: "amex", day: "2026-09-12", amount: "33.00" },
  { key: "emptyId", user: OWNER, plaidAccountId: "", source: "manual", day: "2026-09-13", amount: "-4.00" },
  // Look-alikes of BLUE: a longer id that starts with it, and the same id upper-cased.
  { key: "superstring", user: OWNER, plaidAccountId: `${BLUE}-2`, source: "plaid:amex", day: "2026-09-14", amount: "-6.00" },
  { key: "upper", user: OWNER, plaidAccountId: BLUE.toUpperCase(), source: "plaid:amex", day: "2026-09-15", amount: "-7.00" },
  // Another household, on the SAME id string.
  { key: "otherBlue", user: OTHER, plaidAccountId: BLUE, source: "plaid:amex", day: "2026-09-16", amount: "-500.00" },
];

const idOf = new Map<string, string>();
const keyOf = new Map<string, string>();

type ListRow = { id: string; plaidAccountId?: string | null };

async function list(query: string): Promise<{ status: number; keys: string[]; json: unknown }> {
  const { status, json } = await request("GET", `/transactions?${query}`);
  if (status !== 200) return { status, keys: [], json };
  // The body still matches the generated schema.
  ListTransactionsResponse.parse(json);
  const keys = (json as ListRow[]).map((r) => keyOf.get(r.id) ?? `unknown:${r.id}`).sort();
  return { status, keys, json };
}

const keysWhere = (pred: (s: Spec) => boolean) => ROWS.filter(pred).map((s) => s.key).sort();

beforeAll(async () => {
  for (const u of [OWNER, OTHER]) householdOf.set(u, (await createTestHousehold(u)).householdId);
  const inserted = await db
    .insert(transactionsTable)
    .values(
      ROWS.map((s) => ({
        userId: s.user,
        householdId: householdOf.get(s.user)!,
        occurredOn: s.day,
        description: `WP7 ${s.key.toUpperCase()} ${RUN}`,
        amount: s.amount,
        source: s.source,
        plaidAccountId: s.plaidAccountId,
        plaidTransactionId: s.plaidAccountId ? `ptx-${RUN}-${s.key}` : null,
      })),
    )
    .returning({ id: transactionsTable.id, description: transactionsTable.description });
  for (const r of inserted) {
    const key = ROWS.find((s) => r.description === `WP7 ${s.key.toUpperCase()} ${RUN}`)!.key;
    idOf.set(key, r.id);
    keyOf.set(r.id, key);
  }
});

afterAll(async () => {
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, [OWNER, OTHER]));
});

describe("GET /transactions?plaidAccountId — one Plaid account's rows", () => {
  it("without the filter the household's rows are all listed (the filter is what narrows)", async () => {
    const r = await list("from=2026-09-01&to=2026-09-30&limit=100");
    expect(r.status).toBe(200);
    expect(r.keys).toEqual(keysWhere((s) => s.user === OWNER));
  });

  it("lists exactly the account's rows: the charges and the refund, and nothing else of the household", async () => {
    const r = await list(`from=2026-09-01&to=2026-09-30&limit=100&plaidAccountId=${encodeURIComponent(BLUE)}`);
    expect(r.status).toBe(200);
    expect(r.keys).toEqual(["blue1", "blue2", "blueRefund"]);
    for (const row of r.json as ListRow[]) expect(row.plaidAccountId).toBe(BLUE);
    // Absence, row by row: the other card, every Plaid-less row, the look-alikes
    // and the other household's row on the same id.
    for (const key of ["freedom1", "manual", "workbook", "emptyId", "superstring", "upper", "otherBlue"]) {
      expect(r.keys, key).not.toContain(key);
    }
  });

  it("another card's id lists only that card's row", async () => {
    const r = await list(`from=2026-09-01&to=2026-09-30&limit=100&plaidAccountId=${encodeURIComponent(FREEDOM)}`);
    expect(r.keys).toEqual(["freedom1"]);
  });

  it("is an exact match: neither a longer id that starts with it nor the same id upper-cased reaches the account", async () => {
    expect((await list(`limit=100&plaidAccountId=${encodeURIComponent(`${BLUE}-2`)}`)).keys).toEqual(["superstring"]);
    expect((await list(`limit=100&plaidAccountId=${encodeURIComponent(BLUE.toUpperCase())}`)).keys).toEqual(["upper"]);
    // A prefix of a real id matches nothing (no LIKE).
    expect((await list(`limit=100&plaidAccountId=${encodeURIComponent(BLUE.slice(0, -2))}`)).keys).toEqual([]);
  });

  it("Plaid-less rows never match: an empty value lists nothing (never every row), and so does an unknown id", async () => {
    const empty = await list("from=2026-09-01&to=2026-09-30&limit=100&plaidAccountId=");
    expect(empty.status).toBe(200);
    expect(empty.keys).toEqual([]);
    const unknown = await list(`limit=100&plaidAccountId=ext-nobody-${RUN}`);
    expect(unknown.status).toBe(200);
    expect(unknown.keys).toEqual([]);
  });

  it("composes with the other filters (AND): range, source, amount and limit narrow the account's rows further", async () => {
    const blue = `plaidAccountId=${encodeURIComponent(BLUE)}`;
    expect((await list(`from=2026-09-15&to=2026-09-30&limit=100&${blue}`)).keys).toEqual(["blue2", "blueRefund"]);
    // The workbook source with a card's id: the workbook rows have no Plaid account.
    expect((await list(`limit=100&source=amex&${blue}`)).keys).toEqual([]);
    expect((await list(`limit=100&source=plaid:amex&${blue}`)).keys).toEqual(["blue1", "blue2", "blueRefund"]);
    expect((await list(`limit=100&minAmount=40&${blue}`)).keys).toEqual(["blue1"]);
    // Newest first, cut at the limit.
    const capped = await request("GET", `/transactions?limit=1&${blue}`);
    expect((capped.json as ListRow[]).map((r) => keyOf.get(r.id))).toEqual(["blueRefund"]);
  });

  it("never crosses households: the other household on the same id string sees only its own row, and the owner never sees it", async () => {
    actingUser = OTHER;
    try {
      const r = await list(`limit=100&plaidAccountId=${encodeURIComponent(BLUE)}`);
      expect(r.keys).toEqual(["otherBlue"]);
      expect(r.keys).not.toContain("blue1");
    } finally {
      actingUser = OWNER;
    }
    const mine = await list(`limit=100&plaidAccountId=${encodeURIComponent(BLUE)}`);
    expect(mine.keys).not.toContain("otherBlue");
  });

  it("a NUL byte or an id over 128 characters is a 400 and reads nothing", async () => {
    const nul = await request("GET", `/transactions?plaidAccountId=${encodeURIComponent(`${BLUE}\u0000`)}`);
    expect(nul.status).toBe(400);
    expect(JSON.stringify(nul.json)).toContain("plaidAccountId");
    const long = await request("GET", `/transactions?plaidAccountId=${"x".repeat(129)}`);
    expect(long.status).toBe(400);
    // 128 is allowed (and matches nothing here).
    const max = await request("GET", `/transactions?plaidAccountId=${"x".repeat(128)}`);
    expect(max.status).toBe(200);
    expect(max.json).toEqual([]);
  });

  it("the stored rows are untouched by the reads", async () => {
    const rows = await db
      .select({ id: transactionsTable.id, plaidAccountId: transactionsTable.plaidAccountId, amount: transactionsTable.amount })
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, OWNER));
    expect(rows).toHaveLength(ROWS.filter((s) => s.user === OWNER).length);
    for (const r of rows) {
      const s = ROWS.find((x) => x.key === keyOf.get(r.id))!;
      expect(r.plaidAccountId).toBe(s.plaidAccountId);
      expect(Number(r.amount)).toBe(Number(s.amount));
    }
  });
});
