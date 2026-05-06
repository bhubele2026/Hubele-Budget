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

const TEST_USER = `dismiss-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `dismiss-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

// (#274) The dismiss endpoint never reaches Plaid; stub the SDK so we
// don't accidentally hit the network if a future change adds a
// /item/get refresh on this path.
vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      itemGet: async () => ({
        data: { item: { item_id: "x", consent_expiration_time: null } },
      }),
    }),
  };
});

import { db, plaidItemsTable } from "@workspace/db";
import plaidRouter from "../routes/plaid";

type DismissResponse = {
  id: string;
  consentExpirationAt: string | null;
  consentWarningDismissedForCutoff: string | null;
};

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
});

async function seedItem(opts?: {
  userId?: string;
  consentExpirationAt?: Date | null;
}): Promise<{ id: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: opts?.userId ?? TEST_USER,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
      consentExpirationAt: opts?.consentExpirationAt ?? null,
    })
    .returning();
  return { id: item!.id };
}

describe("(#274) POST /plaid/items/:id/dismiss-expiration-warning", () => {
  it("stamps consent_warning_dismissed_for_cutoff with the live cutoff", async () => {
    const cutoff = new Date("2026-05-11T12:00:00.000Z");
    const { id } = await seedItem({ consentExpirationAt: cutoff });

    const r = await fetch(
      `${baseUrl}/plaid/items/${id}/dismiss-expiration-warning`,
      { method: "POST" },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as DismissResponse;
    expect(body.id).toBe(id);
    expect(body.consentWarningDismissedForCutoff).toBe(cutoff.toISOString());

    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, id));
    expect(row.consentWarningDismissedForCutoff?.toISOString()).toBe(
      cutoff.toISOString(),
    );
  });

  it("is idempotent — re-dismissing the same cutoff is a no-op", async () => {
    const cutoff = new Date("2026-05-11T12:00:00.000Z");
    const { id } = await seedItem({ consentExpirationAt: cutoff });

    await fetch(`${baseUrl}/plaid/items/${id}/dismiss-expiration-warning`, {
      method: "POST",
    });
    const r2 = await fetch(
      `${baseUrl}/plaid/items/${id}/dismiss-expiration-warning`,
      { method: "POST" },
    );
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as DismissResponse;
    expect(body.consentWarningDismissedForCutoff).toBe(cutoff.toISOString());
  });

  it("is a no-op (200) for items with no consent cutoff", async () => {
    const { id } = await seedItem({ consentExpirationAt: null });
    const r = await fetch(
      `${baseUrl}/plaid/items/${id}/dismiss-expiration-warning`,
      { method: "POST" },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as DismissResponse;
    expect(body.consentWarningDismissedForCutoff).toBeNull();
    expect(body.consentExpirationAt).toBeNull();
  });

  it("returns 404 when the item does not exist", async () => {
    const r = await fetch(
      `${baseUrl}/plaid/items/${randomUUID()}/dismiss-expiration-warning`,
      { method: "POST" },
    );
    expect(r.status).toBe(404);
  });

  it("does not let a user dismiss another user's item", async () => {
    // Authenticated user is TEST_USER (per the requireAuth mock above);
    // this row belongs to OTHER_USER, so the row lookup should miss
    // and return 404 instead of writing across users.
    const cutoff = new Date("2026-05-11T12:00:00.000Z");
    const { id } = await seedItem({
      userId: OTHER_USER,
      consentExpirationAt: cutoff,
    });
    const r = await fetch(
      `${baseUrl}/plaid/items/${id}/dismiss-expiration-warning`,
      { method: "POST" },
    );
    expect(r.status).toBe(404);

    const [row] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, id));
    expect(row.consentWarningDismissedForCutoff).toBeNull();
  });

  it("GET /plaid/items surfaces consentWarningDismissedForCutoff", async () => {
    const cutoff = new Date("2026-05-11T12:00:00.000Z");
    const { id } = await seedItem({ consentExpirationAt: cutoff });
    await fetch(`${baseUrl}/plaid/items/${id}/dismiss-expiration-warning`, {
      method: "POST",
    });

    const r = await fetch(`${baseUrl}/plaid/items`);
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{
      id: string;
      consentWarningDismissedForCutoff: string | null;
    }>;
    const row = list.find((x) => x.id === id);
    expect(row).toBeDefined();
    expect(row!.consentWarningDismissedForCutoff).toBe(cutoff.toISOString());
  });
});
