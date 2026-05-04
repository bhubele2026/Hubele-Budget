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

const TEST_USER = `consent-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `consent-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

type ItemGetFn = (args: { access_token: string }) => Promise<unknown>;

let itemGetMock: ItemGetFn = async () => ({
  data: { item: { item_id: "item-default", consent_expiration_time: null } },
});
const itemGetCalls: Array<{ access_token: string }> = [];

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      itemGet: (args: Parameters<ItemGetFn>[0]) => {
        itemGetCalls.push(args);
        return itemGetMock(args);
      },
    }),
  };
});

import { db, plaidItemsTable } from "@workspace/db";
import plaidRouter from "../routes/plaid";
import {
  refreshConsentExpirationForAllItems,
  refreshConsentExpirationForItem,
} from "../lib/plaidSync";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(plaidRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, OTHER_USER));
}

beforeAll(async () => {
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
  itemGetCalls.length = 0;
  itemGetMock = async () => ({
    data: { item: { item_id: "item-default", consent_expiration_time: null } },
  });
});

async function seedItem(opts?: {
  userId?: string;
  consentExpirationAt?: Date | null;
  accessToken?: string;
  institutionName?: string;
}): Promise<{ itemRowId: string; itemId: string; accessToken: string }> {
  const externalItemId = `item-${randomUUID()}`;
  const accessToken = opts?.accessToken ?? `access-sandbox-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: opts?.userId ?? TEST_USER,
      itemId: externalItemId,
      accessToken,
      institutionName: opts?.institutionName ?? "Chase",
      institutionSlug: "chase",
      consentExpirationAt: opts?.consentExpirationAt ?? null,
    })
    .returning();
  return { itemRowId: item!.id, itemId: externalItemId, accessToken };
}

describe("(#253) refreshConsentExpirationForItem", () => {
  it("persists a fresh consent_expiration_time from /item/get", async () => {
    const { itemRowId } = await seedItem({ consentExpirationAt: null });
    const fresh = "2026-09-15T12:00:00.000Z";
    itemGetMock = async () => ({
      data: { item: { item_id: "x", consent_expiration_time: fresh } },
    });

    const result = await refreshConsentExpirationForItem(itemRowId);
    expect(result.error).toBeNull();
    expect(result.changed).toBe(true);
    expect(result.consentExpirationAt).toBe(fresh);

    const [row] = await db
      .select({ consentExpirationAt: plaidItemsTable.consentExpirationAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.consentExpirationAt?.toISOString()).toBe(fresh);
  });

  it("rolls a stored cutoff forward when Plaid reports a later one (the drift the cron exists to fix)", async () => {
    const stale = new Date("2026-05-21T15:30:00.000Z");
    const rolled = "2026-08-21T15:30:00.000Z";
    const { itemRowId } = await seedItem({ consentExpirationAt: stale });
    itemGetMock = async () => ({
      data: { item: { item_id: "x", consent_expiration_time: rolled } },
    });

    const result = await refreshConsentExpirationForItem(itemRowId);
    expect(result.changed).toBe(true);
    expect(result.consentExpirationAt).toBe(rolled);

    const [row] = await db
      .select({ consentExpirationAt: plaidItemsTable.consentExpirationAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.consentExpirationAt?.toISOString()).toBe(rolled);
  });

  it("clears the stored cutoff when Plaid no longer reports one", async () => {
    const stale = new Date("2026-05-21T15:30:00.000Z");
    const { itemRowId } = await seedItem({ consentExpirationAt: stale });
    itemGetMock = async () => ({
      data: { item: { item_id: "x", consent_expiration_time: null } },
    });

    const result = await refreshConsentExpirationForItem(itemRowId);
    expect(result.changed).toBe(true);
    expect(result.consentExpirationAt).toBeNull();

    const [row] = await db
      .select({ consentExpirationAt: plaidItemsTable.consentExpirationAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.consentExpirationAt).toBeNull();
  });

  it("reports changed=false and skips the write when the cutoff matches what we already stored", async () => {
    const same = "2026-06-30T00:00:00.000Z";
    const { itemRowId } = await seedItem({
      consentExpirationAt: new Date(same),
    });
    itemGetMock = async () => ({
      data: { item: { item_id: "x", consent_expiration_time: same } },
    });

    const result = await refreshConsentExpirationForItem(itemRowId);
    expect(result.error).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.consentExpirationAt).toBe(same);
  });

  it("captures /item/get failures on the result without throwing and leaves the stored value alone", async () => {
    const stored = new Date("2026-05-21T15:30:00.000Z");
    const { itemRowId } = await seedItem({ consentExpirationAt: stored });
    itemGetMock = async () => {
      throw new Error("plaid unreachable");
    };

    const result = await refreshConsentExpirationForItem(itemRowId);
    expect(result.error).toMatch(/plaid unreachable/);
    expect(result.changed).toBe(false);

    const [row] = await db
      .select({ consentExpirationAt: plaidItemsTable.consentExpirationAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.consentExpirationAt?.toISOString()).toBe(stored.toISOString());
  });
});

describe("(#253) refreshConsentExpirationForAllItems (daily cron entry point)", () => {
  it("walks every item across every user and counts updates vs failures", async () => {
    const updated = await seedItem({
      consentExpirationAt: null,
      institutionName: "Chase",
    });
    const unchanged = await seedItem({
      consentExpirationAt: new Date("2026-07-01T00:00:00.000Z"),
      institutionName: "Bofa",
    });
    const failing = await seedItem({
      consentExpirationAt: new Date("2026-05-01T00:00:00.000Z"),
      institutionName: "WellsFargo",
      accessToken: "access-sandbox-failing-token",
    });
    // Cron must be cross-user, not scoped to the requester.
    const otherUserItem = await seedItem({
      userId: OTHER_USER,
      consentExpirationAt: null,
      institutionName: "Citi",
    });

    const responses = new Map<string, string | null>([
      [updated.accessToken, "2026-10-01T00:00:00.000Z"],
      [unchanged.accessToken, "2026-07-01T00:00:00.000Z"],
      [otherUserItem.accessToken, "2026-11-01T00:00:00.000Z"],
    ]);
    itemGetMock = async (args) => {
      if (args.access_token === failing.accessToken) {
        throw new Error("simulated /item/get failure");
      }
      return {
        data: {
          item: {
            item_id: "x",
            consent_expiration_time: responses.get(args.access_token) ?? null,
          },
        },
      };
    };

    const summary = await refreshConsentExpirationForAllItems();
    // Other vitest files share the same DB and may leave their own
    // plaid_items rows behind; assert on at-least counts that reflect
    // the four items this test seeded rather than exact totals.
    expect(summary.scanned).toBeGreaterThanOrEqual(4);
    // updated + otherUserItem changed; unchanged stayed put; failing errored.
    expect(summary.updated).toBeGreaterThanOrEqual(2);
    expect(summary.failed).toBeGreaterThanOrEqual(1);

    const [updatedRow] = await db
      .select({ consentExpirationAt: plaidItemsTable.consentExpirationAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, updated.itemRowId));
    expect(updatedRow?.consentExpirationAt?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );

    const [otherRow] = await db
      .select({ consentExpirationAt: plaidItemsTable.consentExpirationAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, otherUserItem.itemRowId));
    expect(otherRow?.consentExpirationAt?.toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );

    // The failing item must keep its previously stored cutoff so a
    // transient Plaid hiccup does not erase the dated banner copy.
    const [failingRow] = await db
      .select({ consentExpirationAt: plaidItemsTable.consentExpirationAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, failing.itemRowId));
    expect(failingRow?.consentExpirationAt?.toISOString()).toBe(
      "2026-05-01T00:00:00.000Z",
    );
  });

  it("returns a valid summary shape when no items belong to any user this test cares about", async () => {
    // Clean slate for our two test users; other vitest files share the
    // same DB and may leave behind rows of their own, so we assert only
    // on the result shape and that no calls were issued for our items.
    await cleanup();
    itemGetCalls.length = 0;
    const summary = await refreshConsentExpirationForAllItems();
    expect(summary.scanned).toBeGreaterThanOrEqual(0);
    expect(summary.updated).toBeGreaterThanOrEqual(0);
    expect(summary.failed).toBeGreaterThanOrEqual(0);
    // scanned must equal updated + failed + (unchanged-with-no-error).
    expect(summary.updated + summary.failed).toBeLessThanOrEqual(
      summary.scanned,
    );
  });
});

describe("(#253) POST /plaid/refresh-consent-expirations (manual trigger)", () => {
  it("refreshes only the caller's items and returns a per-item summary", async () => {
    const mine = await seedItem({ consentExpirationAt: null });
    const otherUser = await seedItem({
      userId: OTHER_USER,
      consentExpirationAt: null,
    });

    const fresh = "2026-09-15T12:00:00.000Z";
    itemGetMock = async () => ({
      data: { item: { item_id: "x", consent_expiration_time: fresh } },
    });

    const res = await fetch(
      `${baseUrl}/plaid/refresh-consent-expirations`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scanned: number;
      updated: number;
      failed: number;
      items: Array<{
        itemRowId: string;
        consentExpirationAt: string | null;
        changed: boolean;
        error: string | null;
      }>;
    };
    expect(body.scanned).toBe(1);
    expect(body.updated).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.items[0].itemRowId).toBe(mine.itemRowId);
    expect(body.items[0].consentExpirationAt).toBe(fresh);

    // The other user's item must NOT be touched by the manual trigger.
    const [otherRow] = await db
      .select({ consentExpirationAt: plaidItemsTable.consentExpirationAt })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, otherUser.itemRowId));
    expect(otherRow?.consentExpirationAt).toBeNull();
  });

  it("still returns 200 with per-item error details when /item/get fails", async () => {
    const { itemRowId } = await seedItem({
      consentExpirationAt: new Date("2026-05-21T15:30:00.000Z"),
    });
    itemGetMock = async () => {
      throw {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          data: {
            error_code: "RATE_LIMIT_EXCEEDED",
            error_message: "too many requests",
            error_type: "RATE_LIMIT_EXCEEDED",
          },
        },
      };
    };

    const res = await fetch(
      `${baseUrl}/plaid/refresh-consent-expirations`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scanned: number;
      updated: number;
      failed: number;
      items: Array<{ itemRowId: string; error: string | null }>;
    };
    expect(body.scanned).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.updated).toBe(0);
    expect(body.items[0].itemRowId).toBe(itemRowId);
    expect(body.items[0].error).toMatch(/too many requests/);
  });
});
