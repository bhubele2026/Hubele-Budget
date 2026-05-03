import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";

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

const createInvitationCalls: Array<Record<string, unknown>> = [];
const revokeInvitationCalls: string[] = [];
let listInvitationsResult: Array<Record<string, unknown>> = [];
let listUsersResult: Array<Record<string, unknown>> = [];

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: async (userId: string) => {
        if (userId === OWNER_USER) {
          return {
            id: OWNER_USER,
            primaryEmailAddressId: "e1",
            emailAddresses: [{ id: "e1", emailAddress: "owner@example.com" }],
            firstName: "Owner",
            lastName: "User",
            username: "owner",
          };
        }
        return {
          id: userId,
          primaryEmailAddressId: "e2",
          emailAddresses: [{ id: "e2", emailAddress: "member@example.com" }],
          firstName: "Mem",
          lastName: "Ber",
          username: "memb",
        };
      },
      getUserList: async () => ({ data: listUsersResult }),
    },
    invitations: {
      getInvitationList: async () => ({ data: listInvitationsResult }),
      createInvitation: async (params: Record<string, unknown>) => {
        createInvitationCalls.push(params);
        return {
          id: `inv-${randomUUID()}`,
          emailAddress: params.emailAddress,
          status: "pending",
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          url: "https://accounts.example.com/invite",
          revoked: false,
        };
      },
      revokeInvitation: async (id: string) => {
        revokeInvitationCalls.push(id);
        return {
          id,
          emailAddress: "revoked@example.com",
          status: "revoked",
          createdAt: 1700000000000,
          updatedAt: 1700000000001,
          revoked: true,
        };
      },
    },
  },
}));

import { db, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import meRouter from "../routes/me";
import invitationsRouter from "../routes/invitations";
import membersRouter from "../routes/members";

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
app.use(meRouter);
app.use(invitationsRouter);
app.use(membersRouter);

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
  createInvitationCalls.length = 0;
  revokeInvitationCalls.length = 0;
  listInvitationsResult = [];
  listUsersResult = [];
  currentUserId = OWNER_USER;
});

describe("GET /me", () => {
  it("returns isOwner:true for the owner email", async () => {
    currentUserId = OWNER_USER;
    const res = await fetch(`${baseUrl}/me`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isOwner: boolean; email: string };
    expect(body.isOwner).toBe(true);
    expect(body.email).toBe("owner@example.com");
  });

  it("returns isOwner:false for non-owner emails", async () => {
    currentUserId = NON_OWNER_USER;
    const res = await fetch(`${baseUrl}/me`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isOwner: boolean; email: string };
    expect(body.isOwner).toBe(false);
    expect(body.email).toBe("member@example.com");
  });
});

describe("Owner-only invitation endpoints", () => {
  it("rejects non-owner POST /invitations with 403", async () => {
    currentUserId = NON_OWNER_USER;
    const res = await fetch(`${baseUrl}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "newby@example.com" }),
    });
    expect(res.status).toBe(403);
    expect(createInvitationCalls).toEqual([]);
  });

  it("rejects non-owner GET /invitations with 403", async () => {
    currentUserId = NON_OWNER_USER;
    const res = await fetch(`${baseUrl}/invitations`);
    expect(res.status).toBe(403);
  });

  it("rejects non-owner DELETE /invitations/:id with 403", async () => {
    currentUserId = NON_OWNER_USER;
    const res = await fetch(`${baseUrl}/invitations/inv-abc`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect(revokeInvitationCalls).toEqual([]);
  });

  it("rejects non-owner GET /members with 403", async () => {
    currentUserId = NON_OWNER_USER;
    const res = await fetch(`${baseUrl}/members`);
    expect(res.status).toBe(403);
  });

  it("owner can create an invitation and Clerk SDK is called with the email + redirectUrl", async () => {
    currentUserId = OWNER_USER;
    const res = await fetch(`${baseUrl}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "newby@example.com" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      emailAddress: string;
      status: string;
    };
    expect(body.emailAddress).toBe("newby@example.com");
    expect(body.status).toBe("pending");
    expect(createInvitationCalls).toHaveLength(1);
    expect(createInvitationCalls[0]).toMatchObject({
      emailAddress: "newby@example.com",
      notify: true,
    });
    expect(typeof createInvitationCalls[0].redirectUrl).toBe("string");
    expect(String(createInvitationCalls[0].redirectUrl)).toMatch(/sign-up$/);
  });

  it("rejects invalid email payloads with 400", async () => {
    currentUserId = OWNER_USER;
    const res = await fetch(`${baseUrl}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect(createInvitationCalls).toEqual([]);
  });

  it("owner can list invitations", async () => {
    currentUserId = OWNER_USER;
    listInvitationsResult = [
      {
        id: "inv-1",
        emailAddress: "a@example.com",
        status: "pending",
        createdAt: 1,
        updatedAt: 2,
        url: "https://x",
      },
      {
        id: "inv-2",
        emailAddress: "b@example.com",
        status: "accepted",
        createdAt: 3,
        updatedAt: 4,
      },
    ];
    const res = await fetch(`${baseUrl}/invitations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; status: string }>;
    expect(body.map((i) => i.id)).toEqual(["inv-1", "inv-2"]);
    expect(body[0].status).toBe("pending");
  });

  it("owner can revoke a pending invitation", async () => {
    currentUserId = OWNER_USER;
    const res = await fetch(`${baseUrl}/invitations/inv-zzz`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(revokeInvitationCalls).toEqual(["inv-zzz"]);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("revoked");
  });

  it("owner sees themselves as Owner in /members", async () => {
    currentUserId = OWNER_USER;
    listUsersResult = [
      {
        id: OWNER_USER,
        primaryEmailAddressId: "e1",
        emailAddresses: [{ id: "e1", emailAddress: "owner@example.com" }],
        firstName: "O",
        lastName: "ne",
        username: "o",
        imageUrl: "",
        createdAt: 1,
        lastSignInAt: 2,
      },
      {
        id: NON_OWNER_USER,
        primaryEmailAddressId: "e2",
        emailAddresses: [{ id: "e2", emailAddress: "member@example.com" }],
        firstName: "M",
        lastName: "em",
        username: "m",
        imageUrl: "",
        createdAt: 3,
        lastSignInAt: null,
      },
    ];
    const res = await fetch(`${baseUrl}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      email: string;
      isOwner: boolean;
    }>;
    const owner = body.find((m) => m.id === OWNER_USER)!;
    const other = body.find((m) => m.id === NON_OWNER_USER)!;
    expect(owner.isOwner).toBe(true);
    expect(other.isOwner).toBe(false);
  });
});
