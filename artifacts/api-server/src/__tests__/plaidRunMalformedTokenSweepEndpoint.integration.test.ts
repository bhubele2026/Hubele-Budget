import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";

// (#397) Owner-gated POST /plaid/run-malformed-token-sweep manually fires
// the same daily bank-login health check that runs at 03:02 UTC, plus the
// spike-alert evaluation, and returns the same { scanned, flagged,
// flaggedItems } summary the cron logs (with the alert outcome inlined).

const OWNER_USER = `owner-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const NON_OWNER_USER = `member-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

let currentUserId = OWNER_USER;
process.env.OWNER_EMAIL = "owner@example.com";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = currentUserId;
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: async (userId: string) => {
        if (userId === OWNER_USER) {
          return {
            id: OWNER_USER,
            primaryEmailAddressId: "e1",
            emailAddresses: [{ id: "e1", emailAddress: "owner@example.com" }],
          };
        }
        return {
          id: userId,
          primaryEmailAddressId: "e2",
          emailAddresses: [{ id: "e2", emailAddress: "member@example.com" }],
        };
      },
    },
  },
}));

const { flagMalformedAccessTokensSpy, maybeAlertOnMalformedTokenSpikeSpy } =
  vi.hoisted(() => ({
    flagMalformedAccessTokensSpy: vi.fn(async () => ({
      scanned: 5,
      flagged: 2,
      flaggedItems: [
        { itemRowId: "row-1", itemId: "ext-1", institutionName: "Chase" },
        { itemRowId: "row-2", itemId: "ext-2", institutionName: "Wells Fargo" },
      ],
    })),
    maybeAlertOnMalformedTokenSpikeSpy: vi.fn(async () => ({
      channel: "skipped" as const,
      reason: "below-threshold" as string | null,
      recipient: null as string | null,
      error: null as string | null,
    })),
  }));

vi.mock("../lib/plaidSync", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaidSync")>(
    "../lib/plaidSync",
  );
  return {
    ...actual,
    flagMalformedAccessTokens: flagMalformedAccessTokensSpy,
  };
});

vi.mock("../lib/plaidMalformedTokenAlert", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/plaidMalformedTokenAlert")
  >("../lib/plaidMalformedTokenAlert");
  return {
    ...actual,
    maybeAlertOnMalformedTokenSpike: maybeAlertOnMalformedTokenSpikeSpy,
  };
});

import { db, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import plaidRouter from "../routes/plaid";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  next();
});
app.use(plaidRouter);

let server: Server;
let baseUrl: string;

async function cleanup() {
  for (const u of [OWNER_USER, NON_OWNER_USER]) {
    await db.delete(profilesTable).where(eq(profilesTable.id, u));
  }
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
  flagMalformedAccessTokensSpy.mockClear();
  maybeAlertOnMalformedTokenSpikeSpy.mockClear();
  currentUserId = OWNER_USER;
});

describe("(#397) POST /plaid/run-malformed-token-sweep", () => {
  it("rejects non-owner callers with 403 and does not run the sweep", async () => {
    currentUserId = NON_OWNER_USER;
    const res = await fetch(`${baseUrl}/plaid/run-malformed-token-sweep`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(flagMalformedAccessTokensSpy).not.toHaveBeenCalled();
    expect(maybeAlertOnMalformedTokenSpikeSpy).not.toHaveBeenCalled();
  });

  it("owner gets the same { scanned, flagged, flaggedItems } summary the cron logs and a re-evaluated alert", async () => {
    currentUserId = OWNER_USER;
    const res = await fetch(`${baseUrl}/plaid/run-malformed-token-sweep`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scanned: number;
      flagged: number;
      flaggedItems: Array<{ itemRowId: string; itemId: string; institutionName: string | null }>;
      alert: { channel: string; reason: string | null; recipient: string | null; error: string | null } | null;
    };
    expect(body.scanned).toBe(5);
    expect(body.flagged).toBe(2);
    expect(body.flaggedItems).toEqual([
      { itemRowId: "row-1", itemId: "ext-1", institutionName: "Chase" },
      { itemRowId: "row-2", itemId: "ext-2", institutionName: "Wells Fargo" },
    ]);
    expect(flagMalformedAccessTokensSpy).toHaveBeenCalledTimes(1);
    expect(maybeAlertOnMalformedTokenSpikeSpy).toHaveBeenCalledTimes(1);
    // The spike-alert re-evaluation receives exactly the sweep summary so
    // the operator sees a confirmation alert (or a below-threshold skip).
    expect(maybeAlertOnMalformedTokenSpikeSpy).toHaveBeenCalledWith({
      scanned: 5,
      flagged: 2,
      flaggedItems: [
        { itemRowId: "row-1", itemId: "ext-1", institutionName: "Chase" },
        { itemRowId: "row-2", itemId: "ext-2", institutionName: "Wells Fargo" },
      ],
    });
    expect(body.alert).toEqual({
      channel: "skipped",
      reason: "below-threshold",
      recipient: null,
      error: null,
    });
  });

  it("an alert dispatch failure does not fail the request — sweep result is still returned", async () => {
    currentUserId = OWNER_USER;
    maybeAlertOnMalformedTokenSpikeSpy.mockImplementationOnce(async () => {
      throw new Error("transport boom");
    });
    const res = await fetch(`${baseUrl}/plaid/run-malformed-token-sweep`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scanned: number;
      flagged: number;
      alert: unknown;
    };
    expect(body.scanned).toBe(5);
    expect(body.flagged).toBe(2);
    // Alert evaluator threw — we surface alert: null but don't 500.
    expect(body.alert).toBeNull();
  });
});
